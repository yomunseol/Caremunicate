-- ============================================================================
-- Caremunicate — doctor directory + patient favourites
--
-- Backs the /doctors route. Two things:
--   1. `profiles.specialty` / `profiles.clinic` — the doctor signup fields were
--      only ever written to auth metadata, which the client cannot read for
--      OTHER users, so the directory had no specialty to show. These columns
--      make the doctor's public directory fields readable under the existing
--      profiles SELECT policy (role in ('doctor','hospital')).
--   2. `doctor_favorites(patient_id, doctor_id)` + RLS, so a patient can only
--      see and toggle their OWN favourites.
--
-- `doctor_favorites` is expected to already exist (created by hand); this is
-- idempotent and only guarantees the unique key and the policies.
-- Run once in the Supabase SQL Editor, after 202609190001_appointments.sql.
-- ============================================================================

-- 1) Public directory fields on profiles (nullable; existing rows stay null).
alter table public.profiles add column if not exists specialty text;
alter table public.profiles add column if not exists clinic text;

-- 2) Favourites.
create table if not exists public.doctor_favorites (
  patient_id uuid not null references auth.users (id) on delete cascade,
  doctor_id  uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (patient_id, doctor_id)
);

-- If the table pre-existed without a key, this also enforces one-per-pair.
-- (Fails only if duplicate rows already exist — delete them first.)
create unique index if not exists doctor_favorites_patient_doctor_idx
  on public.doctor_favorites (patient_id, doctor_id);
create index if not exists doctor_favorites_doctor_idx
  on public.doctor_favorites (doctor_id);

-- 3) RLS — a favourite belongs to its patient, and only to them.
alter table public.doctor_favorites enable row level security;

drop policy if exists "doctor_favorites_read_own" on public.doctor_favorites;
create policy "doctor_favorites_read_own"
  on public.doctor_favorites for select
  to authenticated
  using (patient_id = auth.uid());

drop policy if exists "doctor_favorites_insert_own" on public.doctor_favorites;
create policy "doctor_favorites_insert_own"
  on public.doctor_favorites for insert
  to authenticated
  with check (patient_id = auth.uid());

drop policy if exists "doctor_favorites_delete_own" on public.doctor_favorites;
create policy "doctor_favorites_delete_own"
  on public.doctor_favorites for delete
  to authenticated
  using (patient_id = auth.uid());

-- NOTE: no UPDATE policy — a favourite row is inserted or deleted, never edited.
