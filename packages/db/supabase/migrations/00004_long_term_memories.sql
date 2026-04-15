create extension if not exists vector;

alter table public.agent_sessions
  add column if not exists memory_flushed_at timestamptz,
  add column if not exists memory_last_processed_message_at timestamptz;

create table if not exists public.memories (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('episodic', 'semantic', 'procedural')),
  content text not null,
  embedding vector(1536) not null,
  retrieval_count integer not null default 0,
  last_retrieved_at timestamptz,
  source_session_id uuid references public.agent_sessions(id) on delete set null,
  source_message_start_at timestamptz,
  source_message_end_at timestamptz,
  dedupe_hash text not null,
  created_at timestamptz not null default now(),
  unique (user_id, type, dedupe_hash)
);

alter table public.memories enable row level security;

create policy "Users can manage own memories"
  on public.memories for all
  using (auth.uid() = user_id);

create index if not exists memories_user_created_at_idx
  on public.memories (user_id, created_at desc);

create index if not exists memories_embedding_idx
  on public.memories using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function public.search_memories(
  p_user_id uuid,
  query_embedding vector(1536),
  match_count integer default 5
)
returns table (
  id uuid,
  user_id uuid,
  type text,
  content text,
  retrieval_count integer,
  last_retrieved_at timestamptz,
  source_session_id uuid,
  source_message_start_at timestamptz,
  source_message_end_at timestamptz,
  dedupe_hash text,
  created_at timestamptz,
  similarity double precision
)
language sql
stable
as $$
  select
    m.id,
    m.user_id,
    m.type,
    m.content,
    m.retrieval_count,
    m.last_retrieved_at,
    m.source_session_id,
    m.source_message_start_at,
    m.source_message_end_at,
    m.dedupe_hash,
    m.created_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.memories m
  where m.user_id = p_user_id
  order by m.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

create or replace function public.increment_memory_retrieval_count(
  memory_ids uuid[]
)
returns void
language sql
as $$
  update public.memories
  set
    retrieval_count = retrieval_count + 1,
    last_retrieved_at = now()
  where id = any(memory_ids);
$$;
