import type { DbClient } from "../client";
import type { AgentSession, Channel } from "@agents/types";

export async function createSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data, error } = await db
    .from("agent_sessions")
    .insert({
      user_id: userId,
      channel,
      status: "active",
      budget_tokens_used: 0,
      budget_tokens_limit: 100000,
    })
    .select()
    .single();
  if (error) throw error;
  return data as AgentSession;
}

export async function getActiveSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data } = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", channel)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data as AgentSession | null;
}

export async function getSessionById(db: DbClient, sessionId: string) {
  const { data, error } = await db
    .from("agent_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentSession | null) ?? null;
}

export async function closeSession(
  db: DbClient,
  sessionId: string
): Promise<AgentSession | null> {
  const session = await getSessionById(db, sessionId);
  if (!session || session.status === "closed") return session;

  const { data, error } = await db
    .from("agent_sessions")
    .update({
      status: "closed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId)
    .select("*")
    .single();
  if (error) throw error;
  return data as AgentSession;
}

export async function closeActiveSessions(
  db: DbClient,
  userId: string,
  channel: Channel
): Promise<AgentSession[]> {
  const { data: activeSessions, error: activeError } = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", channel)
    .eq("status", "active");
  if (activeError) throw activeError;

  const sessions = (activeSessions ?? []) as AgentSession[];
  if (sessions.length === 0) return [];

  const ids = sessions.map((session) => session.id);
  const { error } = await db
    .from("agent_sessions")
    .update({
      status: "closed",
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);
  if (error) throw error;

  return sessions.map((session) => ({
    ...session,
    status: "closed",
  }));
}

export async function getOrCreateSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const existing = await getActiveSession(db, userId, channel);
  if (existing) return existing;

  await closeActiveSessions(db, userId, channel);

  return createSession(db, userId, channel);
}

export async function updateSessionTokens(
  db: DbClient,
  sessionId: string,
  tokensUsed: number
) {
  const { error } = await db
    .from("agent_sessions")
    .update({
      budget_tokens_used: tokensUsed,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}

export async function markSessionMemoryFlushed(
  db: DbClient,
  sessionId: string,
  lastProcessedMessageAt: string | null
) {
  const { error } = await db
    .from("agent_sessions")
    .update({
      memory_flushed_at: new Date().toISOString(),
      memory_last_processed_message_at: lastProcessedMessageAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}
