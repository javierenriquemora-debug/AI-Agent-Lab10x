alter table public.scheduled_tasks
  alter column next_run_at drop not null;
