-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
--
-- Onboarding wizard fields. Existing profiles default to complete so they are
-- not forced through the wizard; new signups explicitly write false and the
-- wizard flips it to true on completion.
--
-- `profiles` is keyed on user_id (references auth.users(id)), NOT id. These
-- policies use auth.uid() = user_id; an older policy written against `id`
-- makes every onboarding save fail with an RLS error even when the payload
-- is correct.

alter table public.profiles
  add column if not exists full_name text,
  add column if not exists specialty text,
  add column if not exists clinic text,
  add column if not exists clinic_name text,
  add column if not exists onboarding_complete boolean not null default true;

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (user_id = auth.uid());
