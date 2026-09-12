-- ============================================================================
-- Caremunicate — new plan lineup on profiles.plan
-- Run once in the Supabase SQL Editor.
--
-- The lineup is now: basic, plus, pro, independent-doctor, department, hospital.
--   * "Free" is gone; the entry tier is "basic".
--   * "care-plus" (the old $9 card) is now "basic".
--   * "doctor" (the old $29 card) is now the patient "plus" tier.
--   * "clinic" is now "independent-doctor".
--
-- Steps: widen the constraint, remap existing rows, then tighten it to the new
-- set. Widen-then-tighten means no row can violate the constraint mid-migration.
-- ============================================================================

-- 1) Drop the old allowed-values constraint.
alter table public.profiles
  drop constraint if exists profiles_plan_check;

-- 2) Remap existing values onto the new lineup (beta-stage mapping; edit if your
--    intent for legacy rows differs).
update public.profiles set plan = 'basic'              where plan in ('free', 'care-plus');
update public.profiles set plan = 'plus'               where plan = 'doctor';
update public.profiles set plan = 'independent-doctor' where plan = 'clinic';

-- 3) Enforce the final set — keep in lockstep with PLAN_META in
--    src/components/PricingSection.tsx.
alter table public.profiles
  add constraint profiles_plan_check
  check (plan in ('basic', 'plus', 'pro', 'independent-doctor', 'department', 'hospital'));
