import { supabase } from './supabase';
import { asRows, firstRow } from './rows';
import { addDays, dayKey, parseDate, startOfDay } from './time';
import { loadPeople, weekStartsOn, type PersonInfo } from './appointments';

// ---------------------------------------------------------------------------
// Care Plans — a provider authors a plan of tasks; the patient logs each task
// per day; the provider sees a compliance summary.
//
// One log per task per day (unique (task_id, log_date)) so a re-submit corrects
// the value instead of stacking rows. All date math goes through lib/time.ts.
// ---------------------------------------------------------------------------

export type MetricType = 'number' | 'boolean';
export type Frequency = 'daily' | 'weekly';
export type GoalUnit = 'day' | 'week';

export type CarePlan = {
  id: string;
  patient_id: string;
  doctor_id: string | null;
  title: string;
  created_at: string;
};

export type CarePlanTask = {
  id: string;
  plan_id: string;
  task_name: string;
  task_type: MetricType;
  frequency: Frequency;
  duration_value: number;
  duration_unit: GoalUnit;
};

export type CarePlanLog = {
  id: string;
  task_id: string;
  patient_id: string;
  log_date: string;
  value_number: number | null;
  value_boolean: boolean | null;
};

export type NewTask = {
  task_name: string;
  task_type: MetricType;
  frequency: Frequency;
  duration_value: number;
  duration_unit: GoalUnit;
};

/** Codes that mean "that column or table does not exist". */
const SCHEMA_MISMATCH = new Set(['42703', '42P01', 'PGRST204', 'PGRST205']);
const schemaMismatch = (code: string | null | undefined): boolean =>
  SCHEMA_MISMATCH.has(String(code ?? ''));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const loadPlansForPatient = async (patientId: string): Promise<CarePlan[]> => {
  if (!patientId) return [];
  const { data, error } = await supabase
    .from('care_plans')
    .select('*')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('CARE ERROR:', error.message);
    return [];
  }
  return asRows<CarePlan>(data);
};

export const loadTasksForPlans = async (planIds: string[]): Promise<CarePlanTask[]> => {
  const ids = [...new Set(planIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('care_plan_tasks')
    .select('*')
    .in('plan_id', ids)
    .order('task_name', { ascending: true });

  if (error) {
    console.error('CARE ERROR:', error.message);
    return [];
  }
  return asRows<CarePlanTask>(data);
};

/** Logs for one patient since a `YYYY-MM-DD` date (inclusive). */
export const loadLogs = async (patientId: string, fromDate: string): Promise<CarePlanLog[]> => {
  if (!patientId) return [];
  const { data, error } = await supabase
    .from('care_plan_logs')
    .select('*')
    .eq('patient_id', patientId)
    .gte('log_date', fromDate);

  if (error) {
    console.error('CARE ERROR:', error.message);
    return [];
  }
  return asRows<CarePlanLog>(data);
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Plan + tasks creation against the care_plans / care_plan_tasks schema. */
const SAVE_SCHEMA_CODES = new Set([
  '42703', // column does not exist
  '42P01', // table does not exist
  'PGRST202', // function/table not in schema cache
  'PGRST204',
  'PGRST205',
  '23502', // not-null violation (old provider_id/instruction columns)
  '42501', // RLS denial
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createCarePlan = async (payload: {
  patientId: string;
  doctorId: string;
  userId: string;
  title: string;
  tasks: NewTask[];
}): Promise<CarePlan | null> => {
  // The insert policy keys on auth.uid() = user_id, so an empty/invalid id
  // would be rejected before the row is ever written.
  if (!UUID_PATTERN.test(payload.userId)) {
    console.error('CARE PLAN SAVE ERROR:', 'user_id is missing or not a UUID', payload.userId);
    return null;
  }

  // Step A: insert the plan. Step B: capture its id before touching the tasks.
  const basePlan = {
    patient_id: payload.patientId,
    doctor_id: payload.doctorId,
    title: payload.title,
  };

  const insertPayload = { ...basePlan, user_id: payload.userId };
  console.log('Care Plan Payload:', insertPayload);

  let response = await supabase
    .from('care_plans')
    .insert(insertPayload)
    .select('*')
    .single();

  // Older schemas may not carry user_id yet — retry without it rather than
  // failing the whole save.
  if (
    response.error &&
    schemaMismatch(response.error.code) &&
    /user_id/i.test(response.error.message ?? '')
  ) {
    response = await supabase.from('care_plans').insert(basePlan).select('*').single();
  }

  const { data, error: planError } = response;

  if (planError) {
    console.error('CARE PLAN SAVE ERROR:', planError.message, planError.details);
    if (SAVE_SCHEMA_CODES.has(String(planError.code ?? ''))) {
      console.error('CARE PLAN SAVE ERROR: run setup_care_plans_rls.sql against the project.');
    }
    return null;
  }

  const plan = firstRow<CarePlan>(data);
  const planId = plan?.id;
  if (!plan || !planId) {
    console.error('CARE PLAN SAVE ERROR:', 'No plan id returned', null);
    return null;
  }

  // Step C: attach the captured plan_id to every task and insert as one batch.
  const taskPayload = payload.tasks.map((task) => ({
    plan_id: planId,
    task_name: task.task_name,
    task_type: task.task_type,
    frequency: task.frequency,
    duration_value: task.duration_value,
    // duration_unit is a plain string ('day' | 'week'), never an object.
    duration_unit: String(task.duration_unit),
  }));

  console.log('Task Payload:', taskPayload);

  let taskResponse = await supabase.from('care_plan_tasks').insert(taskPayload);

  // The older care-plan schema spells the same columns instruction /
  // metric_type / goal_count / goal_unit. Retry with those instead of failing
  // when duration_unit (or another client column) is absent.
  if (taskResponse.error && schemaMismatch(taskResponse.error.code)) {
    const legacyPayload = payload.tasks.map((task) => ({
      plan_id: planId,
      instruction: task.task_name,
      metric_type: task.task_type,
      frequency: task.frequency,
      goal_count: task.duration_value,
      goal_unit: String(task.duration_unit),
    }));
    console.log('Task Payload (legacy):', legacyPayload);
    taskResponse = await supabase.from('care_plan_tasks').insert(legacyPayload);
  }

  // Last resort: the live schema has the modern columns but no duration_unit.
  // Save the task without the unit; reads treat a missing unit as 'day'.
  if (taskResponse.error && schemaMismatch(taskResponse.error.code)) {
    const withoutUnit = payload.tasks.map((task) => ({
      plan_id: planId,
      task_name: task.task_name,
      task_type: task.task_type,
      frequency: task.frequency,
      duration_value: task.duration_value,
    }));
    console.log('Task Payload (no duration_unit):', withoutUnit);
    taskResponse = await supabase.from('care_plan_tasks').insert(withoutUnit);
  }

  const { error: taskError } = taskResponse;

  if (taskError) {
    console.error('CARE PLAN SAVE ERROR:', taskError.message, taskError.details);
    // Compensate for the two-step write so a failed task batch does not leave
    // an orphan plan. The care_plans_delete_author policy permits this.
    const { error: cleanupError } = await supabase
      .from('care_plans')
      .delete()
      .eq('id', planId)
      .eq('doctor_id', payload.doctorId);
    if (cleanupError) {
      console.error('CARE PLAN CLEANUP ERROR:', cleanupError.message, cleanupError.details);
    }
    return null;
  }

  return plan;
};

/** Log (or correct) one task for today. Upsert on (task_id, log_date). */
export const logTask = async (payload: {
  taskId: string;
  patientId: string;
  valueNumber?: number | null;
  valueBoolean?: boolean | null;
}): Promise<CarePlanLog | null> => {
  const today = dayKey(new Date(), 'logTask');
  if (!today) return null;

  const { data, error } = await supabase
    .from('care_plan_logs')
    .upsert(
      {
        task_id: payload.taskId,
        patient_id: payload.patientId,
        log_date: today,
        value_number: payload.valueNumber ?? null,
        value_boolean: payload.valueBoolean ?? null,
      },
      { onConflict: 'task_id,log_date' },
    )
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('CARE ERROR:', error.message);
    return null;
  }
  return firstRow<CarePlanLog>(data);
};

// ---------------------------------------------------------------------------
// Provider → patients (no assignment table; derived from what already exists)
// ---------------------------------------------------------------------------

/** The counterpart ids this provider already has a relationship with. */
export const listKnownPatients = async (providerId: string): Promise<PersonInfo[]> => {
  if (!providerId) return [];
  const ids = new Set<string>();

  // 1) Appointment counterparts (the patient side of the provider's bookings).
  const readAppointments = (column: 'provider_id' | 'host_id') =>
    supabase.from('appointments').select('patient_id').eq(column, providerId);

  let { data: appts, error: apptError } = await readAppointments('provider_id');
  if (apptError && schemaMismatch(apptError.code)) {
    ({ data: appts, error: apptError } = await readAppointments('host_id'));
  }
  if (!apptError) {
    for (const row of asRows<{ patient_id: string | null }>(appts)) {
      if (row.patient_id) ids.add(row.patient_id);
    }
  }

  // 2) Chat counterparts whose role snapshot is a patient.
  const { data: mine } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', providerId);

  const conversationIds = [
    ...new Set(asRows<{ conversation_id: string }>(mine).map((row) => row.conversation_id)),
  ];
  if (conversationIds.length > 0) {
    const { data: others } = await supabase
      .from('conversation_participants')
      .select('user_id, role')
      .in('conversation_id', conversationIds)
      .neq('user_id', providerId)
      .eq('role', 'patient');
    for (const row of asRows<{ user_id: string }>(others)) {
      if (row.user_id) ids.add(row.user_id);
    }
  }

  if (ids.size === 0) return [];
  const people = await loadPeople([...ids]);
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
};

// ---------------------------------------------------------------------------
// Derived state — due-today + compliance (pure, no Supabase)
// ---------------------------------------------------------------------------

/** The local week's start (00:00), respecting the locale's first day. */
const weekStart = (now: Date, locale: string): Date | null => {
  const day = startOfDay(now, 'carePlans');
  if (!day) return null;
  const first = weekStartsOn(locale);
  const diff = (day.getDay() - first + 7) % 7;
  return addDays(day, -diff);
};

/** The 7 `YYYY-MM-DD` keys of the week containing `now`. */
const weekDayKeys = (now: Date, locale: string): string[] => {
  const start = weekStart(now, locale);
  if (!start) return [];
  return Array.from({ length: 7 }, (_, index) => dayKey(addDays(start, index), 'carePlans'));
};

/** Has this task been logged inside the week containing `now`? */
const loggedThisWeek = (
  task: CarePlanTask,
  logs: CarePlanLog[],
  locale: string,
  now: Date,
): boolean => {
  const keys = new Set(weekDayKeys(now, locale));
  return logs.some((log) => log.task_id === task.id && keys.has(log.log_date));
};

/**
 * A task is due today when it is daily, or — for a weekly task — it has not yet
 * been logged this week (so it stays visible until it is done).
 */
export const isDueToday = (
  task: CarePlanTask,
  logs: CarePlanLog[],
  locale: string,
  now: Date = new Date(),
): boolean => {
  if (task.frequency === 'daily') return true;
  return !loggedThisWeek(task, logs, locale, now);
};

export type Compliance = { done: number; target: number; unit: GoalUnit };

/**
 * The "Task completed 4/7 days this week" metric.
 *   duration_unit 'day'  → distinct days logged this week vs. the day target.
 *   duration_unit 'week' → how many of the last N weeks (including this one) had
 *                      at least one log, vs. the week target.
 */
export const complianceForTask = (
  task: CarePlanTask,
  logs: CarePlanLog[],
  locale: string,
  now: Date = new Date(),
): Compliance => {
  const mine = logs.filter((log) => log.task_id === task.id);

  if (task.duration_unit === 'week') {
    const target = Math.max(1, task.duration_value);
    const start = weekStart(now, locale);
    if (!start) return { done: 0, target, unit: 'week' };

    let done = 0;
    for (let index = 0; index < target; index += 1) {
      const weekStartDate = addDays(start, -index * 7);
      const keys = new Set(
        Array.from({ length: 7 }, (_, offset) =>
          dayKey(addDays(weekStartDate, offset), 'carePlans'),
        ),
      );
      if (mine.some((log) => keys.has(log.log_date))) done += 1;
    }
    return { done, target, unit: 'week' };
  }

  const target = Math.min(7, Math.max(1, task.duration_value));
  const keys = new Set(weekDayKeys(now, locale));
  const done = new Set(
    mine.filter((log) => keys.has(log.log_date)).map((log) => log.log_date),
  ).size;
  return { done, target, unit: 'day' };
};

/** The `YYYY-MM-DD` a log's date parses to (null when malformed). */
export const logDay = (log: CarePlanLog): string =>
  parseDate(`${log.log_date}T00:00:00`, 'carePlans') ? log.log_date : '';
