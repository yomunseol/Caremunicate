-- ============================================================================
-- Caremunicate — persist a plan on profiles
-- Run this once in the Supabase SQL Editor (or via `supabase db push`).
--
-- Why: every pricing CTA writes here (see selectPlan() in src/App.tsx).
-- Safe on a live table: existing rows are backfilled to 'free' by the column
-- default, so no separate data migration is required.
-- ============================================================================

alter table public.profiles
  add column if not exists plan text not null default 'free';

-- Keep the allowed values in lockstep with the pricing page
-- (src/components/PricingSection.tsx: 'free' | 'care-plus' | 'doctor' | 'clinic').
alter table public.profiles
  drop constraint if exists profiles_plan_check;

alter table public.profiles
  add constraint profiles_plan_check
  check (plan in ('free', 'care-plus', 'doctor', 'clinic'));
