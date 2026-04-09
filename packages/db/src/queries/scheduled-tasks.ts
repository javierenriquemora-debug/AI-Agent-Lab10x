import type {
  ScheduledTask,
  ScheduledTaskChannel,
  ScheduledTaskRecurrence,
  ScheduledTaskRun,
  ScheduledTaskScheduleType,
} from "@agents/types";
import type { DbClient } from "../client";

interface CreateScheduledTaskInput {
  userId: string;
  prompt: string;
  scheduleType: ScheduledTaskScheduleType;
  recurrence: ScheduledTaskRecurrence | null;
  runAt: string;
  nextRunAt: string;
  timezone: string;
  channel: ScheduledTaskChannel;
  createdViaSessionId?: string | null;
}

export async function createScheduledTask(
  db: DbClient,
  input: CreateScheduledTaskInput
) {
  const { data, error } = await db
    .from("scheduled_tasks")
    .insert({
      user_id: input.userId,
      prompt: input.prompt,
      schedule_type: input.scheduleType,
      recurrence: input.recurrence,
      run_at: input.runAt,
      next_run_at: input.nextRunAt,
      timezone: input.timezone,
      channel: input.channel,
      status: "active",
      created_via_session_id: input.createdViaSessionId ?? null,
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as ScheduledTask;
}

export async function listDueScheduledTasks(
  db: DbClient,
  limit = 20
) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", now)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as ScheduledTask[];
}

export async function claimScheduledTask(
  db: DbClient,
  scheduledTaskId: string
) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("scheduled_tasks")
    .update({
      status: "processing",
      updated_at: now,
      last_error: null,
    })
    .eq("id", scheduledTaskId)
    .eq("status", "active")
    .lte("next_run_at", now)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data as ScheduledTask | null;
}

export async function createScheduledTaskRun(
  db: DbClient,
  scheduledTaskId: string,
  userId: string,
  triggeredBy: "cron" | "manual" = "cron"
) {
  const { data, error } = await db
    .from("scheduled_task_runs")
    .insert({
      scheduled_task_id: scheduledTaskId,
      user_id: userId,
      status: "running",
      triggered_by: triggeredBy,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as ScheduledTaskRun;
}

export async function markScheduledTaskRunSucceeded(
  db: DbClient,
  runId: string,
  input: { agentSessionId?: string | null; responseExcerpt?: string | null }
) {
  const { error } = await db
    .from("scheduled_task_runs")
    .update({
      status: "succeeded",
      finished_at: new Date().toISOString(),
      agent_session_id: input.agentSessionId ?? null,
      response_excerpt: input.responseExcerpt ?? null,
    })
    .eq("id", runId);

  if (error) throw error;
}

export async function markScheduledTaskRunFailed(
  db: DbClient,
  runId: string,
  input: { agentSessionId?: string | null; errorMessage: string }
) {
  const { error } = await db
    .from("scheduled_task_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      agent_session_id: input.agentSessionId ?? null,
      error_message: input.errorMessage,
    })
    .eq("id", runId);

  if (error) throw error;
}

export async function markScheduledTaskSucceeded(
  db: DbClient,
  scheduledTaskId: string,
  input: {
    nextRunAt: string | null;
    responseExcerpt?: string | null;
  }
) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("scheduled_tasks")
    .update({
      status: input.nextRunAt ? "active" : "completed",
      next_run_at: input.nextRunAt,
      last_executed_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq("id", scheduledTaskId);

  if (error) throw error;
}

export async function markScheduledTaskFailed(
  db: DbClient,
  scheduledTaskId: string,
  errorMessage: string
) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("scheduled_tasks")
    .update({
      status: "failed",
      last_error: errorMessage,
      updated_at: now,
    })
    .eq("id", scheduledTaskId);

  if (error) throw error;
}
