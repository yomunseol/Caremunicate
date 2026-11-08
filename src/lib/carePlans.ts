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
  locked?: boolean;
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
  last_completed_date?: string | null;
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

export const loadTasksForPlans = async (
  planIds: string[],
  options?: { dueOnly?: boolean; today?: string },
): Promise<CarePlanTask[]> => {
  const ids = [...new Set(planIds.filter(Boolean))];
  if (ids.length === 0) return [];

  const read = (dueOnly: boolean) => {
    let query = supabase.from('care_plan_tasks').select('*').in('plan_id', ids);
    if (dueOnly && options?.today) {
      query = query.or(`last_completed_date.is.null,last_completed_date.lt.${options.today}`);
    }
    return query.order('created_at', { ascending: true });
  };

  let { data, error } = await read(Boolean(options?.dueOnly));

  // last_completed_date may not exist yet — fall back to the full list.
  if (error && schemaMismatch(error.code) && options?.dueOnly) {
    ({ data, error } = await read(false));
  }

  if (error) {
    console.error('CARE ERROR:', error.message);
    return [];
  }

  // The live schema stores instruction / metric_type. Normalize both spellings
  // so the checklist and compliance logic keep their task_name / task_type view.
  return asRows<Record<string, unknown>>(data).map((row) => {
    const metric = String(row.task_type ?? row.metric_type ?? 'boolean').toLowerCase();
    const unitRaw = String(row.duration_unit ?? row.goal_unit ?? 'day').toLowerCase();
    return {
      id: String(row.id ?? ''),
      plan_id: String(row.plan_id ?? ''),
      task_name: String(row.task_name ?? row.instruction ?? ''),
      task_type: metric === 'number' ? 'number' : 'boolean',
      frequency: String(row.frequency ?? 'daily').toLowerCase() === 'weekly' ? 'weekly' : 'daily',
      duration_value: Number.parseInt(String(row.duration_value ?? row.goal_count ?? 7), 10) || 1,
      duration_unit: unitRaw === 'week' || unitRaw === 'weeks' ? 'week' : 'day',
      last_completed_date: row.last_completed_date ? String(row.last_completed_date) : null,
    } as CarePlanTask;
  });
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

/** duration_value / goal_count must reach Postgres as an integer. */
const positiveInt = (value: number): number => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

/** Insert a task batch against whichever care_plan_tasks schema is live. */
const insertPlanTasks = async (planId: string, tasks: NewTask[]): Promise<string | null> => {
  const taskPayload = tasks.map((task) => ({
    plan_id: planId,
    instruction: task.task_name,
    metric_type: task.task_type,
    frequency: task.frequency,
    duration_value: positiveInt(task.duration_value),
    // duration_unit is a lowercase plain string ('day' | 'week'), never an object.
    duration_unit: String(task.duration_unit).toLowerCase(),
  }));

  console.log('Task Payload:', taskPayload);

  let response = await supabase.from('care_plan_tasks').insert(taskPayload);

  // Some deployments only carry the legacy goal_count / goal_unit columns.
  if (response.error && schemaMismatch(response.error.code)) {
    const goalPayload = tasks.map((task) => ({
      plan_id: planId,
      instruction: task.task_name,
      metric_type: task.task_type,
      frequency: task.frequency,
      goal_count: positiveInt(task.duration_value),
      goal_unit: String(task.duration_unit).toLowerCase(),
    }));
    console.log('Task Payload (goal columns):', goalPayload);
    response = await supabase.from('care_plan_tasks').insert(goalPayload);
  }

  // Last resort: duration_unit is still missing. Reads default it to 'day'.
  if (response.error && schemaMismatch(response.error.code)) {
    const withoutUnit = tasks.map((task) => ({
      plan_id: planId,
      instruction: task.task_name,
      metric_type: task.task_type,
      frequency: task.frequency,
      duration_value: positiveInt(task.duration_value),
    }));
    console.log('Task Payload (no duration_unit):', withoutUnit);
    response = await supabase.from('care_plan_tasks').insert(withoutUnit);
  }

  if (response.error) {
    console.error('Care Plan Save Error:', response.error);
    return response.error.message;
  }
  return null;
};

export const createCarePlan = async (payload: {
  patientId: string;
  doctorId: string;
  userId: string;
  title: string;
  locked?: boolean;
  tasks: NewTask[];
}): Promise<CarePlan | null> => {
  // The insert policy keys on auth.uid() = user_id, so an empty/invalid id
  // would be rejected before the row is ever written.
  if (!UUID_PATTERN.test(payload.userId)) {
    console.error('CARE PLAN SAVE ERROR:', 'user_id is missing or not a UUID', payload.userId);
    return null;
  }

  // Step A: insert the plan. Step B: capture its id before touching the tasks.
  const basePlan: Record<string, unknown> = {
    patient_id: payload.patientId,
    doctor_id: payload.doctorId,
    title: payload.title,
  };

  const insertPayload: Record<string, unknown> = {
    ...basePlan,
    user_id: payload.userId,
    locked: Boolean(payload.locked),
  };
  console.log('Care Plan Payload:', insertPayload);

  let response = await supabase.from('care_plans').insert(insertPayload).select('*').single();

  // Drop optional columns the live schema has not added yet, one at a time.
  for (
    let attempt = 0;
    attempt < 2 && response.error && schemaMismatch(response.error.code);
    attempt += 1
  ) {
    const message = String(response.error.message ?? '');
    if (/user_id/i.test(message)) {
      delete insertPayload.user_id;
    } else if (/locked/i.test(message)) {
      delete insertPayload.locked;
    } else {
      break;
    }
    response = await supabase.from('care_plans').insert(insertPayload).select('*').single();
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

  // Step C: attach the captured plan_id to every task.
  const taskError = await insertPlanTasks(planId, payload.tasks);

  if (taskError) {
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

/** Update a plan's title/lock and replace its task list. */
export const updateCarePlan = async (payload: {
  planId: string;
  title: string;
  locked: boolean;
  tasks: NewTask[];
}): Promise<boolean> => {
  const { error: planError } = await supabase
    .from('care_plans')
    .update({ title: payload.title, locked: payload.locked })
    .eq('id', payload.planId);

  if (planError) {
    // Older schemas may not carry `locked`; save the title alone.
    if (schemaMismatch(planError.code) && /locked/i.test(planError.message ?? '')) {
      const { error: retryError } = await supabase
        .from('care_plans')
        .update({ title: payload.title })
        .eq('id', payload.planId);
      if (retryError) {
        console.error('CARE PLAN UPDATE ERROR:', retryError.message, retryError.details);
        return false;
      }
    } else {
      console.error('CARE PLAN UPDATE ERROR:', planError.message, planError.details);
      return false;
    }
  }

  const { error: clearError } = await supabase
    .from('care_plan_tasks')
    .delete()
    .eq('plan_id', payload.planId);
  if (clearError) {
    console.error('CARE PLAN TASK CLEAR ERROR:', clearError.message, clearError.details);
    return false;
  }

  return (await insertPlanTasks(payload.planId, payload.tasks)) === null;
};

export const deleteCarePlan = async (planId: string): Promise<boolean> => {
  const { error } = await supabase.from('care_plans').delete().eq('id', planId);
  if (error) {
    console.error('CARE PLAN DELETE ERROR:', error.message, error.details);
    return false;
  }
  return true;
};

/** Toggle the plan's lock without touching its tasks. */
export const setCarePlanLocked = async (planId: string, locked: boolean): Promise<boolean> => {
  const { error } = await supabase.from('care_plans').update({ locked }).eq('id', planId);
  if (error) {
    console.error('CARE PLAN LOCK ERROR:', error.message, error.details);
    return false;
  }
  return true;
};

/** Mark a task done for the given day; it reappears the next day. */
export const checkOffTask = async (taskId: string, today: string): Promise<boolean> => {
  const { error } = await supabase
    .from('care_plan_tasks')
    .update({ last_completed_date: today })
    .eq('id', taskId);
  if (error) {
    console.error('CARE CHECKOFF ERROR:', error.message, error.details);
    return false;
  }
  return true;
};

/** Append a value/note log to task_logs. */
export const logTaskValue = async (payload: {
  taskId: string;
  userId: string;
  value: string;
  note?: string;
}): Promise<boolean> => {
  const { error } = await supabase.from('task_logs').insert({
    task_id: payload.taskId,
    user_id: payload.userId,
    logged_value: payload.value,
    note: payload.note?.trim() ? payload.note.trim() : null,
  });
  if (error) {
    console.error('TASK LOG ERROR:', error.message, error.details);
    return false;
  }
  return true;
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
