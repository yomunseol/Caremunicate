-- ============================================================================
-- Caremunicate — Care Plans (doctor-prompted health tracker)
--
-- A provider authors a plan for a patient; the patient logs each task daily and
-- the provider sees a compliance summary.
--
-- Run once in the Supabase SQL Editor.
-- ============================================================================

-- ---------- care_plans ----------
create table if not exists public.care_plans (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references auth.users (id) on delete cascade,
  provider_id uuid not null references auth.users (id) on delete cascade,
  title       text not null,
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_at  timestamptz not null default now()
);
create index if not exists care_plans_patient_idx on public.care_plans (patient_id, status);

-- ---------- care_plan_tasks ----------
create table if not exists public.care_plan_tasks (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references public.care_plans (id) on delete cascade,
  instruction text not null,
  metric_type text not null default 'boolean' check (metric_type in ('number', 'boolean')),
  -- How often the checklist shows it.
  frequency   text not null default 'daily' check (frequency in ('daily', 'weekly')),
  -- The configurable goal: N days, or N weeks (default = a full week of days).
  goal_count  smallint not null default 7 check (goal_count between 1 and 31),
  goal_unit   text not null default 'day' check (goal_unit in ('day', 'week')),
  position    smallint not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists care_plan_tasks_plan_idx on public.care_plan_tasks (plan_id, position);

-- ---------- care_plan_logs ----------
create table if not exists public.care_plan_logs (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.care_plan_tasks (id) on delete cascade,
  patient_id    uuid not null references auth.users (id) on delete cascade,
  log_date      date not null default current_date,
  value_number  double precision,
  value_boolean boolean,
  created_at    timestamptz not null default now(),
  unique (task_id, log_date)                  -- one log per task per day (upsert target)
);
create index if not exists care_plan_logs_patient_date_idx
  on public.care_plan_logs (patient_id, log_date);

alter table public.care_plans      enable row level security;
alter table public.care_plan_tasks enable row level security;
alter table public.care_plan_logs  enable row level security;

-- Plans: the patient sees their own; the authoring provider and admins see all
-- they own. Only a provider may create.
drop policy if exists "care_plans_read" on public.care_plans;
create policy "care_plans_read"
  on public.care_plans for select
  to authenticated
  using (patient_id = auth.uid() or provider_id = auth.uid() or public.is_admin());

drop policy if exists "care_plans_insert_provider" on public.care_plans;
create policy "care_plans_insert_provider"
  on public.care_plans for insert
  to authenticated
  with check (provider_id = auth.uid());

drop policy if exists "care_plans_update_author" on public.care_plans;
create policy "care_plans_update_author"
  on public.care_plans for update
  to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- Tasks: readable by anyone who can read the parent plan; writable by its author.
drop policy if exists "care_plan_tasks_read" on public.care_plan_tasks;
create policy "care_plan_tasks_read"
  on public.care_plan_tasks for select
  to authenticated
  using (
    exists (
      select 1 from public.care_plans p
      where p.id = plan_id
        and (p.patient_id = auth.uid() or p.provider_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "care_plan_tasks_write_author" on public.care_plan_tasks;
create policy "care_plan_tasks_write_author"
  on public.care_plan_tasks for all
  to authenticated
  using (
    exists (select 1 from public.care_plans p where p.id = plan_id and p.provider_id = auth.uid())
  )
  with check (
    exists (select 1 from public.care_plans p where p.id = plan_id and p.provider_id = auth.uid())
  );

-- Logs: the patient writes their own; the authoring provider and admins read.
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
      where t.id = task_id and (p.provider_id = auth.uid() or public.is_admin())
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

-- ---------- atomic creation (multi-table ⇒ RPC) ----------
create or replace function public.create_care_plan(
  p_patient uuid,
  p_title text,
  p_tasks jsonb
)
returns public.care_plans
language plpgsql
security definer
set search_path = public
as $$
declare
  plan public.care_plans;
  task jsonb;
  pos smallint := 0;
begin
  insert into public.care_plans (patient_id, provider_id, title)
  values (p_patient, auth.uid(), p_title)
  returning * into plan;

  for task in select * from jsonb_array_elements(p_tasks) loop
    insert into public.care_plan_tasks
      (plan_id, instruction, metric_type, frequency, goal_count, goal_unit, position)
    values (
      plan.id,
      task->>'instruction',
      coalesce(task->>'metric_type', 'boolean'),
      coalesce(task->>'frequency', 'daily'),
      coalesce((task->>'goal_count')::smallint, 7),
      coalesce(task->>'goal_unit', 'day'),
      pos
    );
    pos := pos + 1;
  end loop;

  return plan;
end;
$$;

revoke all on function public.create_care_plan(uuid, text, jsonb) from public;
grant execute on function public.create_care_plan(uuid, text, jsonb) to authenticated;

-- ---------- realtime (patient checklist + provider compliance) ----------
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

-- NOTE ON ACCESS: this project has no provider↔patient assignment table, so RLS
-- cannot scope a plan to "the patient's care team" — any authenticated provider
-- may create a plan for any patient_id. That matches the emergency_alerts
-- trade-off and should be tightened if an assignment model is added.
