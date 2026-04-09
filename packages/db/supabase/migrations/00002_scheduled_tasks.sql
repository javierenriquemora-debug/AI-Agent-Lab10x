alter table public.agent_sessions
  drop constraint if exists agent_sessions_channel_check;

alter table public.agent_sessions
  add constraint agent_sessions_channel_check
  check (channel in ('web', 'telegram', 'scheduled'));

alter table public.profiles
  alter column timezone set default 'America/Bogota';

-- ============================================================
-- scheduled_tasks
-- ============================================================
create table public.scheduled_tasks (
  id                      uuid primary key default uuid_generate_v4(),
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  prompt                  text not null,
  schedule_type           text not null check (schedule_type in ('one_time', 'recurring')),
  recurrence              text check (recurrence in ('daily', 'weekly', 'monthly')),
  run_at                  timestamptz not null,
  next_run_at             timestamptz not null,
  timezone                text not null default 'America/Bogota',
  channel                 text not null default 'telegram' check (channel in ('telegram')),
  status                  text not null default 'active'
    check (status in ('active', 'processing', 'completed', 'failed', 'paused', 'cancelled')),
  last_executed_at        timestamptz,
  last_error              text,
  created_via_session_id  uuid references public.agent_sessions(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check (
    (schedule_type = 'one_time' and recurrence is null) or
    (schedule_type = 'recurring' and recurrence is not null)
  )
);

create index scheduled_tasks_status_next_run_idx
  on public.scheduled_tasks (status, next_run_at);

create index scheduled_tasks_user_id_idx
  on public.scheduled_tasks (user_id);

alter table public.scheduled_tasks enable row level security;

create policy "Users can manage own scheduled tasks"
  on public.scheduled_tasks for all
  using (auth.uid() = user_id);

-- ============================================================
-- scheduled_task_runs
-- ============================================================
create table public.scheduled_task_runs (
  id                 uuid primary key default uuid_generate_v4(),
  scheduled_task_id  uuid not null references public.scheduled_tasks(id) on delete cascade,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  status             text not null default 'running'
    check (status in ('running', 'succeeded', 'failed')),
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  error_message      text,
  agent_session_id   uuid references public.agent_sessions(id) on delete set null,
  response_excerpt   text,
  triggered_by       text not null default 'cron' check (triggered_by in ('cron', 'manual'))
);

create index scheduled_task_runs_task_id_idx
  on public.scheduled_task_runs (scheduled_task_id, started_at desc);

alter table public.scheduled_task_runs enable row level security;

create policy "Users can manage own scheduled task runs"
  on public.scheduled_task_runs for all
  using (auth.uid() = user_id);
