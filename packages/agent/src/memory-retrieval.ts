import {
  incrementMemoryRetrievalCount,
  searchMemories,
  type DbClient,
  type MemorySearchResult,
} from "@agents/db";
import type { MemoryType } from "@agents/types";
import { generateEmbedding } from "./embeddings";
import {
  appendMemoryLogBlock,
  formatMemoryEntry,
} from "./memory-log";
import {
  rankMemoriesForScope,
  type MemoryAction,
  type MemoryServiceScope,
} from "./memory-policy";

const DEFAULT_MEMORY_LIMIT = 5;
const DEFAULT_MEMORY_BUDGET_CHARS = 1_200;

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMemoryType(type: MemoryType): string {
  if (type === "semantic") return "Semantica";
  if (type === "procedural") return "Procedimental";
  return "Episodica";
}

function formatActionLabel(action: MemoryAction): string {
  return action === "suggest_only" ? "solo sugerencia" : "recuerdo durable";
}

function isPresentationPreference(memory: MemorySearchResult, action: MemoryAction): boolean {
  if (memory.type !== "semantic" || action !== "remember") return false;
  return /\b(formato|tono|estilo|breve|detallado|detalle|resumen|emoji|emojis|lista numerada|numerada|secciones|conciso|concision|presentacion)\b/i.test(
    memory.content
  );
}

function buildMemorySection(
  memories: Array<{
    memory: MemorySearchResult;
    action: MemoryAction;
  }>,
  maxChars: number
): string {
  const lines = [
    "[MEMORIA DEL USUARIO]",
    "Usa esta memoria solo si aporta contexto relevante y no contradice la solicitud actual.",
    "Los elementos marcados como solo sugerencia NO autorizan decisiones automaticas.",
  ];
  const priorityPresentationLines: string[] = [];
  const durableLines: string[] = [];
  const suggestionLines: string[] = [];

  for (const item of memories) {
    const nextLine =
      `- (${formatMemoryType(item.memory.type)}; ${formatActionLabel(item.action)}) ` +
      `${item.memory.content}`;
    if (isPresentationPreference(item.memory, item.action)) {
      priorityPresentationLines.push(nextLine);
      continue;
    }
    if (item.action === "suggest_only") {
      suggestionLines.push(nextLine);
    } else {
      durableLines.push(nextLine);
    }
  }

  if (priorityPresentationLines.length > 0) {
    const heading = "Preferencias semanticas de presentacion con prioridad:";
    const instruction =
      "Si estas preferencias recuperadas hablan de formato, brevedad, tono, estilo, emojis, numeracion o estructura, APLICALAS con prioridad sobre el formato por defecto del servicio, salvo que hacerlo oculte datos esenciales, reduzca claridad o contradiga reglas de seguridad.";
    const headingCandidate = [...lines, heading].join("\n");
    if (headingCandidate.length <= maxChars) {
      lines.push(heading);
      const instructionCandidate = [...lines, instruction].join("\n");
      if (instructionCandidate.length <= maxChars) {
        lines.push(instruction);
      }
      for (const line of priorityPresentationLines) {
        const nextCandidate = [...lines, line].join("\n");
        if (nextCandidate.length > maxChars) break;
        lines.push(line);
      }
    }
  }

  if (durableLines.length > 0) {
    lines.push("Preferencias y reglas durables:");
    for (const line of durableLines) {
      const candidate = [...lines, line].join("\n");
      if (candidate.length > maxChars) break;
      lines.push(line);
    }
  }

  if (suggestionLines.length > 0) {
    const heading = "Sugerencias historicas no vinculantes:";
    const candidate = [...lines, heading].join("\n");
    if (candidate.length <= maxChars) {
      lines.push(heading);
      for (const line of suggestionLines) {
        const nextCandidate = [...lines, line].join("\n");
        if (nextCandidate.length > maxChars) break;
        lines.push(line);
      }
    }
  }

  return lines.length > 3 ? lines.join("\n") : "";
}

export async function augmentSystemPromptWithMemories(args: {
  db: DbClient;
  userId: string;
  userInput: string;
  baseSystemPrompt: string;
  scope: MemoryServiceScope;
}): Promise<string> {
  const limit = readIntEnv("MEMORY_RETRIEVAL_LIMIT", DEFAULT_MEMORY_LIMIT);
  const budgetChars = readIntEnv("MEMORY_RETRIEVAL_MAX_CHARS", DEFAULT_MEMORY_BUDGET_CHARS);
  const input = args.userInput.trim();
  if (!input) return args.baseSystemPrompt;

  try {
    const embedding = await generateEmbedding(input);
    const memories = await searchMemories(args.db, {
      userId: args.userId,
      embedding,
      limit,
    });
    if (memories.length === 0) {
      await appendMemoryLogBlock("MEMORY_RETRIEVAL_MISS", [
        `userId: ${args.userId}`,
        `scope: ${args.scope}`,
        `input: ${JSON.stringify(input)}`,
        "result: no hubo memorias candidatas por similitud.",
      ]);
      return args.baseSystemPrompt;
    }

    const ranked = rankMemoriesForScope(memories, args.scope).slice(0, limit);
    if (ranked.length === 0) {
      await appendMemoryLogBlock("MEMORY_RETRIEVAL_EMPTY", [
        `userId: ${args.userId}`,
        `scope: ${args.scope}`,
        `input: ${JSON.stringify(input)}`,
        `rawRetrievedCount: ${memories.length}`,
        "result: las memorias recuperadas no superaron el filtro de selectividad.",
      ]);
      return args.baseSystemPrompt;
    }

    await incrementMemoryRetrievalCount(
      args.db,
      ranked.map((item) => item.memory.id)
    );

    const section = buildMemorySection(ranked, budgetChars);
    await appendMemoryLogBlock("MEMORY_RETRIEVAL_RESULT", [
      `userId: ${args.userId}`,
      `scope: ${args.scope}`,
      `input: ${JSON.stringify(input)}`,
      `rawRetrievedCount: ${memories.length}`,
      `rankedCount: ${ranked.length}`,
      `budgetChars: ${budgetChars}`,
      "rankedMemories:",
      ranked
        .map((item) =>
          formatMemoryEntry({
            type: item.memory.type,
            content: item.memory.content,
            inferredScope: item.inferredScope,
            action: item.action,
            reason: `ranked_for_scope=${args.scope}`,
            similarity: item.memory.similarity,
            score: item.score,
          })
        )
        .join("\n"),
      `sectionBuilt: ${section ? "yes" : "no"}`,
      `sectionChars: ${section.length}`,
    ]);
    if (!section) return args.baseSystemPrompt;
    return `${args.baseSystemPrompt}\n\n${section}`;
  } catch (error) {
    console.error("Memory retrieval failed; continuing without long-term memory.", error);
    await appendMemoryLogBlock("MEMORY_RETRIEVAL_FAILURE", [
      `userId: ${args.userId}`,
      `scope: ${args.scope}`,
      `input: ${JSON.stringify(input)}`,
      `error: ${error instanceof Error ? error.message : "Unknown memory retrieval error"}`,
    ]);
    return args.baseSystemPrompt;
  }
}
