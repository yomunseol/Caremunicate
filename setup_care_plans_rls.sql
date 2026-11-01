-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
-- Run once. Section 1 is the C-06 care-plan schema; section 2 makes the same
-- file safe on databases that already ran
-- supabase/migrations/202609240001_care_plans.sql (provider_id/instruction).

-- ---------------------------------------------------------------------------
-- 1) C-06 schema + RLS
-- ---------------------------------------------------------------------------

create table if not exists public.care_plans (
  id uuid default gen_random_uuid() primary key,
  patient_id uuid references auth.users(id) on delete cascade not null,
  doctor_id uuid references auth.users(id) on delete cascade,
  title text not null,
  created_at timestamptz default now()
);
alter table public.care_plans enable row level security;
create policy "Users can create care plans" on public.care_plans for insert to authenticated with check (auth.uid() = patient_id or auth.uid() = doctor_id);
create policy "Users can view own care plans" on public.care_plans for select to authenticated using (auth.uid() = patient_id or auth.uid() = doctor_id);

create table if not exists public.care_plan_tasks (
  id uuid default gen_random_uuid() primary key,
  plan_id uuid references public.care_plans(id) on delete cascade not null,
  task_name text not null,
  task_type text default 'boolean',
  frequency text default 'Weekly',
  duration_value int default 7,
  duration_unit text default 'day'
);
alter table public.care_plan_tasks enable row level security;
create policy "Users can manage tasks for their plans" on public.care_plan_tasks for all to authenticated
using (exists (select 1 from public.care_plans cp where cp.id = care_plan_tasks.plan_id and (cp.patient_id = auth.uid() or cp.doctor_id = auth.uid())));

-- ---------------------------------------------------------------------------
-- 2) Compatibility with the older care-plan tables (safe to skip on a fresh DB)
-- ---------------------------------------------------------------------------

alter table public.care_plans
  add column if not exists doctor_id uuid references auth.users(id) on delete cascade,
  add column if not exists provider_id uuid references auth.users(id) on delete cascade,
  add column if not exists status text default 'active',
  add column if not exists created_at timestamptz default now();

update public.care_plans set doctor_id = provider_id where doctor_id is null;
alter table public.care_plans alter column provider_id drop not null;

alter table public.care_plan_tasks
  add column if not exists task_name text,
  add column if not exists task_type text default 'boolean',
  add column if not exists duration_value int default 7,
  add column if not exists duration_unit text default 'day',
  add column if not exists instruction text,
  add column if not exists metric_type text default 'boolean',
  add column if not exists goal_count smallint default 7,
  add column if not exists goal_unit text default 'day',
  add column if not exists position smallint default 0,
  add column if not exists created_at timestamptz default now();

update public.care_plan_tasks set task_name = instruction where task_name is null;
update public.care_plan_tasks set task_type = metric_type where task_type is null;
update public.care_plan_tasks set duration_value = goal_count where duration_value is null;
update public.care_plan_tasks set duration_unit = goal_unit where duration_unit is null;
alter table public.care_plan_tasks alter column instruction drop not null;

create index if not exists care_plans_patient_idx on public.care_plans (patient_id);
create index if not exists care_plans_doctor_idx on public.care_plans (doctor_id);
create index if not exists care_plan_tasks_plan_idx on public.care_plan_tasks (plan_id);

-- ---------------------------------------------------------------------------
-- 3) care_plan_logs — the patient checklist / provider compliance table
--    (C-06's schema does not list it, but the app reads and writes it)
-- ---------------------------------------------------------------------------

create table if not exists public.care_plan_logs (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.care_plan_tasks (id) on delete cascade,
  patient_id    uuid not null references auth.users (id) on delete cascade,
  log_date      date not null default current_date,
  value_number  double precision,
  value_boolean boolean,
  created_at    timestamptz not null default now(),
  unique (task_id, log_date)
);
create index if not exists care_plan_logs_patient_date_idx
  on public.care_plan_logs (patient_id, log_date);

alter table public.care_plan_logs enable row level security;

drop policy if exists "care_plan_logs_read" on public.care_plan_logs;
create policy "care_plan_logs_read"
  on public.care_plan_logs for select
  to authenticated
  using (
    patient_id = auth.uid()
    or exists (
      select 1
      from public.care_plan_tasks t
      join public.care_plans p on p.id = t.plan_id
      where t.id = task_id and p.provider_id = auth.uid()
    )
  );

drop policy if exists "care_plan_logs_read_doctor" on public.care_plan_logs;
create policy "care_plan_logs_read_doctor"
  on public.care_plan_logs for select
  to authenticated
  using (
    exists (
      select 1
      from public.care_plan_tasks t
      join public.care_plans p on p.id = t.plan_id
      where t.id = task_id and p.doctor_id = auth.uid()
    )
  );

drop policy if exists "care_plan_logs_insert_own" on public.care_plan_logs;
create policy "care_plan_logs_insert_own"
  on public.care_plan_logs for insert
  to authenticated
  with check (patient_id = auth.uid());

drop policy if exists "care_plan_logs_update_own" on public.care_plan_logs;
create policy "care_plan_logs_update_own"
  on public.care_plan_logs for update
  to authenticated
  using (patient_id = auth.uid())
  with check (patient_id = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'care_plan_logs'
  ) then
    alter publication supabase_realtime add table public.care_plan_logs;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4) Author cleanup delete — used when the tasks batch insert fails after the
--    plan row was created (the client compensates for the two-step write).
-- ---------------------------------------------------------------------------

drop policy if exists "care_plans_delete_author" on public.care_plans;
create policy "care_plans_delete_author"
  on public.care_plans for delete
  to authenticated
  using (doctor_id = auth.uid());
