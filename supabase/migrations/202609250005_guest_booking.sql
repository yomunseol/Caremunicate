-- CF-4 — guest (walk-in) bookings.
--
-- A provider can book someone who has no account: the quick-create modal's
-- patient field offers a "+ Guest patient" option that stores a NULL patient_id
-- plus a guest_name. That needs two schema changes:
--   1. a guest_name text column, and
--   2. patient_id must be NULLABLE (202609250003 declared it NOT NULL).
--
-- RLS needs no change: appointments_insert_patient already allows a provider to
-- insert a row whose coalesce(provider_id, host_id) = auth.uid(), and a NULL
-- patient_id simply fails the patient branch.
--
-- Idempotent; safe to re-run. Run after 202609250003_calendar_booking_repair.sql.

alter table public.appointments add column if not exists guest_name text;

-- A guest has no auth user, so patient_id may be NULL.
alter table public.appointments alter column patient_id drop not null;

-- ALWAYS last — tell PostgREST to reload its schema cache.
notify pgrst, 'reload schema';
