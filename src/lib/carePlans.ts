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
  provider_id: string;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
};

export type CarePlanTask = {
  id: string;
  plan_id: string;
  instruction: string;
  metric_type: MetricType;
  frequency: Frequency;
  goal_count: number;
  goal_unit: GoalUnit;
  position: number;
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
  instruction: string;
  metric_type: MetricType;
  frequency: Frequency;
  goal_count: number;
  goal_unit: GoalUnit;
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
    .eq('status', 'active')
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
    .order('position', { ascending: true });

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

/** Atomic plan + tasks creation (the SECURITY DEFINER RPC owns the write). */
export const createCarePlan = async (payload: {
  patientId: string;
  title: string;
  tasks: NewTask[];
}): Promise<CarePlan | null> => {
  const { data, error } = await supabase.rpc('create_care_plan', {
    p_patient: payload.patientId,
    p_title: payload.title,
    p_tasks: payload.tasks,
  });

  if (error) {
    console.error('CARE ERROR:', error.message);
    return null;
  }
  return firstRow<CarePlan>(data);
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
 *   goal_unit 'day'  → distinct days logged this week vs. the day target.
 *   goal_unit 'week' → how many of the last N weeks (including this one) had
 *                      at least one log, vs. the week target.
 */
export const complianceForTask = (
  task: CarePlanTask,
  logs: CarePlanLog[],
  locale: string,
  now: Date = new Date(),
): Compliance => {
  const mine = logs.filter((log) => log.task_id === task.id);

  if (task.goal_unit === 'week') {
    const target = Math.max(1, task.goal_count);
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

  const target = Math.min(7, Math.max(1, task.goal_count));
  const keys = new Set(weekDayKeys(now, locale));
  const done = new Set(
    mine.filter((log) => keys.has(log.log_date)).map((log) => log.log_date),
  ).size;
  return { done, target, unit: 'day' };
};

/** The `YYYY-MM-DD` a log's date parses to (null when malformed). */
export const logDay = (log: CarePlanLog): string =>
  parseDate(`${log.log_date}T00:00:00`, 'carePlans') ? log.log_date : '';
