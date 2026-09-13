-- ============================================================================
-- Caremunicate — allow 'department' as an account role
--
-- Sign-up can now create doctor / department / hospital accounts. The chat
-- schema and its RPC only knew about ('patient','doctor','hospital'), so a
-- department account could not start a conversation. This widens the three
-- places that enumerate roles. Run once in the Supabase SQL Editor.
-- ============================================================================

-- 1) Participant role snapshots.
alter table public.conversation_participants
  drop constraint if exists conversation_participants_role_check;

alter table public.conversation_participants
  add constraint conversation_participants_role_check
  check (role in ('patient', 'doctor', 'department', 'hospital'));

-- 2) Departments are providers, so keep them in the public directory alongside
--    doctors and hospitals — patients must be able to find them.
drop policy if exists "profiles_read_for_directory_or_peers" on public.profiles;
create policy "profiles_read_for_directory_or_peers"
  on public.profiles for select
  to authenticated
  using (
    user_id = auth.uid()
    or role in ('doctor', 'department', 'hospital')
    or exists (
      select 1
      from public.conversation_participants me
      join public.conversation_participants peer
        on peer.conversation_id = me.conversation_id
      where me.user_id = auth.uid()
        and peer.user_id = profiles.user_id
    )
  );

-- 3) create_direct_conversation() validates both roles before inserting, so it
--    must accept 'department' too or it raises 'invalid role on a profile'.
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

  if auth.uid() is distinct from p_user_a
     and auth.uid() is distinct from p_user_b then
    raise exception 'Not authorized: you can only start a conversation you are part of.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(least(p_user_a::text, p_user_b::text)
                     || ':' ||
                     greatest(p_user_a::text, p_user_b::text), 0)
  );

  select cp.conversation_id into v_conversation_id
  from public.conversation_participants cp
  where cp.user_id in (p_user_a, p_user_b)
  group by cp.conversation_id
  having count(distinct cp.user_id) = 2
  limit 1;

  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

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

  -- department added here (and to the participant CHECK above)
  if v_role_a not in ('patient', 'doctor', 'department', 'hospital')
     or v_role_b not in ('patient', 'doctor', 'department', 'hospital') then
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

revoke all on function public.create_direct_conversation(uuid, uuid) from public;
grant execute on function public.create_direct_conversation(uuid, uuid) to authenticated;
