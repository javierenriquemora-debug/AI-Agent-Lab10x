import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { MemoryType } from "@agents/types";
import type { MemoryAction, MemoryServiceScope } from "./memory-policy";

const LOG_TIMEZONE = "America/Bogota";

function getMemoryLogPath(): string {
  const configuredPath = process.env.MEMORY_LOG_PATH?.trim();
  return path.resolve(process.cwd(), configuredPath || "logs/selective-memory.log");
}

export function formatMemoryTypeLabel(type: MemoryType): string {
  if (type === "semantic") return "semantic";
  if (type === "procedural") return "procedural";
  return "episodic";
}

export function formatMemoryActionLabel(action: MemoryAction): string {
  if (action === "suggest_only") return "suggest_only";
  if (action === "never_automate") return "never_automate";
  return "remember";
}

export function formatMemoryEntry(entry: {
  type: MemoryType;
  content: string;
  inferredScope: MemoryServiceScope;
  action?: MemoryAction;
  reason?: string;
  similarity?: number;
  score?: number;
}): string {
  const parts = [
    `type=${formatMemoryTypeLabel(entry.type)}`,
    `scope=${entry.inferredScope}`,
  ];
  if (entry.action) parts.push(`action=${formatMemoryActionLabel(entry.action)}`);
  if (typeof entry.similarity === "number") parts.push(`similarity=${entry.similarity.toFixed(4)}`);
  if (typeof entry.score === "number") parts.push(`score=${entry.score.toFixed(2)}`);
  if (entry.reason) parts.push(`reason=${entry.reason}`);
  parts.push(`content=${JSON.stringify(entry.content)}`);
  return `- ${parts.join(" | ")}`;
}

export async function appendMemoryLogBlock(
  title: string,
  lines: string[]
): Promise<void> {
  const logPath = getMemoryLogPath();
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
    console.warn("Could not write selective memory log file.", error);
  }
}
