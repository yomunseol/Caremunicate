-- CF-9 — server overlap guard: half-open, buffer-free.
--
-- SYMPTOM: post-CF-8 the grid offers 09:45, but booking 09:45–10:30 between
-- 09:00–09:45 and 10:30–11:15 still fails server-side ("That slot is already
-- booked."). The SERVER enforcer was stale — the live DB still ran an older
-- body (buffer-widened, and/or closed-interval), so grid and server disagreed.
--
-- ENFORCEMENT INVENTORY (repo):
--   * trigger `trg_guard_appointment_overlap` -> function
--     `guard_appointment_overlap()` — the ONE server enforcer.
--     History: 202609220001 (buffer both sides) -> 202609250007 (half-open +
--     availability buffer) -> 202609250008 (half-open, buffer-free).
--   * NO exclusion constraint exists in-repo (no EXCLUDE / btree_gist), but a
--     live project may carry one; Part A drops any that is present so a second
--     enforcer can never disagree with the trigger.
--   * `check (end_at > start_at)` is a ROW-validity check, not an overlap
--     enforcer — it stays.
--   * client: `isOverlapError` maps SQLSTATE 23P01 / message `appointment_overlap`
--     to `cal.slotTaken` ("That slot is already booked.") — unchanged.
--
-- This migration is self-contained: running just this file puts the server on
-- the half-open, buffer-free predicate.
--
-- Idempotent; safe to re-run. Run after 202609250003_calendar_booking_repair.sql.

-- ---------------------------------------------------------------------------
-- Part A — drop any EXCLUDE constraint on public.appointments (defensive).
-- The trigger is the single enforcement point; a stray exclusion constraint with
-- '[]' bounds would re-introduce the touching-ranges bug.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.appointments'::regclass
       and contype = 'x'
  loop
    execute format('alter table public.appointments drop constraint %I', c.conname);
    raise notice 'CF-9: dropped exclusion constraint % on public.appointments', c.conname;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Part B — the ONE guard: HALF-OPEN, REAL intervals, no buffer anywhere.
-- ---------------------------------------------------------------------------
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

  -- Half-open: x.start < new.end AND new.start < x.end. Touching is LEGAL.
  -- buffer_minutes appears NOWHERE here.
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

drop trigger if exists trg_guard_appointment_overlap on public.appointments;
create trigger trg_guard_appointment_overlap
  before insert or update of start_at, end_at, status, provider_id
  on public.appointments
  for each row
  execute function public.guard_appointment_overlap();

-- ALWAYS last — tell PostgREST to reload its schema cache.
notify pgrst, 'reload schema';
