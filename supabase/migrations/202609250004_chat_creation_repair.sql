-- CF-2 — chat creation repair (42703 undefined column).
--
-- DIAGNOSIS. Starting a new chat from the dashboard throws 42703
-- (undefined_column). The creation path finds the peer with the SECURITY
-- DEFINER search_users() RPC, which matches BY EMAIL (the UI copy is literally
-- "Search any patient or doctor by email." / "Enter the person's email..."),
-- and the dashboard / chat list / calendar all read profiles.email:
--
--   * src/components/SearchUsers.tsx  -> rpc('search_users', ...)
--   * src/components/DashboardOverview.tsx:156  -> select 'user_id, username, email'
--   * src/lib/appointments.ts:398,416           -> select 'user_id, username, email, role, verification_status'
--   * src/lib/notifications.ts:133,155          -> select 'username, email'
--   * src/components/ChatList.tsx / ChatWindow.tsx -> select('*') then read .email
--
-- NO migration in this repo ever adds an email column to public.profiles (the
-- chat migration lists profiles as user_id/username/role/preferred_2fa_method;
-- later migrations add plan, verification_*, is_admin, specialty, clinic). So
-- search_users / these selects reach PostgREST naming a column that does not
-- exist => 42703. The code is right about the INTENT (email lives on profiles);
-- the SCHEMA is missing the column — this migration adds it.
--
-- Also makes direct-conversation creation STRUCTURALLY idempotent: a unique key
-- on the participant pair, so the same patient+doctor pair can never duplicate
-- even under a concurrent double-click.
--
-- Idempotent; safe to re-run. Run once in the Supabase SQL Editor.

-- ---------------------------------------------------------------------------
-- 1) public.profiles.email — the missing column.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists email text;

-- Backfill from auth.users so existing profiles (and the by-email search) work.
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.user_id
   and p.email is distinct from u.email;

create index if not exists profiles_email_lower_idx on public.profiles (lower(email));

-- Keep profiles.email populated without relying on every writer to pass it
-- (the signup upsert and older rows may omit it). SECURITY DEFINER so the
-- trigger can read auth.users.
create or replace function public.profiles_fill_email() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.email is null then
    NEW.email := (select u.email from auth.users u where u.id = NEW.user_id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_fill_email_t on public.profiles;
create trigger profiles_fill_email_t
  before insert or update on public.profiles
  for each row execute function public.profiles_fill_email();

-- ---------------------------------------------------------------------------
-- 2) Idempotent direct conversations — unique key on the participant pair.
-- ---------------------------------------------------------------------------
alter table public.conversations add column if not exists direct_key text;

create unique index if not exists conversations_direct_key_uidx
  on public.conversations (direct_key) where direct_key is not null;

-- Backfill existing direct threads with their canonical (sorted) pair key.
update public.conversations c
   set direct_key = pair.key
  from (
    select conversation_id,
           string_agg(user_id::text, ':' order by user_id::text) as key
      from public.conversation_participants
     group by conversation_id
    having count(*) = 2
  ) pair
 where c.id = pair.conversation_id
   and c.type = 'direct'
   and c.direct_key is null;

-- ---------------------------------------------------------------------------
-- 3) The creator writes direct_key and is race-safe via the unique index.
-- ---------------------------------------------------------------------------
create or replace function public.create_direct_conversation(p_user_a uuid, p_user_b uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation_id uuid;
  v_key             text;
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

  -- One canonical key per unordered pair (least:greatest).
  v_key := least(p_user_a::text, p_user_b::text) || ':' || greatest(p_user_a::text, p_user_b::text);

  select id into v_conversation_id from public.conversations where direct_key = v_key;
  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

  -- Serialize concurrent creations of the same pair.
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));

  select id into v_conversation_id from public.conversations where direct_key = v_key;
  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

  -- Role snapshot. Prefer the profiles.role column, then the signup metadata.
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

  begin
    insert into public.conversations (type, name, created_by, direct_key)
    values ('direct', null, auth.uid(), v_key)
    returning id into v_conversation_id;
  exception when unique_violation then
    -- A concurrent call won the race: reuse its row.
    select id into v_conversation_id from public.conversations where direct_key = v_key;
    if v_conversation_id is null then
      raise;
    end if;
    return v_conversation_id;
  end;

  insert into public.conversation_participants (conversation_id, user_id, role)
  values
    (v_conversation_id, p_user_a, v_role_a),
    (v_conversation_id, p_user_b, v_role_b);

  return v_conversation_id;
end;
$$;

revoke all on function public.create_direct_conversation(uuid, uuid) from public;
grant execute on function public.create_direct_conversation(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) ALWAYS last — tell PostgREST to reload its schema cache.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
