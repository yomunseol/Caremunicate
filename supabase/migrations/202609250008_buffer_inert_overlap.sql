-- CF-8 — buffer never blocks a booking.
--
-- FOUNDER DECISION: buffer_minutes must NEVER make a slot unbookable. The
-- columns stay in the schema (default 0) for a possible future feature, but
-- today they are INERT: overlap is decided by REAL appointment intervals only.
--
-- This replaces guard_appointment_overlap with a predicate that reads start_at /
-- end_at only — no buffer term at all — keeping the HALF-OPEN semantics (a slot
-- starting exactly at another appointment's end is legal).
--
-- Idempotent; safe to re-run. Run after 202609250007_half_open_overlap.sql.

create or replace function public.guard_appointment_overlap()
returns trigger
language plpgsql
as $$
declare
  v_end timestamptz;
begin
  -- A cancelled row never blocks, and is never blocked by anything.
  if coalesce(new.status, '') = 'cancelled' then
    return new;
  end if;

  -- The NEW row's end (some schemas carry only duration_min).
  v_end := coalesce(
    new.end_at,
    new.start_at + make_interval(mins => greatest(1, coalesce(new.duration_min, 30)))
  );

  -- HALF-OPEN, REAL intervals only. No buffer_minutes anywhere: it can never
  -- block a booking.
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
               )
  ) then
    raise exception 'appointment_overlap' using errcode = '23P01';
  end if;

  return new;
end;
$$;

-- The trigger no longer needs to fire on buffer_minutes.
drop trigger if exists trg_guard_appointment_overlap on public.appointments;
create trigger trg_guard_appointment_overlap
  before insert or update of start_at, end_at, status, provider_id
  on public.appointments
  for each row
  execute function public.guard_appointment_overlap();

-- ALWAYS last — tell PostgREST to reload its schema cache.
notify pgrst, 'reload schema';
