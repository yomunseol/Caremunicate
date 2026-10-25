-- CF-6 — request_appointment: reject a null start with a readable code.
--
-- DEFECT A root cause chain: the booking modal held the slot as an OBJECT, so
-- the RPC could receive a null start_at. A null start_at then flowed into the
-- CF-1 appointments_mirror trigger, which does
--   NEW.start_time := coalesce(NEW.start_time, NEW.start_at);
-- leaving the legacy NOT NULL start_time column empty → 23502 (not_null_violation),
-- an opaque code the UI surfaced as "[object Object]".
--
-- The client is now fixed to send start_at = startAt.toISOString() (CF-6), but
-- the server must not depend on that: this adds an explicit guard so a future
-- null start sends a READABLE, self-describing code (22007 invalid_datetime_format)
-- instead of a 23502 from a legacy column.
--
-- Idempotent; safe to re-run. Run after 202609250003_calendar_booking_repair.sql.

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

  -- The guard: a missing start is a readable code, never a legacy NOT NULL 23502.
  if p_start_at is null then
    raise exception 'invalid_start' using errcode = '22007';
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

revoke all on function public.request_appointment(uuid, timestamptz, integer, text) from public;
grant execute on function public.request_appointment(uuid, timestamptz, integer, text) to authenticated;

-- ALWAYS last — tell PostgREST to reload its schema cache.
notify pgrst, 'reload schema';
