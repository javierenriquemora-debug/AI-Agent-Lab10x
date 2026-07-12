# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

(See the root `CLAUDE.md` for the monorepo-wide picture. This file only covers what's specific to `packages/db`.)

## RLS is bypassed server-side — manual scoping is the real guard

`createServerClient()` (`src/client.ts`) authenticates with `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses Postgres RLS entirely**. This is the client every API route and the agent runtime use (`createBrowserClient()`, using the anon key, is the only one RLS actually constrains). That means the RLS policies in the migrations (`auth.uid() = user_id`) protect the browser path, but **every query function in `src/queries/*.ts` is the actual enforcement point for the server path** — it must take an explicit `userId` (or a `sessionId`/`toolCallId` already known to belong to that user) and filter on it. When adding a new query, always scope by the caller-supplied id; never assume the service-role connection will reject cross-user access on its own.

## Query module conventions

Each file under `src/queries/` exports plain async functions, not a class/repository object: `(db: DbClient, ...args) => Promise<T>`. Pattern to follow for a new query:

```ts
export async function getThing(db: DbClient, userId: string) {
  const { data, error } = await db.from("things").select("*").eq("user_id", userId).single();
  if (error) throw error;
  return data as Thing;
}
```

Re-export new query modules from `src/index.ts` (`export * from "./queries/thing"`) — that's the only place `@agents/db`'s public surface is assembled; the shared `Thing` type itself belongs in `packages/types`, not here.

## Migrations

`supabase/migrations/*.sql` are applied manually through the Supabase SQL editor — there's no CLI/migration runner wired into this repo. New migrations are numbered sequentially (`0000N_description.sql`) and are additive/idempotent in style (`create table if not exists`, `add column if not exists`) since they may be re-run against an already-provisioned project.
