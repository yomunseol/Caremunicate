-- ============================================================================
-- Caremunicate — community hospitals map
--
-- Backs the /hospitals route. `idempotent`: the table is expected to already
-- exist in the live project (created by hand); this records the shape and, more
-- importantly, the RLS policies that let an authenticated user read every
-- hospital and insert their own.
-- Run once in the Supabase SQL Editor, after 202609190001_appointments.sql.
-- ============================================================================

create table if not exists public.hospitals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  latitude double precision not null,
  longitude double precision not null,
  -- OSM element id ("node/123") when the location came from a map search.
  osm_id text,
  added_by uuid references auth.users (id) on delete set null
);

create index if not exists hospitals_added_by_idx on public.hospitals (added_by);
create index if not exists hospitals_name_idx on public.hospitals (name);

-- 1) RLS — everyone signed in can read the map; only the author writes.
alter table public.hospitals enable row level security;

drop policy if exists "hospitals_read_all" on public.hospitals;
create policy "hospitals_read_all"
  on public.hospitals for select
  to authenticated
  using (true);

drop policy if exists "hospitals_insert_own" on public.hospitals;
create policy "hospitals_insert_own"
  on public.hospitals for insert
  to authenticated
  with check (added_by = auth.uid());

drop policy if exists "hospitals_delete_own" on public.hospitals;
create policy "hospitals_delete_own"
  on public.hospitals for delete
  to authenticated
  using (added_by = auth.uid());
