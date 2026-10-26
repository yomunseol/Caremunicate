-- CF-7 — half-open slot overlap + opt-in buffer.
--
-- SYMPTOM: booking 09:00–09:45 disabled BOTH 09:00 and the touching 09:45 slot.
--
-- DIAGNOSIS (both candidates):
--   A) closed-interval predicate (`<=`/`>=`): NOT live. The client grid
--      (slotStatesForDate / findConflict) and the old guard_appointment_overlap
--      both already used strict `<`/`>`.
--   B) buffer widening: LIVE. The old math widened every busy window on BOTH
--      sides by a buffer — the per-appointment buffer_minutes (legacy blanket
--      default 10) AND a 5-minute client fallback — so 09:00–09:45 occupied
--      08:50–09:55 and the touching 09:45 slot was caught.
--
-- FIX (server side):
--   1. Buffer is OPT-IN: the appointment default is forced to 0 and any legacy
--      `10` rows are wiped. Intentional buffers are re-set per availability row.
--   2. guard_appointment_overlap now uses the HALF-OPEN predicate — touching
--      intervals coexist — and adds a trailing buffer ONLY from the matching
--      availability row (buffer_minutes > 0), never from the appointment column.
--
-- Idempotent; safe to re-run. Run after 202609250003_calendar_booking_repair.sql.

-- ---------------------------------------------------------------------------
-- 1) Buffer policy — opt-in, default 0.
-- ---------------------------------------------------------------------------
alter table public.appointments alter column buffer_minutes set default 0;
update public.appointments set buffer_minutes = 0 where buffer_minutes = 10;

-- ---------------------------------------------------------------------------
-- 2) Half-open overlap guard. Touching intervals (a.end = b.start) DO NOT
--    overlap; the trailing buffer comes from the provider's availability row.
-- ---------------------------------------------------------------------------
create or replace function public.guard_appointment_overlap()
returns trigger
language plpgsql
as $$
declare
  v_buffer integer := 0;
  v_end    timestamptz;
begin
  -- A cancelled row never blocks, and is never blocked by anything.
  if coalesce(new.status, '') = 'cancelled' then
    return new;
  end if;

  -- The NEW row's end (it may carry only duration_min on some schemas).
  v_end := coalesce(
    new.end_at,
    new.start_at + make_interval(mins => greatest(1, coalesce(new.duration_min, 30)))
  );

  -- Trailing buffer from the matching availability row for this weekday.
  -- NOTE: weekday is derived in the server's timezone; the client grid applies
  -- the provider's exact local rule — this is the coarse backstop.
  select coalesce(max(a.buffer_minutes), 0)
    into v_buffer
    from public.availability a
   where coalesce(a.host_id, a.provider_id) = coalesce(new.provider_id, new.host_id)
     and a.weekday = extract(dow from new.start_at)::smallint;

  v_buffer := greatest(0, coalesce(v_buffer, 0));

  -- HALF-OPEN: x.start < new.end AND new.start < x.end (+ trailing buffer).
  if exists (
    select 1
      from public.appointments x
     where coalesce(x.provider_id, x.host_id) = coalesce(new.provider_id, new.host_id)
       and coalesce(x.status, '') <> 'cancelled'
       and x.id is distinct from new.id
       and x.start_at < v_end
       and new.start_at
             < coalesce(
                 x.end_at,
                 x.start_at + make_interval(mins => greatest(1, coalesce(x.duration_min, 30)))
               ) + make_interval(mins => v_buffer)
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
-- 3) ALWAYS last — tell PostgREST to reload its schema cache.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
