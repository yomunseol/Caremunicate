-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
--
-- Onboarding wizard fields. Existing profiles default to complete so they are
-- not forced through the wizard; new signups explicitly write false and the
-- wizard flips it to true on completion.

alter table public.profiles
  add column if not exists full_name text,
  add column if not exists onboarding_complete boolean not null default true;
