-- ============================================================================
-- Caremunicate — availability + appointments
--
-- Backs /calendar. Run once in the Supabase SQL Editor, after
-- 202609180001_doctor_verification.sql (it reuses public.is_admin()).
--
-- Times are stored as UTC timestamptz; every client renders them in the
-- browser's local zone. Availability is wall-clock (a weekday plus a time of
-- day), so it is deliberately NOT a timestamptz.
-- ============================================================================

-- 1) Weekly availability, one row per provider per weekday.
create table if not exists public.availability (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references auth.users (id) on delete cascade,
  -- 0 = Sunday .. 6 = Saturday, matching Date#getUTCDay.
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  slot_minutes smallint not null default 30 check (slot_minutes in (15, 30, 45, 60)),
  buffer_minutes smallint not null default 0 check (buffer_minutes between 0 and 120),
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  unique (provider_id, weekday)
);

-- 2) Appointments. `room_id` points at call_rooms.id (maintained outside this
-- repo, so no FK is declared); `room_code` caches the public word code so a
-- Join button never has to resolve one.
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references auth.users (id) on delete cascade,
  provider_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid,
  room_code text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'confirmed', 'completed', 'cancelled')),
  note text,
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);

create index if not exists appointments_patient_start_idx
  on public.appointments (patient_id, start_at);
create index if not exists appointments_provider_start_idx
  on public.appointments (provider_id, start_at);

-- 3) RLS — both parties read their own rows; only the patient creates.
alter table public.availability enable row level security;
alter table public.appointments enable row level security;

-- Availability is public reading (patients need to see open slots), but only
-- the owner may write it.
drop policy if exists "availability_read_all" on public.availability;
create policy "availability_read_all"
  on public.availability for select
  to authenticated
  using (true);

drop policy if exists "availability_write_own" on public.availability;
create policy "availability_write_own"
  on public.availability for all
  to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

drop policy if exists "appointments_read_own" on public.appointments;
create policy "appointments_read_own"
  on public.appointments for select
  to authenticated
  using (patient_id = auth.uid() or provider_id = auth.uid() or public.is_admin());

-- The patient books; the provider may only react to an existing row.
drop policy if exists "appointments_insert_patient" on public.appointments;
create policy "appointments_insert_patient"
  on public.appointments for insert
  to authenticated
  with check (patient_id = auth.uid());

-- Either side may update (patient cancels, provider confirms) — the column
-- guard below stops a patient from confirming their own appointment.
drop policy if exists "appointments_update_parties" on public.appointments;
create policy "appointments_update_parties"
  on public.appointments for update
  to authenticated
  using (patient_id = auth.uid() or provider_id = auth.uid())
  with check (patient_id = auth.uid() or provider_id = auth.uid());

-- 4) Column guard: only the provider may move an appointment to 'confirmed',
-- and only the patient may cancel. Without this, RLS cannot stop a patient
-- from PATCHing their own row straight to 'confirmed'.
create or replace function public.guard_appointment_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'confirmed' and auth.uid() is distinct from old.provider_id then
      raise exception 'only the provider may confirm an appointment';
    end if;
    if new.status = 'cancelled' and auth.uid() is distinct from old.patient_id
       and auth.uid() is distinct from old.provider_id then
      raise exception 'only a participant may cancel an appointment';
    end if;
    if new.status = 'completed' then
      raise exception 'completed is derived from the end time, not written';
    end if;
  end if;

  -- Participants are fixed at creation.
  if new.patient_id is distinct from old.patient_id
     or new.provider_id is distinct from old.provider_id
     or new.start_at is distinct from old.start_at
     or new.end_at is distinct from old.end_at
     or new.room_id is distinct from old.room_id then
    raise exception 'the appointment slot is immutable; cancel and rebook instead';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_appointment_status on public.appointments;
create trigger guard_appointment_status
  before update on public.appointments
  for each row execute function public.guard_appointment_status();

-- 5) Slot computation needs to know WHEN a provider is busy, but a patient has
-- no business reading other patients' rows (names, notes). This returns bare
-- time ranges only.
create or replace function public.provider_busy_slots(p_provider uuid)
returns table (start_at timestamptz, end_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select a.start_at, a.end_at
  from public.appointments a
  where a.provider_id = p_provider
    and a.status <> 'cancelled';
$$;

revoke all on function public.provider_busy_slots(uuid) from public;
grant execute on function public.provider_busy_slots(uuid) to authenticated;
