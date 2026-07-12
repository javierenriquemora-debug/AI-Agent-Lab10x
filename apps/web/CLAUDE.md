@AGENTS.md

# apps/web-specific notes

(See the root `CLAUDE.md` for monorepo-wide architecture — engine vs. product split, LangGraph graph, memory policy, compaction, data model. This file only covers things scoped to this Next.js app.)

## Middleware is `proxy.ts`, not `middleware.ts`

This is a concrete instance of the "not the Next.js you know" warning above: this version uses `src/proxy.ts` (exporting `proxy()` + `config.matcher`) instead of the conventional root `middleware.ts` exporting `middleware()`. It currently just calls `updateSession()` from `lib/supabase/middleware.ts` to refresh the Supabase session cookie on every request (matcher excludes `_next/static`, `_next/image`, favicon, and static image extensions). If you need to add middleware-level logic, edit `proxy.ts` — don't create a `middleware.ts`, it won't be picked up.

## Session lifecycle drives memory flush

`lib/session-memory.ts` wraps the raw `@agents/db` session queries and is what `api/chat` and `api/telegram/webhook` actually call to get a session (not `getActiveSession`/`createSession` directly):

- A session is considered stale after `SESSION_INACTIVITY_TIMEOUT_MINUTES` (default 30) of inactivity; `getOrCreateSessionWithMemoryFlush()` closes it and opens a fresh one.
- Closing a session (explicitly or due to staleness) schedules `flushSessionMemory()` from `@agents/agent` — this is what turns a finished conversation into long-term memory candidates (see root `CLAUDE.md`'s memory-policy section).
- **Exception**: sessions on the `scheduled` channel never flush memory (`shouldFlushSessionMemory`) — cron-triggered runs aren't treated as a memorable conversation.

When touching session open/close logic, go through these wrappers so the memory flush keeps firing; calling the raw `@agents/db` session functions directly will silently skip it.

## OAuth integrations follow one pattern per provider

`lib/google-oauth.ts` / `lib/github-oauth.ts` handle the authorize/token-exchange flow; `lib/google-integration.ts` / `lib/github-integration.ts` wrap stored tokens and encrypt/decrypt them via `lib/oauth-crypto.ts` (AES, `OAUTH_ENCRYPTION_KEY`). A new OAuth provider should follow the same three-file split rather than inventing a new shape.
