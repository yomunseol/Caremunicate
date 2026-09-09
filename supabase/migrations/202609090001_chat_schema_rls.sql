-- ============================================================================
-- Caremunicate — Direct-chat schema, RLS, and atomic DM creator
-- Run this once in the Supabase SQL Editor (or via `supabase db push`).
--
-- Prerequisite (already in use by this app):
--   public.profiles (user_id uuid primary key references auth.users(id),
--                    username text, role text, preferred_2fa_method text)
--
-- Guarantees this migration provides:
--   1. Composite-PK participants, so a user can join a conversation once.
--   2. Foreign keys everywhere; cascading cleanup from conversations.
--   3. RLS on every table. Direct table INSERTs are IMPOSSIBLE for end users —
--      conversations and participants can only be created through the
--      SECURITY DEFINER create_direct_conversation() function below, which
--      enforces the auth.uid() participant boundary in code.
--   4. messages are append-only (no UPDATE/DELETE policies), so chat history
--      cannot be rewritten by clients.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------------

create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  -- Currently only 1:1 direct chats. A check constraint keeps room to grow
  -- without letting callers invent arbitrary types.
  type       text not null default 'direct'
             check (type in ('direct')),
  -- Null for direct chats; intended for future named group threads.
  name       text,
  -- The participant who created the thread.
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Participants are real auth users, never free-form strings.
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- Role SNAPSHOT taken when the conversation was created. If a user later
  -- changes role in profiles, existing conversations keep their original
  -- patient/doctor context (see create_direct_conversation).
  role            text not null check (role in ('patient', 'doctor', 'hospital')),
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null references auth.users (id) on delete cascade,
  content         text not null check (char_length(content) between 1 and 4000),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- INDEXES (FK traversal + the ordering the chat UI depends on)
-- ---------------------------------------------------------------------------

create index if not exists conversation_participants_user_id_idx
  on public.conversation_participants (user_id);
create index if not exists conversation_participants_conversation_id_idx
  on public.conversation_participants (conversation_id);
create index if not exists messages_conversation_created_at_idx
  on public.messages (conversation_id, created_at asc);
create index if not exists messages_sender_id_idx
  on public.messages (sender_id);

-- ---------------------------------------------------------------------------
-- RLS HELPERS
-- ---------------------------------------------------------------------------

-- Membership test used by every policy. SECURITY DEFINER (owner postgres)
-- so policy evaluation does not recurse into the participants table's own
-- RLS. The function is read-only and keyed on auth.uid(), so there is no
-- privilege to escalate: callers can only ever test their own membership.
create or replace function public.is_conversation_participant(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = target
      and cp.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
-- HOW RLS BLOCKS CROSS-ROLE ACCESS:
--   * Every policy funnels through is_conversation_participant(), which only
--     ever resolves to the JWT user (auth.uid()). A patient cannot select a
--     doctor's conversation because the doctor is not a participant in the
--     patient's threads — membership, not role, is the gate.
--   * There are NO INSERT policies on conversations/participants, so even a
--     compromised anon/authenticated client cannot fabricate a conversation
--     with an arbitrary other user; the single creation path is the
--     function below, which checks auth.uid() is one of the two parties.
--   * messages.sender_id must equal auth.uid() on INSERT (no spoofing), and
--     UPDATE/DELETE are denied entirely (append-only history).
-- ---------------------------------------------------------------------------

alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;

drop policy if exists "conversation_members_select" on public.conversations;
create policy "conversation_members_select"
  on public.conversations for select
  to authenticated
  using (public.is_conversation_participant(id));

drop policy if exists "conversation_members_update" on public.conversations;
create policy "conversation_members_update"
  on public.conversations for update
  to authenticated
  using (public.is_conversation_participant(id))
  with check (public.is_conversation_participant(id));

-- NOTE: no INSERT/DELETE policies on conversations. Creation is exclusive to
-- create_direct_conversation(); deletion cascades are managed at the DB level.

drop policy if exists "participant_read_self_or_shared" on public.conversation_participants;
create policy "participant_read_self_or_shared"
  on public.conversation_participants for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_conversation_participant(conversation_id)
  );

-- NOTE: no INSERT/UPDATE/DELETE policies on participants. Membership rows are
-- created transactionally by create_direct_conversation() only.

drop policy if exists "message_read_if_participant" on public.messages;
create policy "message_read_if_participant"
  on public.messages for select
  to authenticated
  using (public.is_conversation_participant(conversation_id));

drop policy if exists "message_insert_if_own_participant" on public.messages;
create policy "message_insert_if_own_participant"
  on public.messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_conversation_participant(conversation_id)
  );

-- Append-only chat history: no UPDATE or DELETE policies on messages.

-- Profiles readability for the chat/dashboard UI. Doctor and hospital rows
-- are a PUBLIC DIRECTORY (patients must be able to browse them to start a
-- first consultation), plus every user can always read their own row and the
-- rows of anyone they share a conversation with. Patient rows are never
-- listed to non-participants — that is the privacy boundary.
drop policy if exists "profiles_read_for_directory_or_peers" on public.profiles;
create policy "profiles_read_for_directory_or_peers"
  on public.profiles for select
  to authenticated
  using (
    user_id = auth.uid()
    or role in ('doctor', 'hospital')
    or exists (
      select 1
      from public.conversation_participants me
      join public.conversation_participants peer
        on peer.conversation_id = me.conversation_id
      where me.user_id = auth.uid()
        and peer.user_id = profiles.user_id
    )
  );

-- NOTE: last-message previews are intentionally NOT denormalized. The chat
-- list computes each preview client-side from the messages table (see
-- src/components/ChatList.tsx), so conversations stays lean.

-- ---------------------------------------------------------------------------
-- ATOMIC DIRECT-CONVERSATION CREATOR (the ONLY write path for new DMs)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER (owner postgres) so the multi-row write is one atomic
-- transaction that RLS cannot interrupt mid-flight. The function replaces
-- RLS as the gate here and enforces, in this order:
--   1. inputs are two different, non-null user ids
--   2. the caller (auth.uid()) is one of the two participants
--   3. no duplicate thread exists (advisory lock makes concurrent calls race
--      safe — two simultaneous "message this doctor" clicks produce ONE chat)
--   4. roles are snapshotted into conversation_participants.role from
--      profiles, falling back to auth.users raw_user_meta_data
-- Because the function owner is postgres (RLS bypassed), the explicit
-- auth.uid() checks above are the security boundary — they cannot be skipped
-- by a client.
create or replace function public.create_direct_conversation(p_user_a uuid, p_user_b uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation_id uuid;
  v_role_a          text;
  v_role_b          text;
begin
  if p_user_a is null or p_user_b is null then
    raise exception 'Both user ids are required.';
  end if;

  if p_user_a = p_user_b then
    raise exception 'A direct conversation requires two different users.';
  end if;

  -- Boundary: only one of the two participants may trigger creation.
  if auth.uid() is distinct from p_user_a
     and auth.uid() is distinct from p_user_b then
    raise exception 'Not authorized: you can only start a conversation you are part of.';
  end if;

  -- Serialize concurrent creations of the same pair.
  perform pg_advisory_xact_lock(
    hashtextextended(least(p_user_a::text, p_user_b::text)
                     || ':' ||
                     greatest(p_user_a::text, p_user_b::text), 0)
  );

  -- Duplicate check: an existing thread has BOTH users as participants.
  select cp.conversation_id into v_conversation_id
  from public.conversation_participants cp
  where cp.user_id in (p_user_a, p_user_b)
  group by cp.conversation_id
  having count(distinct cp.user_id) = 2
  limit 1;

  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

  -- Role snapshot. Prefer the profiles.role column, then the signup
  -- metadata, so users created before a profile row existed still work.
  select p.role into v_role_a from public.profiles p where p.user_id = p_user_a;
  v_role_a := coalesce(
    v_role_a,
    (select raw_user_meta_data ->> 'role' from auth.users where id = p_user_a)
  );
  select p.role into v_role_b from public.profiles p where p.user_id = p_user_b;
  v_role_b := coalesce(
    v_role_b,
    (select raw_user_meta_data ->> 'role' from auth.users where id = p_user_b)
  );

  if v_role_a is null or v_role_b is null then
    raise exception 'Cannot start a chat: one of the users has no profile role yet.';
  end if;

  if v_role_a not in ('patient', 'doctor', 'hospital')
     or v_role_b not in ('patient', 'doctor', 'hospital') then
    raise exception 'Cannot start a chat: invalid role on a profile.';
  end if;

  insert into public.conversations (type, name, created_by)
  values ('direct', null, auth.uid())
  returning id into v_conversation_id;

  insert into public.conversation_participants (conversation_id, user_id, role)
  values
    (v_conversation_id, p_user_a, v_role_a),
    (v_conversation_id, p_user_b, v_role_b);

  return v_conversation_id;
end;
$$;

-- The function is only callable by signed-in users, not the anon key.
revoke all on function public.create_direct_conversation(uuid, uuid) from public;
grant execute on function public.create_direct_conversation(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- REALTIME: publish only new messages (used by useRealtimeChat)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;
