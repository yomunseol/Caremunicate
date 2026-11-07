-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
--
-- Cr-3 — unlock Care Plans for basic planners.
--
-- A patient on any tier (including the basic tier) may author a plan for
-- themselves and add its tasks to the checklist. This reconciles the two
-- schemas in the repo (doctor_id/task_name vs. provider_id/instruction) and
-- replaces the provider-only insert / task policies with a permissive
-- patient-or-author rule.

-- ---------------------------------------------------------------------------
-- 1) Ensure every column the client writes exists on both schema variants.
-- ---------------------------------------------------------------------------
alter table public.care_plans
  add column if not exists doctor_id uuid references auth.users (id) on delete cascade,
  add column if not exists provider_id uuid references auth.users (id) on delete cascade;

alter table public.care_plans alter column provider_id drop not null;

alter table public.care_plan_tasks
  add column if not exists task_name text,
  add column if not exists task_type text default 'boolean',
  add column if not exists duration_value int default 7,
  add column if not exists duration_unit text default 'day';

-- Backfill the client-facing columns from the legacy spellings when present.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'care_plans' and column_name = 'provider_id'
  ) then
    update public.care_plans set doctor_id = provider_id where doctor_id is null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'care_plan_tasks' and column_name = 'instruction'
  ) then
    update public.care_plan_tasks set task_name = instruction where task_name is null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'care_plan_tasks' and column_name = 'metric_type'
  ) then
    update public.care_plan_tasks set task_type = metric_type where task_type is null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'care_plan_tasks' and column_name = 'goal_count'
  ) then
    update public.care_plan_tasks set duration_value = goal_count where duration_value is null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'care_plan_tasks' and column_name = 'goal_unit'
  ) then
    update public.care_plan_tasks set duration_unit = goal_unit where duration_unit is null;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2) care_plans: the creator may insert a plan for themselves (or a patient).
--    `user_id` is the author: the client writes the caller's id on every save.
-- ---------------------------------------------------------------------------
alter table public.care_plans
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

update public.care_plans
   set user_id = coalesce(doctor_id, provider_id, patient_id)
 where user_id is null;

drop policy if exists "care_plans_insert_provider" on public.care_plans;
drop policy if exists "Users can create care plans" on public.care_plans;
drop policy if exists "care_plans_insert_own_or_provider" on public.care_plans;
create policy "Allow users to create care plans"
  on public.care_plans for insert
  to authenticated
  with check (auth.uid() = user_id);

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
-- 3) care_plan_tasks: the plan's patient (any tier) or its author may write.
-- ---------------------------------------------------------------------------
drop policy if exists "care_plan_tasks_write_author" on public.care_plan_tasks;
drop policy if exists "Users can manage tasks for their plans" on public.care_plan_tasks;
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

-- ---------------------------------------------------------------------------
-- 4) Reload PostgREST so the new policies are visible immediately.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
