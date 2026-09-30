-- ============================================================================
-- Caremunicate — call sessions + Caremunicate Docs
--
-- Backs the clinical-grade call UI: a persisted session row (in-call chat),
-- per-author clinical notes with a Locked/Unlocked edit policy, and the
-- recording pointer.
--
-- Run once in the Supabase SQL Editor.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) call_sessions — one row per live call, keyed by the room.
-- ---------------------------------------------------------------------------
create table if not exists public.call_sessions (
  id             uuid primary key default gen_random_uuid(),
  room_key       text not null,                 -- transport key (word code or UUID)
  room_code      text,                          -- the human word code, when it exists
  host_id        uuid references auth.users (id) on delete set null,
  kind           text not null default 'video',
  participant_ids uuid[] not null default '{}', -- everyone who joined
  chat_log       jsonb not null default '[]'::jsonb,
  has_recording  boolean not null default false,
  recording_url  text,                          -- Storage object path, NEVER a blob: URL
  started_at     timestamptz not null default now(),
  ended_at       timestamptz
);

create index if not exists call_sessions_room_key_idx on public.call_sessions (room_key);

alter table public.call_sessions enable row level security;

-- Only the people in the call (or its host) may read or update it.
drop policy if exists "call_sessions_read_participants" on public.call_sessions;
create policy "call_sessions_read_participants"
  on public.call_sessions for select
  to authenticated
  using (auth.uid() = any(participant_ids) or auth.uid() = host_id);

drop policy if exists "call_sessions_update_participants" on public.call_sessions;
create policy "call_sessions_update_participants"
  on public.call_sessions for update
  to authenticated
  using (auth.uid() = any(participant_ids) or auth.uid() = host_id)
  with check (auth.uid() = any(participant_ids) or auth.uid() = host_id);

-- Join: create-or-append-me atomically; returns the row (id + existing chat_log).
create or replace function public.join_call_session(
  p_room_key text,
  p_room_code text,
  p_host_id uuid,
  p_kind text
)
returns public.call_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.call_sessions;
begin
  insert into public.call_sessions (room_key, room_code, host_id, kind, participant_ids)
  values (p_room_key, p_room_code, p_host_id, coalesce(p_kind, 'video'), array[auth.uid()])
  on conflict do nothing;

  update public.call_sessions
     set participant_ids = (
       select array(select distinct unnest(participant_ids || array[auth.uid()]))
     )
   where room_key = p_room_key
     and ended_at is null
  returning * into row;

  if row.id is null then
    select * into row
    from public.call_sessions
    where room_key = p_room_key
    order by started_at desc
    limit 1;
  end if;

  return row;
end;
$$;

-- Append ONE chat entry atomically (no lost updates), participant-gated.
create or replace function public.append_call_message(
  p_session uuid,
  p_sender text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  entry jsonb;
begin
  if not exists (
    select 1 from public.call_sessions
    where id = p_session and auth.uid() = any(participant_ids)
  ) then
    raise exception 'not a participant' using errcode = '42501';
  end if;

  entry := jsonb_build_object(
    'id', gen_random_uuid(),
    'sender', p_sender,
    'body', left(p_body, 2000),
    'at', now()
  );

  update public.call_sessions
     set chat_log = chat_log || entry
   where id = p_session;

  return entry;
end;
$$;

revoke all on function public.join_call_session(text, text, uuid, text) from public;
revoke all on function public.append_call_message(uuid, text, text) from public;
grant execute on function public.join_call_session(text, text, uuid, text) to authenticated;
grant execute on function public.append_call_message(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) clinical_docs — Caremunicate Docs. One doc per author per session.
--    Locking is DERIVED: edit_mode = 'meeting_only' locks once the session ends.
-- ---------------------------------------------------------------------------
create table if not exists public.clinical_docs (
  id              uuid primary key default gen_random_uuid(),
  call_session_id uuid references public.call_sessions (id) on delete cascade,
  appointment_id  uuid,                             -- optional link to an appointment
  author_id       uuid not null references auth.users (id) on delete cascade,
  title           text,
  content         text not null default '',
  edit_mode       text not null default 'meeting_only'
                  check (edit_mode in ('meeting_only', 'anytime')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (call_session_id, author_id)
);

create index if not exists clinical_docs_session_idx on public.clinical_docs (call_session_id);

alter table public.clinical_docs enable row level security;

-- The author owns their notes; admins may read anyone's.
drop policy if exists "clinical_docs_read_author_or_admin" on public.clinical_docs;
create policy "clinical_docs_read_author_or_admin"
  on public.clinical_docs for select
  to authenticated
  using (author_id = auth.uid() or public.is_admin());

drop policy if exists "clinical_docs_insert_own" on public.clinical_docs;
create policy "clinical_docs_insert_own"
  on public.clinical_docs for insert
  to authenticated
  with check (author_id = auth.uid());

-- Content is editable while the doc is 'anytime', OR while its call session is
-- still live. A 'meeting_only' doc auto-locks the moment the session ends —
-- enforced here, not just in the UI.
drop policy if exists "clinical_docs_update_own" on public.clinical_docs;
create policy "clinical_docs_update_own"
  on public.clinical_docs for update
  to authenticated
  using (author_id = auth.uid())
  with check (
    author_id = auth.uid()
    and (
      edit_mode = 'anytime'
      or exists (
        select 1 from public.call_sessions cs
        where cs.id = call_session_id and cs.ended_at is null
      )
    )
  );

-- edit_mode is fixed at creation: a later change cannot unlock a locked doc.
create or replace function public.guard_clinical_doc()
returns trigger
language plpgsql
as $$
begin
  if new.edit_mode is distinct from old.edit_mode then
    raise exception 'edit_mode is immutable' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_guard_clinical_doc on public.clinical_docs;
create trigger trg_guard_clinical_doc
  before update on public.clinical_docs
  for each row
  execute function public.guard_clinical_doc();

-- ---------------------------------------------------------------------------
-- 3) Realtime — the dispatchable events stream to subscribed clients.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'call_sessions'
  ) then
    alter publication supabase_realtime add table public.call_sessions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clinical_docs'
  ) then
    alter publication supabase_realtime add table public.clinical_docs;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4) Recording storage (used by the last pass).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', false)
on conflict (id) do nothing;

drop policy if exists "call_recordings_owner_insert" on storage.objects;
create policy "call_recordings_owner_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'call-recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "call_recordings_owner_or_admin_read" on storage.objects;
create policy "call_recordings_owner_or_admin_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'call-recordings'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );
