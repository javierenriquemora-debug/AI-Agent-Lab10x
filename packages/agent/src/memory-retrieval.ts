import {
  incrementMemoryRetrievalCount,
  searchMemories,
  type DbClient,
  type MemorySearchResult,
} from "@agents/db";
import type { MemoryType } from "@agents/types";
import { generateEmbedding } from "./embeddings";

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

function buildMemorySection(memories: MemorySearchResult[], maxChars: number): string {
  const lines = [
    "[MEMORIA DEL USUARIO]",
    "Usa esta memoria solo si aporta contexto relevante y no contradice la solicitud actual.",
  ];

  for (const memory of memories) {
    const nextLine = `- (${formatMemoryType(memory.type)}) ${memory.content}`;
    const candidate = [...lines, nextLine].join("\n");
    if (candidate.length > maxChars) break;
    lines.push(nextLine);
  }

  return lines.length > 2 ? lines.join("\n") : "";
}

export async function augmentSystemPromptWithMemories(args: {
  db: DbClient;
  userId: string;
  userInput: string;
  baseSystemPrompt: string;
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
    if (memories.length === 0) return args.baseSystemPrompt;

    await incrementMemoryRetrievalCount(
      args.db,
      memories.map((memory) => memory.id)
    );

    const section = buildMemorySection(memories, budgetChars);
    if (!section) return args.baseSystemPrompt;
    return `${args.baseSystemPrompt}\n\n${section}`;
  } catch (error) {
    console.error("Memory retrieval failed; continuing without long-term memory.", error);
    return args.baseSystemPrompt;
  }
}
