-- ============================================================================
-- Caremunicate — doctor verification
--
-- Adds the source of truth for the certification badge plus the private bucket
-- that holds license documents. Run once in the Supabase SQL Editor.
--
-- The badge may ONLY say "verified" when verification_status = 'verified'.
-- Everything else (email confirmation, profile completion) is not evidence.
-- ============================================================================

-- Helper: avoids recursive RLS when a profiles policy needs to ask "am I admin?".
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.user_id = auth.uid()), false);
$$;

alter table public.profiles
  add column if not exists verification_status text not null default 'unverified';
alter table public.profiles
  add column if not exists verification_note text;
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

alter table public.profiles drop constraint if exists profiles_verification_status_check;
alter table public.profiles
  add constraint profiles_verification_status_check
  check (verification_status in ('unverified', 'pending', 'verified', 'rejected'));

-- ---------------------------------------------------------------------------
-- Private bucket for license documents.
-- Path convention: {user_id}/license-{timestamp}.pdf
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('verification-docs', 'verification-docs', false)
on conflict (id) do nothing;

drop policy if exists "verification_docs_owner_insert" on storage.objects;
create policy "verification_docs_owner_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'verification-docs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "verification_docs_owner_or_admin_read" on storage.objects;
create policy "verification_docs_owner_or_admin_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'verification-docs'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ---------------------------------------------------------------------------
-- profiles: doctors may write their own verification fields; admins may read
-- and update anyone.
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_read_admins" on public.profiles;
create policy "profiles_read_admins"
  on public.profiles for select
  to authenticated
  using (public.is_admin());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "profiles_update_admins" on public.profiles;
create policy "profiles_update_admins"
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Guard: RLS cannot restrict *columns*, so without this any doctor could PATCH
-- their own row to verification_status = 'verified' — a false badge worse than
-- the one this migration exists to remove. A doctor may only move
-- unverified/rejected -> pending. Everything else requires an admin.
-- ---------------------------------------------------------------------------
create or replace function public.guard_verification_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if new.is_admin is distinct from old.is_admin then
    raise exception 'is_admin is read-only';
  end if;

  if new.verification_status is distinct from old.verification_status then
    if not (
      old.verification_status in ('unverified', 'rejected')
      and new.verification_status = 'pending'
      and new.verification_note is null
    ) then
      raise exception 'verification_status may only be set to pending by its owner';
    end if;
  end if;

  if new.verification_note is distinct from old.verification_note then
    raise exception 'verification_note is admin-only';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_verification_columns on public.profiles;
create trigger guard_verification_columns
  before update on public.profiles
  for each row execute function public.guard_verification_columns();

-- Promote your own account once, then remove this line and re-run if you like:
-- update public.profiles set is_admin = true where user_id = '<your-auth-user-id>';
