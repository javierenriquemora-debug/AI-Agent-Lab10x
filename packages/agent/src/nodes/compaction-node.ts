import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createCompactionModel } from "../model";

const TOOL_RESULT_CLEARED = "[tool result cleared]";
const COMPACTION_SUMMARY_PREFIX = "[RESUMEN COMPACTADO DEL CONTEXTO]";
const DEFAULT_CONTEXT_WINDOW_CHARS = 48_000;
const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_KEEP_LAST_MESSAGES = 12;
const DEFAULT_KEEP_LAST_TOOL_RESULTS = 5;
const DEFAULT_MAX_FAILURES = 3;
const LOG_TIMEZONE = "America/Bogota";

interface CompactionStateInput {
  messages: BaseMessage[];
  sessionId: string;
  compactionCount: number;
  compactionFailureCount: number;
}

interface CompactionNodeResult {
  messages: BaseMessage[];
  compactionCount: number;
  compactionFailureCount: number;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMessageContent(message: BaseMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

function isCompactionSummaryMessage(message: BaseMessage): boolean {
  return (
    message instanceof SystemMessage &&
    getMessageContent(message).startsWith(COMPACTION_SUMMARY_PREFIX)
  );
}

function getMessageRole(message: BaseMessage): string {
  if (message instanceof SystemMessage) return "system";
  if (message instanceof HumanMessage) return "user";
  if (message instanceof ToolMessage) return "tool";
  if (message instanceof AIMessage) return "assistant";
  return "message";
}

function serializeMessage(message: BaseMessage): string {
  const payload: Record<string, unknown> = {
    role: getMessageRole(message),
    content: getMessageContent(message),
  };

  if (message instanceof AIMessage && message.tool_calls?.length) {
    payload.tool_calls = message.tool_calls;
  }

  if (message instanceof ToolMessage) {
    payload.tool_call_id = message.tool_call_id;
  }

  return JSON.stringify(payload);
}

function estimateMessagesSize(messages: BaseMessage[]): number {
  return messages.reduce((total, message) => total + serializeMessage(message).length, 0);
}

function sanitizeSummary(text: string): string {
  return text
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function getCompactionLogPath(): string {
  const configuredPath = process.env.COMPACTION_LOG_PATH?.trim();
  return path.resolve(process.cwd(), configuredPath || "logs/graph-compaction.log");
}

function formatMessagesForLog(messages: BaseMessage[]): string {
  if (messages.length === 0) return "(sin mensajes)";
  return messages
    .map((message, index) => `${index + 1}. ${serializeMessage(message)}`)
    .join("\n");
}

async function appendCompactionLogBlock(
  title: string,
  lines: string[]
): Promise<void> {
  const logPath = getCompactionLogPath();
  const now = new Date();
  const timestampUtc = now.toISOString();
  const timestampLocal = new Intl.DateTimeFormat("es-CO", {
    timeZone: LOG_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  const payload =
    [
      `=== ${title} ===`,
      `timestampUtc: ${timestampUtc}`,
      `timestampLocal: ${timestampLocal} (${LOG_TIMEZONE})`,
      ...lines,
      "",
    ].join("\n");

  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, payload, "utf8");
  } catch (error) {
    console.warn("Could not write compaction log file.", error);
  }
}

function replaceOldToolResults(messages: BaseMessage[]): {
  messages: BaseMessage[];
  clearedToolResults: number;
} {
  const keepLastMessages = readIntEnv(
    "COMPACTION_KEEP_LAST_MESSAGES",
    DEFAULT_KEEP_LAST_MESSAGES
  );
  const keepLastToolResults = readIntEnv(
    "COMPACTION_KEEP_LAST_TOOL_RESULTS",
    DEFAULT_KEEP_LAST_TOOL_RESULTS
  );
  const preservedIndexes = new Set<number>();

  for (let index = Math.max(0, messages.length - keepLastMessages); index < messages.length; index++) {
    preservedIndexes.add(index);
  }

  let preservedRecentTools = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!(messages[index] instanceof ToolMessage)) continue;
    if (preservedRecentTools >= keepLastToolResults) break;
    preservedIndexes.add(index);
    preservedRecentTools += 1;
  }

  let clearedToolResults = 0;
  const nextMessages = messages.map((message, index) => {
    if (!(message instanceof ToolMessage)) return message;
    if (preservedIndexes.has(index)) return message;
    if (getMessageContent(message) === TOOL_RESULT_CLEARED) return message;
    clearedToolResults += 1;

    return new ToolMessage({
      content: TOOL_RESULT_CLEARED,
      tool_call_id: message.tool_call_id,
    });
  });

  return {
    messages: nextMessages,
    clearedToolResults,
  };
}

function splitMessagesForCompaction(messages: BaseMessage[]): {
  leadingSystem: BaseMessage[];
  previousSummary: BaseMessage | null;
  compactable: BaseMessage[];
  recentTail: BaseMessage[];
} {
  const leadingSystem: BaseMessage[] = [];
  let cursor = 0;

  while (cursor < messages.length && messages[cursor] instanceof SystemMessage) {
    if (isCompactionSummaryMessage(messages[cursor])) break;
    leadingSystem.push(messages[cursor]);
    cursor += 1;
    if (leadingSystem.length >= 1) break;
  }

  let previousSummary: BaseMessage | null = null;
  if (cursor < messages.length && isCompactionSummaryMessage(messages[cursor])) {
    previousSummary = messages[cursor];
    cursor += 1;
  }

  const remaining = messages.slice(cursor);
  const keepLastMessages = readIntEnv(
    "COMPACTION_KEEP_LAST_MESSAGES",
    DEFAULT_KEEP_LAST_MESSAGES
  );
  const tailStart = Math.max(0, remaining.length - keepLastMessages);

  return {
    leadingSystem,
    previousSummary,
    compactable: remaining.slice(0, tailStart),
    recentTail: remaining.slice(tailStart),
  };
}

async function summarizeOlderMessages(
  previousSummary: BaseMessage | null,
  compactable: BaseMessage[]
): Promise<string> {
  const model = createCompactionModel();
  const sections = [
    "1. Objetivo actual",
    "2. Datos del usuario y preferencias",
    "3. Hechos confirmados",
    "4. Decisiones tomadas",
    "5. Archivos, rutas o componentes relevantes",
    "6. Herramientas usadas y resultados importantes",
    "7. Tareas pendientes",
    "8. Riesgos, límites o advertencias",
    "9. Último estado conversacional útil",
  ].join("\n");

  const sourceBlocks: string[] = [];
  if (previousSummary) {
    sourceBlocks.push(
      `Resumen previo:\n${getMessageContent(previousSummary).replace(
        COMPACTION_SUMMARY_PREFIX,
        ""
      ).trim()}`
    );
  }

  for (const message of compactable) {
    sourceBlocks.push(serializeMessage(message));
  }

  const response = await model.invoke([
    new SystemMessage(
      [
        "Resume el historial de conversación de forma mecánica y fiel.",
        "No inventes información nueva.",
        "Devuelve solo texto plano, sin markdown especial ni etiquetas XML.",
        "Organiza la salida usando exactamente estas 9 secciones:",
        sections,
      ].join("\n")
    ),
    new HumanMessage(sourceBlocks.join("\n\n")),
  ]);

  return sanitizeSummary(getMessageContent(response));
}

export async function runCompactionNode(
  state: CompactionStateInput
): Promise<CompactionNodeResult> {
  const {
    messages: microcompactedMessages,
    clearedToolResults,
  } = replaceOldToolResults(state.messages);
  const nextCompactionCount = state.compactionCount + 1;
  const maxFailures = readIntEnv(
    "COMPACTION_MAX_FAILURES",
    DEFAULT_MAX_FAILURES
  );
  const estimatedWindowChars = readIntEnv(
    "COMPACTION_CONTEXT_WINDOW_CHARS",
    DEFAULT_CONTEXT_WINDOW_CHARS
  );
  const thresholdRatio = readFloatEnv(
    "COMPACTION_THRESHOLD_RATIO",
    DEFAULT_THRESHOLD_RATIO
  );
  const estimatedUsage = estimateMessagesSize(microcompactedMessages);
  const thresholdChars = Math.floor(estimatedWindowChars * thresholdRatio);
  const contextUsageRatio = estimatedUsage / estimatedWindowChars;

  await appendCompactionLogBlock("COMPACTION_CYCLE_START", [
    `sessionId: ${state.sessionId}`,
    `compactionCount: ${nextCompactionCount}`,
    `compactionFailureCount: ${state.compactionFailureCount}`,
    `estimatedUsageChars: ${estimatedUsage}`,
    `thresholdChars: ${thresholdChars}`,
    `configuredThresholdRatio: ${formatPercent(thresholdRatio)}`,
    `contextUsageRatio: ${formatPercent(contextUsageRatio)}`,
    `clearedToolResults: ${clearedToolResults}`,
    "beforeMicrocompact:",
    formatMessagesForLog(state.messages),
    "afterMicrocompact:",
    formatMessagesForLog(microcompactedMessages),
  ]);

  if (state.compactionFailureCount >= maxFailures) {
    await appendCompactionLogBlock("COMPACTION_CIRCUIT_BREAKER", [
      `sessionId: ${state.sessionId}`,
      `estimatedUsageChars: ${estimatedUsage}`,
      `thresholdChars: ${thresholdChars}`,
      `configuredThresholdRatio: ${formatPercent(thresholdRatio)}`,
      `contextUsageRatio: ${formatPercent(contextUsageRatio)}`,
      `compactionFailureCount: ${state.compactionFailureCount}`,
      `maxFailures: ${maxFailures}`,
      "result: se omite compactacion por LLM y se devuelve microcompact.",
    ]);
    return {
      messages: microcompactedMessages,
      compactionCount: nextCompactionCount,
      compactionFailureCount: state.compactionFailureCount,
    };
  }

  if (estimatedUsage < thresholdChars) {
    await appendCompactionLogBlock("COMPACTION_LLM_SKIPPED", [
      `sessionId: ${state.sessionId}`,
      `estimatedUsageChars: ${estimatedUsage}`,
      `thresholdChars: ${thresholdChars}`,
      `configuredThresholdRatio: ${formatPercent(thresholdRatio)}`,
      `contextUsageRatio: ${formatPercent(contextUsageRatio)}`,
      "result: el historial no supera el umbral; solo se aplica microcompact.",
    ]);
    return {
      messages: microcompactedMessages,
      compactionCount: nextCompactionCount,
      compactionFailureCount: state.compactionFailureCount,
    };
  }

  const { leadingSystem, previousSummary, compactable, recentTail } =
    splitMessagesForCompaction(microcompactedMessages);

  if (compactable.length === 0) {
    await appendCompactionLogBlock("COMPACTION_NO_COMPACTABLE_SLICE", [
      `sessionId: ${state.sessionId}`,
      `estimatedUsageChars: ${estimatedUsage}`,
      `thresholdChars: ${thresholdChars}`,
      `configuredThresholdRatio: ${formatPercent(thresholdRatio)}`,
      `contextUsageRatio: ${formatPercent(contextUsageRatio)}`,
      "result: no hay bloque antiguo suficiente para resumir; se mantiene microcompact.",
    ]);
    return {
      messages: microcompactedMessages,
      compactionCount: nextCompactionCount,
      compactionFailureCount: state.compactionFailureCount,
    };
  }

  try {
    await appendCompactionLogBlock("COMPACTION_LLM_START", [
      `sessionId: ${state.sessionId}`,
      `estimatedUsageChars: ${estimatedUsage}`,
      `thresholdChars: ${thresholdChars}`,
      `configuredThresholdRatio: ${formatPercent(thresholdRatio)}`,
      `contextUsageRatio: ${formatPercent(contextUsageRatio)}`,
      `compactableMessages: ${compactable.length}`,
      `recentTailMessages: ${recentTail.length}`,
      "beforeLlmCompaction:",
      formatMessagesForLog(microcompactedMessages),
    ]);

    const summary = await summarizeOlderMessages(previousSummary, compactable);
    if (!summary) {
      await appendCompactionLogBlock("COMPACTION_LLM_EMPTY_RESULT", [
        `sessionId: ${state.sessionId}`,
        `estimatedUsageChars: ${estimatedUsage}`,
        `thresholdChars: ${thresholdChars}`,
        `configuredThresholdRatio: ${formatPercent(thresholdRatio)}`,
        `contextUsageRatio: ${formatPercent(contextUsageRatio)}`,
        "result: el modelo no devolvio resumen util; se conserva microcompact.",
      ]);
      return {
        messages: microcompactedMessages,
        compactionCount: nextCompactionCount,
        compactionFailureCount: Math.min(
          state.compactionFailureCount + 1,
          maxFailures
        ),
      };
    }

    const compactedMessages = [
      ...leadingSystem,
      new SystemMessage(`${COMPACTION_SUMMARY_PREFIX}\n${summary}`),
      ...recentTail,
    ];

    await appendCompactionLogBlock("COMPACTION_LLM_SUCCESS", [
      `sessionId: ${state.sessionId}`,
      `estimatedUsageChars: ${estimatedUsage}`,
      `thresholdChars: ${thresholdChars}`,
      `configuredThresholdRatio: ${formatPercent(thresholdRatio)}`,
      `contextUsageRatio: ${formatPercent(contextUsageRatio)}`,
      `summaryChars: ${summary.length}`,
      "summary:",
      summary,
      "afterLlmCompaction:",
      formatMessagesForLog(compactedMessages),
    ]);

    return {
      messages: compactedMessages,
      compactionCount: nextCompactionCount,
      compactionFailureCount: 0,
    };
  } catch (error) {
    console.warn("Compaction node failed; continuing without LLM summary.", error);
    await appendCompactionLogBlock("COMPACTION_LLM_FAILURE", [
      `sessionId: ${state.sessionId}`,
      `estimatedUsageChars: ${estimatedUsage}`,
      `thresholdChars: ${thresholdChars}`,
      `configuredThresholdRatio: ${formatPercent(thresholdRatio)}`,
      `contextUsageRatio: ${formatPercent(contextUsageRatio)}`,
      `error: ${error instanceof Error ? error.message : "Unknown compaction error"}`,
      "result: se conserva microcompact y aumenta el contador de fallos.",
    ]);
    return {
      messages: microcompactedMessages,
      compactionCount: nextCompactionCount,
      compactionFailureCount: Math.min(state.compactionFailureCount + 1, maxFailures),
    };
  }
}
