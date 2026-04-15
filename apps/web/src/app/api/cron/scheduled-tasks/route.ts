import { NextResponse } from "next/server";
import {
  claimScheduledTask,
  createSession,
  createScheduledTaskRun,
  createServerClient,
  getTelegramAccountByUserId,
  listDueScheduledTasks,
  markScheduledTaskFailed,
  markScheduledTaskRunFailed,
  markScheduledTaskRunSucceeded,
  markScheduledTaskSucceeded,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import type { ScheduledTask } from "@agents/types";
import { loadAgentRuntimeContext } from "@/lib/agent-runtime";
import { buildScheduledExecutionMessage } from "@/lib/message-preprocessing";
import { closeSessionWithMemoryFlush } from "@/lib/session-memory";
import { sendTelegramMessage } from "@/lib/telegram-bot";

const CRON_SECRET = process.env.SCHEDULED_TASKS_CRON_SECRET ?? "";
const DEFAULT_BATCH_SIZE = 20;

function isAuthorized(request: Request): boolean {
  if (!CRON_SECRET) return true;
  const authHeader = request.headers.get("authorization");
  const headerSecret = request.headers.get("x-cron-secret");

  return authHeader === `Bearer ${CRON_SECRET}` || headerSecret === CRON_SECRET;
}

function computeFollowingRun(task: ScheduledTask): string | null {
  if (task.schedule_type === "one_time") return null;

  const baseDate = new Date(task.next_run_at ?? task.run_at);
  if (Number.isNaN(baseDate.getTime())) return null;

  if (task.recurrence === "daily") {
    baseDate.setUTCDate(baseDate.getUTCDate() + 1);
    return baseDate.toISOString();
  }

  if (task.recurrence === "weekly") {
    baseDate.setUTCDate(baseDate.getUTCDate() + 7);
    return baseDate.toISOString();
  }

  if (task.recurrence === "monthly") {
    baseDate.setUTCMonth(baseDate.getUTCMonth() + 1);
    return baseDate.toISOString();
  }

  return null;
}

async function dispatchScheduledTask(
  task: ScheduledTask
): Promise<{ id: string; status: "processed" | "skipped" | "failed"; detail: string }> {
  const db = createServerClient();
  const claimedTask = await claimScheduledTask(db, task.id);
  if (!claimedTask) {
    return {
      id: task.id,
      status: "skipped",
      detail: "Task was already claimed by another dispatcher run.",
    };
  }

  const run = await createScheduledTaskRun(db, claimedTask.id, claimedTask.user_id, "cron");
  const telegramAccount = await getTelegramAccountByUserId(db, claimedTask.user_id);
  let agentSessionId: string | null = null;

  try {
    if (!telegramAccount) {
      throw new Error("No hay una cuenta de Telegram vinculada para notificar esta tarea programada.");
    }

    const runtime = await loadAgentRuntimeContext(db, claimedTask.user_id);
    const session = await createSession(db, claimedTask.user_id, "scheduled");
    agentSessionId = session.id;

    const result = await runAgent({
      message: buildScheduledExecutionMessage(claimedTask.prompt),
      userId: claimedTask.user_id,
      sessionId: session.id,
      systemPrompt: runtime.systemPrompt,
      db,
      enabledTools: runtime.enabledTools,
      integrations: runtime.integrations,
      integrationSecrets: runtime.integrationSecrets,
    });

    const responseText =
      result.pendingConfirmation?.message ??
      result.response ??
      "La tarea programada se ejecutó, pero no devolvió una respuesta visible.";

    const replyMarkup = result.pendingConfirmation
      ? {
          inline_keyboard: [[
            {
              text: "Aprobar",
              callback_data: `approve:${result.pendingConfirmation.toolCallId}`,
            },
            {
              text: "Cancelar",
              callback_data: `reject:${result.pendingConfirmation.toolCallId}`,
            },
          ]],
        }
      : undefined;

    await sendTelegramMessage(telegramAccount.chat_id, responseText, replyMarkup);
    await closeSessionWithMemoryFlush(db, session.id);

    const nextRunAt = computeFollowingRun(claimedTask);
    await markScheduledTaskRunSucceeded(db, run.id, {
      agentSessionId,
      responseExcerpt: responseText.slice(0, 500),
    });
    await markScheduledTaskSucceeded(db, claimedTask.id, {
      nextRunAt,
      responseExcerpt: responseText.slice(0, 500),
    });

    return {
      id: task.id,
      status: "processed",
      detail: nextRunAt
        ? `Processed successfully. Next run at ${nextRunAt}.`
        : "Processed successfully and marked as completed.",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown scheduled task execution error";
    console.error("Scheduled task dispatch failed:", {
      taskId: claimedTask.id,
      runId: run.id,
      message,
      error,
    });

    if (agentSessionId) {
      await closeSessionWithMemoryFlush(db, agentSessionId);
    }

    await markScheduledTaskRunFailed(db, run.id, {
      agentSessionId,
      errorMessage: message,
    });
    await markScheduledTaskFailed(db, claimedTask.id, message);

    if (telegramAccount) {
      await sendTelegramMessage(
        telegramAccount.chat_id,
        `No se pudo ejecutar la tarea programada: ${message}`
      );
    }

    return {
      id: task.id,
      status: "failed",
      detail: message,
    };
  }
}

async function handleDispatch(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const dueTasks = await listDueScheduledTasks(db, DEFAULT_BATCH_SIZE);

  if (dueTasks.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, results: [] });
  }

  const results = [];
  for (const task of dueTasks) {
    results.push(await dispatchScheduledTask(task));
  }

  return NextResponse.json({
    ok: true,
    processed: results.filter((r) => r.status === "processed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}

export async function POST(request: Request) {
  return handleDispatch(request);
}

export async function GET(request: Request) {
  return handleDispatch(request);
}
