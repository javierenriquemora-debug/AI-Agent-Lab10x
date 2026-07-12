# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Personal AI agent (MVP), monorepo: Next.js + Supabase + LangGraph + OpenRouter/Gemini. Ships a web chat and an optional Telegram bot, both driven by the same LangGraph runtime. Tools available to the agent: `bash` (host shell), Google Calendar, Google Contacts, GitHub, file read/write, and scheduled tasks.

## Commands

All commands run from the repo root via Turborepo (npm workspaces). There is no test suite in this repo (no test runner configured).

```bash
npm install                 # install once, from repo root
npm run dev                 # turbo dev — runs apps/web on fixed port 3000 (ngrok/Telegram webhook depends on this port)
npm run dev:web             # same, but only the web workspace
npm run build                # turbo build (all packages that define it)
npm run lint                 # turbo lint
npm run type-check           # turbo type-check
npm run restart:web          # kills whatever holds port 3000, then dev:web
npm run stop:web             # node ./scripts/stop-port.mjs 3000

cd apps/web && npx next build   # build only the Next app; useful to check types before deploying
```

Per-package equivalents (all packages define `type-check`; only `apps/web` defines `lint`/`build`/`dev`/`start`):

```bash
npm run type-check --workspace @agents/agent
npm run type-check --workspace @agents/db
```

**Port 3000 is hardcoded** in `apps/web/package.json` (`next dev -p 3000`) because the ngrok tunnel used for the Telegram webhook targets that port. If you must change it, update the `dev` script, the ngrok tunnel, and re-register the webhook via `/api/telegram/setup`.

Env vars live in `apps/web/.env.local` (Next.js does not read root `.env*`). Key ones: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `LLM_PROVIDER` (`openrouter`|`gemini`), `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `OAUTH_ENCRYPTION_KEY`, `LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL`, `COMPACTION_KEEP_LAST_MESSAGES`, `COMPACTION_KEEP_LAST_TOOL_RESULTS`, `COMPACTION_CONTEXT_WINDOW_CHARS`, `COMPACTION_THRESHOLD_RATIO`, `SESSION_INACTIVITY_TIMEOUT_MINUTES`, `SCHEDULED_TASKS_CRON_SECRET`.

DB schema changes go in `packages/db/supabase/migrations/*.sql`, applied manually via the Supabase SQL editor (no migration CLI wired up).

## Architecture

### Monorepo split: engine vs. product

- **`packages/agent`** (`@agents/agent`) — the LangGraph engine: graph, tools, model selection, memory. Environment-agnostic; knows nothing about HTTP, Supabase auth sessions, or which channel (web/Telegram) triggered it.
- **`apps/web`** (`@agents/web`) — the only consumer of `@agents/agent`. All four entry points that invoke the agent live here: `api/chat` (web), `api/telegram/webhook` (Telegram), `api/cron/scheduled-tasks` (cron), `api/tool-calls/[id]` (approve/reject a pending tool call). Each entry point assembles its own request context (user profile, channel, enabled tools) and hands a fully-built `systemPrompt` + context to `runAgent()`.
- **Why the system prompt lives in `apps/web/src/lib/agent-runtime.ts` and not in `packages/agent`**: building it requires the user's profile/timezone/enabled-tools from Supabase and knowledge of which channel made the request — that's app-layer concern, not engine concern. Supabase itself never invokes the agent; it is a passive Postgres+Auth store, there are no Supabase Edge Functions in this repo.
- **`packages/db`** (`@agents/db`) — typed Supabase client + queries (`src/queries/*`), migrations under `supabase/migrations`.
- **`packages/types`** — shared TS interfaces. **`packages/config`** — shared `tsconfig.base.json`/`tsconfig.next.json`.

### Message pipeline (identical for web and Telegram)

`apps/web/src/lib/message-preprocessing.ts` runs in this order before the model ever sees the message:

1. `resolveDateReferences()` — rewrites relative dates ("próximo jueves") to include the ISO date, so the LLM never computes dates itself.
2. `injectSchedulingContinuation()` (highest priority) — detects an in-progress scheduling flow from history and injects a directive with what's collected/missing; also handles `pending_confirmation`, contact-selection, and post-cancellation states.
3. `injectDateContext()` — only if (2) didn't touch the message; anchors follow-up messages to the last ISO date seen in history.
4. `injectSchedulingDirective()` — only if (2) didn't touch the message; if the current message has scheduling intent, asks for exactly one missing slot at a time (date → time → subject).

Key regexes to know about when touching this file: `SCHEDULE_INTENT_RE`, `SCHEDULING_FLOW_RE`, `CONTACT_QUESTION_RE`, `CONTACT_OPTIONS_RE`, `AVAILABILITY_RESULT_RE`, `REJECTION_RE`.

### LangGraph graph (`packages/agent/src/graph.ts`)

`StateGraph` with nodes `compaction → agent → tools`, looping `tools → agent` (via `tools → compaction → agent`) until no more tool calls or `MAX_TOOL_ITERATIONS` (6) is hit. `MemorySaver` is the checkpointer, keyed by `thread_id` (built from `sessionId`).

- **Confirmation flow**: tools with medium/high risk (`toolRequiresConfirmation` in `tools/catalog.ts`) trigger `interrupt()` instead of executing; the graph pauses and persists a `pending_confirmation` message. Resuming happens via `resumeAgent()` + `Command({ resume: decision })`, where `decision` is `approve` / `reject` / `edit`. `bash` reuses this same interrupt+resume path — it's always high-risk and always asks for confirmation.
- **Tool catalog vs. adapters**: `tools/catalog.ts` declares `id`, `risk`, and the Zod/JSON parameter schema per tool (data only). `tools/adapters.ts` builds the actual LangChain `DynamicStructuredTool`s (`buildLangChainTools`) and executes a specific tool call by id (`executeToolCallById`), given a `ToolContext` (db, userId, sessionId, enabled tools, integrations, secrets). When adding a new tool: add its entry to `catalog.ts`, implement it in `adapters.ts`, and if it's a Google/GitHub call, likely add a thin client in `tools/google-*-client.ts` or `tools/github-client.ts`.
- **Model selection** (`model.ts`): provider switches on `LLM_PROVIDER` (`openrouter` default, or `gemini` — called through an OpenAI-compatible endpoint so the same LangChain interface/tool-calling works for both). Separate model+provider overrides exist for the main chat model, the compaction model, and the memory-flush model, each falling back to the previous tier if unset.
- **Observability**: Langfuse `CallbackHandler` wraps every `app.invoke()` (`langfuse-graph.ts`), and OTEL is bootstrapped in `apps/web/src/instrumentation.ts`. Switching from local to Langfuse Cloud only needs env vars (`LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY`), no code changes — see `docs/langfuse-cloud-observability.md`. Note `localhost` in a deployed env (Railway/GCP) refers to the container, not your machine. Sentry (`sentry.server.config.ts`, `sentry.edge.config.ts`, `src/instrumentation-client.ts`) is wired separately for error tracking via the standard Next.js SDK setup — unrelated to the Langfuse/OTEL tracing path.

### Context compaction (`nodes/compaction-node.ts`, `docs/graph-compaction-memory-guide.md`)

Two independent layers, run in this order every cycle:

1. **Microcompaction** (cheap, mechanical, always runs): keeps the last `COMPACTION_KEEP_LAST_MESSAGES` messages and the last `COMPACTION_KEEP_LAST_TOOL_RESULTS` tool results; older `ToolMessage` outputs get replaced with `[tool result cleared]`. Never touches user/assistant text, the system prompt, or ordering.
2. **LLM compaction** (only if estimated context size exceeds `COMPACTION_CONTEXT_WINDOW_CHARS * COMPACTION_THRESHOLD_RATIO`): summarizes the old, non-protected block via `createCompactionModel()`, replacing it with a `[RESUMEN COMPACTADO DEL CONTEXTO]` system message. On repeated failures a circuit breaker kicks in and only microcompaction runs. Log tags to grep in `apps/web/logs/graph-compaction.log`: `COMPACTION_CYCLE_START`, `COMPACTION_LLM_SKIPPED`, `COMPACTION_LLM_START`, `COMPACTION_LLM_SUCCESS`, `COMPACTION_LLM_EMPTY_RESULT`, `COMPACTION_LLM_FAILURE`, `COMPACTION_CIRCUIT_BREAKER` — full reference in `docs/graph-compaction-log-tags.md`.

### Selective long-term memory (`memory-policy.ts`, `memory-retrieval.ts`, `memory-flush.ts`, `memory-log.ts`)

Memories are stored per-user in Supabase `public.memories` (pgvector, embeddings, cosine similarity search via `search_memories` RPC) and are **scoped per service**, not global: `calendar`, `contacts`, `scheduled_tasks`, `bash`, `files`, `github`, `general`. `detectMemoryServiceScope()` infers the scope from message content/channel; `evaluateMemoryCandidate()` decides an `action` per candidate:

- `remember` — durable, gets stored and retrieved normally.
- `suggest_only` — stored but only ever surfaced as a soft suggestion, never auto-applied.
- `never_automate` — never stored (episodic one-off facts, raw emails/paths/commands, tool-derived procedural noise).

`rankMemoriesForScope()` scores retrieved candidates by similarity + scope match + type + action, and **cross-scope leakage is penalized** — a `calendar`-scoped memory won't surface for a `github`-scoped query unless the memory's scope is `general`. This exists so that e.g. a one-off email address or bash command never gets treated as a standing preference.

**Project rule (`.cursor/rules/selective-memory-service-check.mdc`, `alwaysApply: true`)**: whenever you create/modify a service, add a tool, change intent detection, or change user-facing formatting/preferences, explicitly evaluate the selective-memory impact *before* coding — ask the user what should be `remember`d, what must be `never_automate`, whether a pattern should be `suggest_only`, and whether the scope should stay isolated or share with `general`. If it's non-trivial, confirm whether the change should touch `memory-policy.ts`, `memory-flush.ts`, `memory-retrieval.ts`, or `message-preprocessing.ts`, and propose a minimal validation set (preference message → session close/flush → later retrieval → cross-service isolation check).

### Scheduled tasks (`api/cron/scheduled-tasks/route.ts`)

A 5th, non-interactive way `runAgent()` gets invoked. Flow: a user asks the agent to schedule something → the `create_scheduled_task` tool writes a row to `scheduled_tasks` (`one_time`|`recurring`, with `next_run_at`) → an external cron pings `GET`/`POST /api/cron/scheduled-tasks` (auth via `Bearer`/`x-cron-secret` matching `SCHEDULED_TASKS_CRON_SECRET`, no-op check if unset) → the route lists due tasks and, per task, **atomically claims it** (`claimScheduledTask`, so two overlapping cron runs can't double-process the same task) → opens a fresh session on the `scheduled` channel → runs the agent with a synthetic message (`buildScheduledExecutionMessage`) → delivers the result **only via Telegram** (`sendTelegramMessage`, including inline approve/reject buttons if the run produced a `pending_confirmation`) → closes the session (`closeSessionWithMemoryFlush`) → reschedules `next_run_at` if recurring, or marks `completed`. Delivery requires the user to have a linked Telegram account; there's no scheduled-task delivery to the web chat. Recall from `apps/web/CLAUDE.md`: `scheduled` channel sessions are excluded from long-term memory flush.

### Data model

See `packages/db/supabase/migrations/00001_initial_schema.sql` (core), `00002_scheduled_tasks.sql` (`scheduled_tasks`, `scheduled_task_runs`), and `00004_long_term_memories.sql` (memories/pgvector). Core tables: `profiles`, `user_integrations` (encrypted OAuth tokens), `user_tool_settings`, `agent_sessions` (`web`/`telegram`/`scheduled`, `active`/`closed`), `agent_messages`, `tool_calls` (`pending_confirmation`/`approved`/`rejected`), `telegram_accounts`, `telegram_link_codes`, `memories`, `scheduled_tasks`, `scheduled_task_runs`. RLS is enabled on every user-data table, but **only the browser (anon-key) client is actually constrained by it** — every server-side query runs through the service-role key, which bypasses RLS; see `packages/db/CLAUDE.md` for what that means when adding queries.

### Security constraints to preserve

- Tools are allowlisted per user: only mounted if the user enabled them **and** has an active integration.
- Medium/high-risk tools always go through the `interrupt`+confirm flow — never call them directly bypassing `toolRequiresConfirmation`.
- `bash` always logs the exact command to `tool_calls.arguments_json`, enforces a timeout, and truncates long output; sessions are keyed by `terminal` name and reused across calls within the same server process.
- Telegram webhook requests are validated against `X-Telegram-Bot-Api-Secret-Token`.
- OAuth tokens are stored AES-encrypted (`user_integrations.encrypted_tokens`) using `OAUTH_ENCRYPTION_KEY`.

### Next.js version note

`apps/web/AGENTS.md` (imported by `apps/web/CLAUDE.md`) flags that this Next.js version has breaking changes vs. training data — check `node_modules/next/dist/docs/` before writing Next-specific code.

## Other CLAUDE.md files in this repo

`apps/web/CLAUDE.md` (app-specific: `proxy.ts` middleware convention, session-lifecycle/memory-flush wrapper, OAuth integration pattern) and `packages/db/CLAUDE.md` (RLS-bypass caveat, query-module conventions, migration style) — both loaded automatically alongside this one depending on which directory you're working in. `packages/agent`, `packages/types`, and `packages/config` intentionally have none; they're fully covered above.

## Further reading

`docs/architecture.md` (fuller prose version of the architecture above, in Spanish), `docs/brief.md` / `docs/plan.md` (original product vision and phased plan), `docs/graph-compaction-memory-guide.md` + `docs/graph-compaction-log-tags.md` (compaction internals and log tags), `docs/langfuse-cloud-observability.md` (Langfuse Cloud vs. self-host setup).
