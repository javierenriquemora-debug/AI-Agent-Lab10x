import { flushSessionMemory } from "@agents/agent";
import {
  closeActiveSessions,
  closeSession,
  createSession,
  getActiveSession,
  type DbClient,
} from "@agents/db";
import type { AgentSession, Channel } from "@agents/types";

const DEFAULT_SESSION_INACTIVITY_TIMEOUT_MINUTES = 30;

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldFlushSessionMemory(session: AgentSession): boolean {
  return session.channel !== "scheduled";
}

function isSessionStale(session: AgentSession): boolean {
  const timeoutMinutes = readIntEnv(
    "SESSION_INACTIVITY_TIMEOUT_MINUTES",
    DEFAULT_SESSION_INACTIVITY_TIMEOUT_MINUTES
  );
  const reference = Date.parse(session.updated_at ?? session.created_at);
  if (!Number.isFinite(reference)) return false;
  const ageMs = Date.now() - reference;
  return ageMs > timeoutMinutes * 60_000;
}

function scheduleFlush(db: DbClient, session: AgentSession | null | undefined) {
  if (!session) return;
  if (!shouldFlushSessionMemory(session)) return;
  void flushSessionMemory({
    db,
    userId: session.user_id,
    sessionId: session.id,
  }).catch((error) => {
    console.error("Failed to flush long-term memory for session.", {
      sessionId: session.id,
      userId: session.user_id,
      error,
    });
  });
}

export async function closeSessionWithMemoryFlush(
  db: DbClient,
  sessionId: string
): Promise<AgentSession | null> {
  const session = await closeSession(db, sessionId);
  scheduleFlush(db, session);
  return session;
}

export async function closeActiveSessionsWithMemoryFlush(
  db: DbClient,
  userId: string,
  channel: Channel
): Promise<AgentSession[]> {
  const sessions = await closeActiveSessions(db, userId, channel);
  for (const session of sessions) {
    scheduleFlush(db, session);
  }
  return sessions;
}

export async function getOrCreateSessionWithMemoryFlush(
  db: DbClient,
  userId: string,
  channel: Channel
): Promise<AgentSession> {
  const existing = await getActiveSession(db, userId, channel);
  if (existing && !isSessionStale(existing)) return existing;
  if (existing) {
    await closeSessionWithMemoryFlush(db, existing.id);
  }

  await closeActiveSessionsWithMemoryFlush(db, userId, channel);
  return createSession(db, userId, channel);
}
