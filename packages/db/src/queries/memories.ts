import type { DbClient } from "../client";
import type { MemoryRecord, MemoryType } from "@agents/types";

export interface SaveMemoryInput {
  userId: string;
  type: MemoryType;
  content: string;
  embedding: number[];
  dedupeHash: string;
  sourceSessionId?: string | null;
  sourceMessageStartAt?: string | null;
  sourceMessageEndAt?: string | null;
}

export interface SearchMemoriesInput {
  userId: string;
  embedding: number[];
  limit: number;
}

export interface MemorySearchResult extends MemoryRecord {
  similarity: number;
}

export async function saveMemories(
  db: DbClient,
  memories: SaveMemoryInput[]
): Promise<MemoryRecord[]> {
  if (memories.length === 0) return [];

  const payload = memories.map((memory) => ({
    user_id: memory.userId,
    type: memory.type,
    content: memory.content,
    embedding: memory.embedding,
    dedupe_hash: memory.dedupeHash,
    source_session_id: memory.sourceSessionId ?? null,
    source_message_start_at: memory.sourceMessageStartAt ?? null,
    source_message_end_at: memory.sourceMessageEndAt ?? null,
  }));

  const { data, error } = await db
    .from("memories")
    .upsert(payload, {
      onConflict: "user_id,type,dedupe_hash",
      ignoreDuplicates: true,
    })
    .select("*");
  if (error) throw error;
  return (data ?? []) as MemoryRecord[];
}

export async function searchMemories(
  db: DbClient,
  input: SearchMemoriesInput
): Promise<MemorySearchResult[]> {
  const { data, error } = await db.rpc("search_memories", {
    p_user_id: input.userId,
    query_embedding: input.embedding,
    match_count: input.limit,
  });
  if (error) throw error;
  return (data ?? []) as MemorySearchResult[];
}

export async function incrementMemoryRetrievalCount(
  db: DbClient,
  memoryIds: string[]
): Promise<void> {
  if (memoryIds.length === 0) return;

  const { error } = await db.rpc("increment_memory_retrieval_count", {
    memory_ids: memoryIds,
  });
  if (!error) return;

  const { data: currentRows, error: selectError } = await db
    .from("memories")
    .select("id, retrieval_count")
    .in("id", memoryIds);
  if (selectError) throw selectError;

  const now = new Date().toISOString();
  for (const row of currentRows ?? []) {
    const currentCount =
      typeof row.retrieval_count === "number" ? row.retrieval_count : 0;
    const { error: updateError } = await db
      .from("memories")
      .update({
        retrieval_count: currentCount + 1,
        last_retrieved_at: now,
      })
      .eq("id", row.id);
    if (updateError) throw updateError;
  }
}
