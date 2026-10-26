drop function if exists public.create_appointment_room(uuid, text);
drop function if exists public.provider_busy_slots(uuid);

-- CF-1 — calendar booking repair.
--
-- DIAGNOSIS FIRST. PGRST202 is PostgREST's *function*-not-found error (a missing
-- TABLE reports PGRST205), and the booking code itself already treats it that
-- way (src/lib/appointments.ts: "PGRST202 not in the schema cache" ⇒ the
-- function is absent). The three RPCs the booking flow calls —
-- request_appointment, respond_appointment, create_appointment_room — are NOT
-- defined by ANY migration in this repo, so a booking submit reaches
-- PostgREST, which has no such function in its schema cache ⇒ PGRST202.
--
-- The tables themselves (availability, appointments) ARE defined in
-- 202609190001_appointments.sql — so this is not a table-visibility problem.
-- But the repo migration has drifted from what the code reads/writes:
--   * appointments.status CHECK omits 'requested'      → the request flow can't insert
--   * availability: code writes host_id / slot_min / buffer_min, migration declares
--     provider_id / slot_minutes / buffer_minutes
--   * appointments: code tolerates host_id + duration_min, migration declares
--     provider_id + end_at
--   * there is no UNIQUE(host_id, weekday, start_time) for the availability upsert,
--     and no UNIQUE(room_code) for the fresh-code retry
-- This migration reconciles all of that (idempotent, safe to re-run) and then
-- defines the three missing RPCs.
--
-- Run once in the Supabase SQL Editor. Requires public.is_admin() (from
-- 202609180001_doctor_verification.sql).

-- ---------------------------------------------------------------------------
-- 1) Tables (no-op if they already exist) — repo-migration columns retained.
-- ---------------------------------------------------------------------------
create table if not exists public.availability (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references auth.users (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  slot_minutes smallint not null default 30,
  buffer_minutes smallint not null default 0,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references auth.users (id) on delete cascade,
  provider_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid,
  room_code text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'requested',
  note text,
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);

-- ---------------------------------------------------------------------------
-- 2) Column drift — make BOTH column spellings exist, then backfill so neither
--    side reads an all-NULL column.
-- ---------------------------------------------------------------------------
alter table public.availability
  add column if not exists host_id uuid,
  add column if not exists provider_id uuid,
  add column if not exists slot_min smallint,
  add column if not exists slot_minutes smallint,
  add column if not exists buffer_min smallint,
  add column if not exists buffer_minutes smallint;

update public.availability set host_id = coalesce(host_id, provider_id);
update public.availability set provider_id = coalesce(provider_id, host_id);
update public.availability set slot_min = coalesce(slot_min, slot_minutes, 30);
update public.availability set slot_minutes = coalesce(slot_minutes, slot_min, 30);
update public.availability set buffer_min = coalesce(buffer_min, buffer_minutes, 0);
update public.availability set buffer_minutes = coalesce(buffer_minutes, buffer_min, 0);

alter table public.appointments
  add column if not exists host_id uuid,
  add column if not exists provider_id uuid,
  add column if not exists start_at timestamptz,
  add column if not exists duration_min integer,
  add column if not exists end_at timestamptz,
  add column if not exists buffer_minutes smallint not null default 0,
  add column if not exists reminder_sent boolean not null default false,
  add column if not exists room_id uuid,
  add column if not exists room_code text,
  add column if not exists note text;

update public.appointments set host_id = coalesce(host_id, provider_id);
update public.appointments set provider_id = coalesce(provider_id, host_id);
update public.appointments
  set duration_min = coalesce(duration_min, greatest(1, round(extract(epoch from (end_at - start_at)) / 60)::int), 30)
  where duration_min is null and end_at is not null;
update public.appointments
  set end_at = coalesce(end_at, start_at + make_interval(mins => coalesce(duration_min, 30)))
  where end_at is null;

-- 'requested' must be a legal status for the request/approve flow.
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments
  add constraint appointments_status_check
  check (status in ('requested', 'scheduled', 'confirmed', 'completed', 'cancelled'));

-- The availability upsert uses onConflict 'host_id,weekday,start_time'.
create unique index if not exists availability_host_weekday_start_key
  on public.availability (host_id, weekday, start_time);

-- The fresh-code retry in createAppointmentRoom expects 23505 on a taken code.
create unique index if not exists appointments_room_code_key
  on public.appointments (room_code) where room_code is not null;

create index if not exists appointments_patient_start_idx on public.appointments (patient_id, start_at);
create index if not exists appointments_provider_start_idx on public.appointments (provider_id, start_at);

-- The legacy start_time/end_time columns must not block a booking that only
-- writes start_at/end_at (the appointments_mirror coalesce fills them in), so
-- relax their NOT NULL as part of the drift reconciliation.
alter table public.appointments alter column start_time drop not null;
alter table public.appointments alter column end_time drop not null;

-- ---------------------------------------------------------------------------
-- 3) Grants. Supabase's role default privileges usually cover new public tables,
--    but CF-1 requires them explicit.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.availability to authenticated;
grant select, insert, update, delete on public.appointments to authenticated;
grant all on public.availability to service_role;
grant all on public.appointments to service_role;

-- ---------------------------------------------------------------------------
-- 4) RLS — each party sees only their own rows. Owner columns covered under
--    either spelling (there is no doctor_id column).
-- ---------------------------------------------------------------------------
alter table public.availability enable row level security;
alter table public.appointments enable row level security;

drop policy if exists "availability_read_all" on public.availability;
create policy "availability_read_all"
  on public.availability for select to authenticated using (true);

drop policy if exists "availability_write_own" on public.availability;
create policy "availability_write_own"
  on public.availability for all to authenticated
  using (coalesce(host_id, provider_id) = auth.uid() or public.is_admin())
  with check (coalesce(host_id, provider_id) = auth.uid() or public.is_admin());

drop policy if exists "appointments_read_own" on public.appointments;
create policy "appointments_read_own"
  on public.appointments for select to authenticated
  using (
    patient_id = auth.uid()
    or coalesce(provider_id, host_id) = auth.uid()
    or public.is_admin()
  );

drop policy if exists "appointments_insert_patient" on public.appointments;
create policy "appointments_insert_patient"
  on public.appointments for insert to authenticated
  with check (patient_id = auth.uid() or coalesce(provider_id, host_id) = auth.uid());

drop policy if exists "appointments_update_parties" on public.appointments;
create policy "appointments_update_parties"
  on public.appointments for update to authenticated
  using (patient_id = auth.uid() or coalesce(provider_id, host_id) = auth.uid() or public.is_admin())
  with check (patient_id = auth.uid() or coalesce(provider_id, host_id) = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- 5) The MISSING RPCs — the actual PGRST202 fix.
-- ---------------------------------------------------------------------------

-- Patient: ask a host for a slot. Returns the created row (status 'requested');
-- the overlap trigger is the DB backstop (raises 23P01 appointment_overlap).
create or replace function public.request_appointment(
  p_host_id uuid,
  p_start_at timestamptz,
  p_duration_min integer,
  p_note text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.appointments;
  v_min integer := greatest(1, coalesce(p_duration_min, 30));
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  insert into public.appointments
    (patient_id, provider_id, host_id, start_at, end_at, duration_min, status, note)
  values
    (auth.uid(), p_host_id, p_host_id, p_start_at,
     p_start_at + make_interval(mins => v_min), v_min, 'requested', p_note)
  returning * into v_row;

  return v_row;
end;
$$;

-- Host: accept (mint the room code) or decline.
create or replace function public.respond_appointment(
  p_appointment_id uuid,
  p_approve boolean,
  p_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_approve then
    update public.appointments
      set status = 'scheduled',
          room_code = p_code
      where id = p_appointment_id
        and coalesce(provider_id, host_id) = auth.uid();
  else
    update public.appointments
      set status = 'cancelled'
      where id = p_appointment_id
        and coalesce(provider_id, host_id) = auth.uid();
  end if;

  if not found then
    raise exception 'not_host' using errcode = '42501';
  end if;
end;
$$;

-- Provider: mint a fresh room code onto a block they own. 23505 => retry.
create or replace function public.create_appointment_room(
  p_appointment_id uuid,
  p_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.appointments
    set room_code = p_code
    where id = p_appointment_id
      and coalesce(provider_id, host_id) = auth.uid();

  if not found then
    raise exception 'not_host' using errcode = '42501';
  end if;
end;
$$;

-- provider_busy_slots already exists (202609190001) — re-assert so the cache is warm.
create or replace function public.provider_busy_slots(p_provider uuid)
returns table (start_at timestamptz, end_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select a.start_at, a.end_at
  from public.appointments a
  where coalesce(a.provider_id, a.host_id) = p_provider
    and a.status <> 'cancelled';
$$;

revoke all on function public.request_appointment(uuid, timestamptz, integer, text) from public;
revoke all on function public.respond_appointment(uuid, boolean, text) from public;
revoke all on function public.create_appointment_room(uuid, text) from public;
revoke all on function public.provider_busy_slots(uuid) from public;
grant execute on function public.request_appointment(uuid, timestamptz, integer, text) to authenticated;
grant execute on function public.respond_appointment(uuid, boolean, text) to authenticated;
grant execute on function public.create_appointment_room(uuid, text) to authenticated;
grant execute on function public.provider_busy_slots(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) ALWAYS last — tell PostgREST to reload its schema cache.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';

alter table public.appointments alter column doctor_id drop not null;
create or replace function public.appointments_mirror() returns trigger
language plpgsql as $$
begin
  NEW.doctor_id    := coalesce(NEW.doctor_id, NEW.provider_id, NEW.host_id);
  NEW.provider_id  := coalesce(NEW.provider_id, NEW.doctor_id);
  NEW.host_id      := coalesce(NEW.host_id, NEW.doctor_id);
  NEW.start_time   := coalesce(NEW.start_time, NEW.start_at);
  NEW.start_at     := coalesce(NEW.start_at, NEW.start_time);
  NEW.end_time     := coalesce(NEW.end_time, NEW.end_at);
  NEW.end_at       := coalesce(NEW.end_at, NEW.end_time);
  NEW.meeting_code := coalesce(NEW.meeting_code, NEW.room_code);
  NEW.room_code    := coalesce(NEW.room_code, NEW.meeting_code);
  NEW.notes        := coalesce(NEW.notes, NEW.note);
  NEW.note         := coalesce(NEW.note, NEW.notes);
  return NEW;
end $$;
drop trigger if exists appointments_mirror_t on public.appointments;
create trigger appointments_mirror_t before insert or update on public.appointments
for each row execute function public.appointments_mirror();
update public.appointments set
  provider_id  = coalesce(provider_id, doctor_id),
  host_id      = coalesce(host_id, doctor_id),
  start_at     = coalesce(start_at, start_time),
  end_at       = coalesce(end_at, end_time),
  room_code    = coalesce(room_code, meeting_code),
  note         = coalesce(note, notes),
  duration_min = coalesce(duration_min, greatest(1, round(extract(epoch from (coalesce(end_time, end_at) - coalesce(start_time, start_at))) / 60)::int), 30);
