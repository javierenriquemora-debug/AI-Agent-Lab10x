import type { DbClient } from "../client";
import type { AgentMessage, MessageRole } from "@agents/types";

export async function addMessage(
  db: DbClient,
  sessionId: string,
  role: MessageRole,
  content: string,
  extra?: { tool_call_id?: string; structured_payload?: Record<string, unknown> }
) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("agent_messages")
    .insert({ session_id: sessionId, role, content, ...extra, created_at: now })
    .select()
    .single();
  if (error) throw error;

  const { error: sessionError } = await db
    .from("agent_sessions")
    .update({ updated_at: now })
    .eq("id", sessionId);
  if (sessionError) throw sessionError;

  return data as AgentMessage;
}

export async function getSessionMessages(
  db: DbClient,
  sessionId: string,
  limit = 50
) {
  const { data, error } = await db
    .from("agent_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AgentMessage[];
}

export async function getSessionMessagesSince(
  db: DbClient,
  sessionId: string,
  sinceCreatedAt?: string | null,
  limit = 200
) {
  let query = db
    .from("agent_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (sinceCreatedAt) {
    query = query.gt("created_at", sinceCreatedAt);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AgentMessage[];
}
