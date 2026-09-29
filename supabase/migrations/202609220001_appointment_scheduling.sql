-- Intelligent scheduling: per-appointment buffer + reminder bookkeeping, plus a
-- hard overlap guard so two live appointments can never collide.
--
-- Run order: after 202609190001_appointments.sql. Idempotent — safe to re-run.
--
-- SCHEMA NOTE: the guard below codes against the columns this repo's migration
-- defines (provider_id + end_at). If the LIVE project instead carries the newer
-- pair (host_id + duration_min), swap the trigger body for the alternate
-- predicate at the bottom of this file — otherwise the function fails to create.

-- 1) Scheduling columns on appointments.
alter table public.appointments
  add column if not exists buffer_minutes smallint not null default 0
    check (buffer_minutes between 0 and 120);

alter table public.appointments
  add column if not exists reminder_sent boolean not null default false;

-- 2) Indexes: the busy-window scan, and the daily reminder sweep.
create index if not exists appointments_provider_start_idx
  on public.appointments (provider_id, start_at);

create index if not exists appointments_reminder_idx
  on public.appointments (start_at)
  where reminder_sent = false;

-- 3) Overlap guard. Every live (non-cancelled) appointment for a provider is
--    widened by ITS OWN buffer on both sides; any intersection is rejected with
--    SQLSTATE 23P01 (exclusion_violation) so the client maps it to one message.
create or replace function public.guard_appointment_overlap()
returns trigger
language plpgsql
as $$
begin
  -- A cancelled row never blocks, and is never blocked by anything.
  if coalesce(new.status, '') = 'cancelled' then
    return new;
  end if;

  if exists (
    select 1
    from public.appointments a
    where a.provider_id = new.provider_id
      and a.id <> new.id
      and coalesce(a.status, '') <> 'cancelled'
      and a.start_at - make_interval(mins => coalesce(a.buffer_minutes, 0))
            < new.end_at + make_interval(mins => coalesce(new.buffer_minutes, 0))
      and a.end_at + make_interval(mins => coalesce(a.buffer_minutes, 0))
            > new.start_at - make_interval(mins => coalesce(new.buffer_minutes, 0))
  ) then
    raise exception 'appointment_overlap' using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_appointment_overlap on public.appointments;
create trigger trg_guard_appointment_overlap
  before insert or update of start_at, end_at, status, buffer_minutes, provider_id
  on public.appointments
  for each row
  execute function public.guard_appointment_overlap();

-- ---------------------------------------------------------------------------
-- ALTERNATE BODY for a live schema that uses host_id + duration_min (no end_at).
-- Replace the `if exists (...)` block above with:
--
--   if exists (
--     select 1
--     from public.appointments a
--     where coalesce(a.host_id, a.provider_id) = coalesce(new.host_id, new.provider_id)
--       and a.id <> new.id
--       and coalesce(a.status, '') <> 'cancelled'
--       and a.start_at - make_interval(mins => coalesce(a.buffer_minutes, 0))
--             < new.start_at
--               + make_interval(mins => coalesce(new.duration_min, 30)
--                                     + coalesce(new.buffer_minutes, 0))
--       and a.start_at
--             + make_interval(mins => coalesce(a.duration_min, 30)
--                                   + coalesce(a.buffer_minutes, 0))
--             > new.start_at - make_interval(mins => coalesce(new.buffer_minutes, 0))
--   ) then
-- ---------------------------------------------------------------------------
