-- ============================================================================
-- Caremunicate — emergency line
--
-- Backs the dashboard emergency card: a patient raises an alert, providers see
-- it in realtime and can join the Jitsi room or resolve it.
--
-- NOTE ON ACCESS: this project has no per-patient assignment table, so "your
-- care team" cannot be scoped server-side. Any authenticated provider can read
-- and resolve any active alert. That is deliberate (an unanswered emergency is
-- worse than a wide audience) but it is a real access trade-off — tighten it if
-- you add an assignment model.
--
-- Run once in the Supabase SQL Editor.
-- ============================================================================

create table if not exists public.emergency_alerts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  status     text not null default 'active' check (status in ('active', 'resolved')),
  latitude   double precision,
  longitude  double precision,
  -- Jitsi room the patient opened, so providers can join the same call.
  room       text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists emergency_alerts_status_created_idx
  on public.emergency_alerts (status, created_at desc);

alter table public.emergency_alerts enable row level security;

-- Patients: full control over their own alerts.
drop policy if exists "emergency_alerts_insert_own" on public.emergency_alerts;
create policy "emergency_alerts_insert_own"
  on public.emergency_alerts for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "emergency_alerts_read_own" on public.emergency_alerts;
create policy "emergency_alerts_read_own"
  on public.emergency_alerts for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "emergency_alerts_update_own" on public.emergency_alerts;
create policy "emergency_alerts_update_own"
  on public.emergency_alerts for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Providers (doctor / department / hospital): see and resolve active alerts.
drop policy if exists "emergency_alerts_read_providers" on public.emergency_alerts;
create policy "emergency_alerts_read_providers"
  on public.emergency_alerts for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('doctor', 'department', 'hospital')
    )
  );

drop policy if exists "emergency_alerts_update_providers" on public.emergency_alerts;
create policy "emergency_alerts_update_providers"
  on public.emergency_alerts for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('doctor', 'department', 'hospital')
    )
  )
  with check (status in ('active', 'resolved'));

-- Realtime so the provider banner appears the moment an alert is raised.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'emergency_alerts'
  ) then
    alter publication supabase_realtime add table public.emergency_alerts;
  end if;
end
$$;
