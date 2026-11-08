-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
--
-- Care-plan lifecycle columns + the task value/note log.
--   * care_plans.locked          — true = edit/delete disabled
--   * care_plan_tasks.last_completed_date — hides the task until the next day
--   * task_logs                  — the Log dialog (value + note)

-- ---------------------------------------------------------------------------
-- 1) New columns
-- ---------------------------------------------------------------------------
alter table public.care_plans
  add column if not exists doctor_id uuid references auth.users (id) on delete cascade,
  add column if not exists provider_id uuid references auth.users (id) on delete cascade,
  add column if not exists locked boolean not null default false;

alter table public.care_plans alter column provider_id drop not null;

alter table public.care_plan_tasks
  add column if not exists last_completed_date date;

create index if not exists care_plan_tasks_completed_idx
  on public.care_plan_tasks (plan_id, last_completed_date);

-- ---------------------------------------------------------------------------
-- 2) Plans: the author (patient or provider) may update title / locked / tasks
-- ---------------------------------------------------------------------------
drop policy if exists "care_plans_update_author" on public.care_plans;
create policy "care_plans_update_author"
  on public.care_plans for update
  to authenticated
  using (
    patient_id = auth.uid()
    or doctor_id = auth.uid()
    or provider_id = auth.uid()
  )
  with check (
    patient_id = auth.uid()
    or doctor_id = auth.uid()
    or provider_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- 3) Tasks: the plan's patient or author may check off / edit tasks.
-- ---------------------------------------------------------------------------
drop policy if exists "care_plan_tasks_write_author" on public.care_plan_tasks;
create policy "care_plan_tasks_write_author"
  on public.care_plan_tasks for all
  to authenticated
  using (
    exists (
      select 1 from public.care_plans p
      where p.id = plan_id
        and (
          p.patient_id = auth.uid()
          or p.doctor_id = auth.uid()
          or p.provider_id = auth.uid()
        )
    )
  )
  with check (
    exists (
      select 1 from public.care_plans p
      where p.id = plan_id
        and (
          p.patient_id = auth.uid()
          or p.doctor_id = auth.uid()
          or p.provider_id = auth.uid()
        )
    )
  );

drop policy if exists "care_plans_delete_author" on public.care_plans;
create policy "care_plans_delete_author"
  on public.care_plans for delete
  to authenticated
  using (
    patient_id = auth.uid()
    or doctor_id = auth.uid()
    or provider_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- 4) task_logs — value + optional note, one row per log action
-- ---------------------------------------------------------------------------
create table if not exists public.task_logs (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.care_plan_tasks (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  logged_value text not null,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists task_logs_task_idx on public.task_logs (task_id);
create index if not exists task_logs_user_idx on public.task_logs (user_id);

alter table public.task_logs enable row level security;

drop policy if exists "task_logs_insert_own" on public.task_logs;
create policy "task_logs_insert_own"
  on public.task_logs for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "task_logs_read_own" on public.task_logs;
create policy "task_logs_read_own"
  on public.task_logs for select
  to authenticated
  using (user_id = auth.uid());

-- The plan author can read the logs on their tasks.
drop policy if exists "task_logs_read_author" on public.task_logs;
create policy "task_logs_read_author"
  on public.task_logs for select
  to authenticated
  using (
    exists (
      select 1
      from public.care_plan_tasks t
      join public.care_plans p on p.id = t.plan_id
      where t.id = task_id
        and (
          p.doctor_id = auth.uid()
          or p.provider_id = auth.uid()
        )
    )
  );

notify pgrst, 'reload schema';
