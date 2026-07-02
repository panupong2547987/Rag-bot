-- Unify RAG documents schema to content-based format and keep chat-memory tables in sync.
-- Safe for projects that still have legacy question/answer columns.

create extension if not exists vector;

create table if not exists documents (
  id bigserial primary key,
  content text not null,
  embedding vector(1024)
);

-- Add content column when migrating from legacy schema.
alter table documents add column if not exists content text;

-- Backfill content from legacy question/answer if present.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'documents' and column_name = 'question'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'documents' and column_name = 'answer'
  ) then
    execute $sql$
      update documents
      set content = concat('คำถาม: ', coalesce(question, ''), ' คำตอบ: ', coalesce(answer, ''))
      where content is null or btrim(content) = ''
    $sql$;
  end if;
end $$;

-- Ensure content is always present after backfill.
update documents set content = coalesce(content, '') where content is null;
alter table documents alter column content set not null;

-- Remove legacy columns if they still exist.
alter table documents drop column if exists question;
alter table documents drop column if exists answer;

create or replace function match_documents(
  query_embedding vector(1024),
  match_threshold float default 0.7,
  match_count int default 10
)
returns table (
  id bigint,
  content text,
  similarity float
)
language sql
as $$
  select
    documents.id,
    documents.content,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where documents.embedding is not null
    and 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by documents.embedding <=> query_embedding
  limit match_count;
$$;

-- Chat memory tables for cross-device persistence.
create table if not exists chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'bot')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_conversations_user_updated
  on chat_conversations(user_id, updated_at desc);
create index if not exists idx_chat_messages_conversation_created
  on chat_messages(conversation_id, created_at asc);

alter table chat_conversations enable row level security;
alter table chat_messages enable row level security;

drop policy if exists "users own conversations" on chat_conversations;
create policy "users own conversations"
on chat_conversations for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "users own messages" on chat_messages;
create policy "users own messages"
on chat_messages for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
