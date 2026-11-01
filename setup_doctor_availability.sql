-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
--
-- Provider chat availability. The Doctors directory reads profiles.is_chattable
-- and disables the Message button when it is false. Existing and new provider
-- rows default to available so the feature is on until the provider opts out.

alter table public.profiles
  add column if not exists is_chattable boolean not null default true;

-- Owners can flip their own availability (and the existing onboarding fields).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
