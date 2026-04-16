import { createHash } from "node:crypto";
import {
  getSessionById,
  getSessionMessagesSince,
  markSessionMemoryFlushed,
  saveMemories,
  type DbClient,
} from "@agents/db";
import type { Channel, MemoryType } from "@agents/types";
import { z } from "zod";
import { generateEmbedding } from "./embeddings";
import {
  appendMemoryLogBlock,
  formatMemoryEntry,
} from "./memory-log";
import { createMemoryFlushModel } from "./model";
import {
  detectMemoryServiceScope,
  evaluateMemoryCandidate,
  getMemoryExtractionPolicy,
  type MemoryServiceScope,
} from "./memory-policy";

const ExtractedMemorySchema = z.object({
  type: z.enum(["episodic", "semantic", "procedural"]),
  content: z.string().trim().min(1).max(500),
});

const ExtractedMemoryArraySchema = z.array(ExtractedMemorySchema).max(12);

function normalizeMemoryContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function buildMemoryHash(type: MemoryType, content: string): string {
  return createHash("sha256")
    .update(`${type}:${normalizeMemoryContent(content).toLowerCase()}`)
    .digest("hex");
}

function extractJsonArray(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) return fencedMatch[1].trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end >= start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function stripInjectedDirective(text: string): string {
  return text.replace(/^\[[\s\S]*?\]\n\n/, "").trim();
}

function getUserSignalText(
  messages: Awaited<ReturnType<typeof getSessionMessagesSince>>
): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => stripInjectedDirective(message.content).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function getUserMessageScopes(
  messages: Awaited<ReturnType<typeof getSessionMessagesSince>>,
  channel: Channel | undefined
): MemoryServiceScope[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => stripInjectedDirective(message.content).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((content) => detectMemoryServiceScope({ text: content, channel }));
}

function formatTranscript(messages: Awaited<ReturnType<typeof getSessionMessagesSince>>): string {
  return messages
    .filter((message) => message.role !== "tool")
    .map((message) => {
      const baseContent =
        message.role === "user"
          ? stripInjectedDirective(message.content)
          : message.content;
      const content = baseContent.replace(/\s+/g, " ").trim();
      return `[${message.role}] ${content}`;
    })
    .filter((line) => !/\[\w+\]\s*$/.test(line))
    .join("\n");
}

async function extractMemoriesFromTranscript(
  transcript: string,
  scope: MemoryServiceScope
) {
  const model = createMemoryFlushModel();
  const response = await model.invoke([
    [
      "system",
      [
        "Extrae recuerdos útiles y durables a partir del transcript.",
        "Solo conserva información que probablemente siga siendo verdad o útil en sesiones futuras.",
        `Servicio actual: ${scope}.`,
        "Clasifica cada recuerdo como episodic, semantic o procedural.",
        "semantic = preferencias estables del usuario, estilo o formato deseado de respuesta, gustos, restricciones o contexto personal durable.",
        "procedural = reglas operativas sobre como debe actuar el agente al ejecutar tareas o flujos.",
        "episodic = hechos concretos ocurridos en una sesion especifica que podrian servir como antecedente futuro.",
        "Si el usuario expresa una preferencia sobre formato, tono, longitud, estilo o presentacion de la respuesta, clasificala como semantic.",
        "Si el recuerdo describe pasos, requisitos o logica de operacion del agente, clasificalo como procedural.",
        getMemoryExtractionPolicy(scope),
        "No inventes hechos. No repitas recuerdos triviales o efímeros.",
        "Si no hay nada que valga la pena recordar, responde [].",
        "Devuelve solo un arreglo JSON válido con objetos {\"type\",\"content\"}.",
      ].join("\n"),
    ],
    ["human", transcript],
  ]);

  const payload = extractJsonArray(
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content)
  );
  return ExtractedMemoryArraySchema.parse(JSON.parse(payload));
}

export async function flushSessionMemory(args: {
  db: DbClient;
  userId: string;
  sessionId: string;
}): Promise<void> {
  const session = await getSessionById(args.db, args.sessionId);
  if (!session) return;

  const messages = await getSessionMessagesSince(
    args.db,
    args.sessionId,
    session.memory_last_processed_message_at ?? null,
    200
  );
  if (messages.length === 0) return;

  const lastProcessedMessageAt = messages[messages.length - 1]?.created_at ?? null;
  const transcript = formatTranscript(messages);
  const userSignalText = getUserSignalText(messages);
  const dominantScope = detectMemoryServiceScope({
    text: userSignalText || transcript,
    channel: session.channel,
  });
  const userMessageScopes = getUserMessageScopes(messages, session.channel);
  const distinctNonGeneralUserScopes = [...new Set(userMessageScopes.filter((item) => item !== "general"))];
  const scope =
    distinctNonGeneralUserScopes.length > 1
      ? "general"
      : distinctNonGeneralUserScopes[0] ?? dominantScope;
  if (!transcript.trim()) {
    await markSessionMemoryFlushed(args.db, args.sessionId, lastProcessedMessageAt);
    return;
  }

  try {
    const extracted = await extractMemoriesFromTranscript(transcript, scope);
    const uniqueMemories = new Map<string, { type: MemoryType; content: string }>();
    const discardedMemories: string[] = [];
    const keptMemories: string[] = [];
    const keptScopes = new Set<MemoryServiceScope>();

    for (const item of extracted) {
      const content = normalizeMemoryContent(item.content);
      if (!content) continue;
      const policy = evaluateMemoryCandidate({
        content,
        type: item.type,
        scope,
        channel: session.channel,
      });
      if (!policy.shouldStore) {
        discardedMemories.push(
          formatMemoryEntry({
            type: item.type,
            content,
            inferredScope: policy.inferredScope,
            action: policy.action,
            reason: policy.reason,
          })
        );
        continue;
      }
      const key = `${item.type}:${content.toLowerCase()}`;
      if (!uniqueMemories.has(key)) {
        uniqueMemories.set(key, {
          type: item.type,
          content,
        });
        keptScopes.add(policy.inferredScope);
        keptMemories.push(
          formatMemoryEntry({
            type: item.type,
            content,
            inferredScope: policy.inferredScope,
            action: policy.action,
            reason: policy.reason,
          })
        );
      }
    }

    const memoriesToSave = await Promise.all(
      [...uniqueMemories.values()].map(async (memory) => ({
        userId: args.userId,
        type: memory.type,
        content: memory.content,
        embedding: await generateEmbedding(memory.content),
        dedupeHash: buildMemoryHash(memory.type, memory.content),
        sourceSessionId: args.sessionId,
        sourceMessageStartAt: messages[0]?.created_at ?? null,
        sourceMessageEndAt: lastProcessedMessageAt,
      }))
    );

    await saveMemories(args.db, memoriesToSave);
    await appendMemoryLogBlock("MEMORY_FLUSH_RESULT", [
      `sessionId: ${args.sessionId}`,
      `userId: ${args.userId}`,
      `channel: ${session.channel}`,
      `detectedScope: ${scope}`,
      `dominantScope: ${dominantScope}`,
      `userMessageScopes: ${userMessageScopes.length > 0 ? userMessageScopes.join(", ") : "(sin mensajes de usuario)"}`,
      `keptScopes: ${keptScopes.size > 0 ? [...keptScopes].join(", ") : "(sin memorias guardadas)"}`,
      `processedMessages: ${messages.length}`,
      `extractedCount: ${extracted.length}`,
      `keptCount: ${keptMemories.length}`,
      `discardedCount: ${discardedMemories.length}`,
      `savedCount: ${memoriesToSave.length}`,
      "keptMemories:",
      keptMemories.length > 0 ? keptMemories.join("\n") : "(sin memorias guardadas)",
      "discardedMemories:",
      discardedMemories.length > 0 ? discardedMemories.join("\n") : "(sin descartes)",
    ]);
  } catch (error) {
    console.error("Memory flush failed; skipping extracted memories.", {
      sessionId: args.sessionId,
      userId: args.userId,
      error,
    });
    await appendMemoryLogBlock("MEMORY_FLUSH_FAILURE", [
      `sessionId: ${args.sessionId}`,
      `userId: ${args.userId}`,
      `channel: ${session.channel}`,
      `detectedScope: ${scope}`,
      `dominantScope: ${dominantScope}`,
      `userMessageScopes: ${userMessageScopes.length > 0 ? userMessageScopes.join(", ") : "(sin mensajes de usuario)"}`,
      `error: ${error instanceof Error ? error.message : "Unknown memory flush error"}`,
    ]);
  } finally {
    await markSessionMemoryFlushed(args.db, args.sessionId, lastProcessedMessageAt);
  }
}
