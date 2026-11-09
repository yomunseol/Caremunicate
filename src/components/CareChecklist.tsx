import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { useLang } from '../i18n';
import { useToast } from '../context/ToastContext';
import { describeError } from '../lib/errors';
import { dayKey } from '../lib/time';
import {
  checkOffTask,
  loadPlansForPatient,
  loadTaskLogsForWeek,
  loadTasksForPlans,
  logTask,
  logTaskValue,
  type CarePlan,
  type CarePlanTask,
  type TaskLogRow,
} from '../lib/carePlans';
import SlimButton from './ui/SlimButton';
import TaskLogModal from './TaskLogModal';

// ---------------------------------------------------------------------------
// The patient checklist — shared by the #care page and the dashboard widget.
//
// The checkbox checks the task off for today (last_completed_date) and, on the
// dashboard, removes it until tomorrow. "Log" opens a value + note dialog that
// writes to task_logs. The weekly counter reads task_logs (Monday–Sunday) and
// increments optimistically the moment a check-off is written.
// ---------------------------------------------------------------------------

type CareChecklistProps = {
  patientId: string;
  /** Only the tasks due today (the dashboard widget); default: every task. */
  onlyToday?: boolean;
};

const todayKey = (): string => dayKey(new Date(), 'careChecklist');

/** Monday 00:00:00 → Sunday 23:59:59 of the current local week. */
const currentWeekRange = (): { from: string; to: string } => {
  const now = new Date();
  const daysSinceMonday = (now.getDay() + 6) % 7;
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysSinceMonday,
    0,
    0,
    0,
    0,
  );
  const sunday = new Date(monday.getTime() + 7 * 86_400_000 - 1);
  return { from: monday.toISOString(), to: sunday.toISOString() };
};

/** Local YYYY-MM-DD for a timestamptz (the day a log counts toward). */
const localDayOf = (iso: string): string => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
};

export default function CareChecklist({ patientId, onlyToday = false }: CareChecklistProps) {
  const { t } = useLang();
  const { notify } = useToast();

  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [tasks, setTasks] = useState<CarePlanTask[]>([]);
  const [taskLogs, setTaskLogs] = useState<TaskLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [logTarget, setLogTarget] = useState<CarePlanTask | null>(null);

  const today = todayKey();
  const week = useMemo(() => currentWeekRange(), [today]);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    try {
      const nextPlans = await loadPlansForPatient(patientId);
      const nextTasks = await loadTasksForPlans(
        nextPlans.map((plan) => plan.id),
        onlyToday ? { dueOnly: true, today } : undefined,
      );
      const nextLogs = await loadTaskLogsForWeek(patientId, week.from, week.to);
      setPlans(nextPlans);
      setTasks(nextTasks);
      setTaskLogs(nextLogs);
    } finally {
      setLoading(false);
    }
  }, [patientId, onlyToday, today, week.from, week.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const dueTasks = useMemo(
    () => (onlyToday ? tasks.filter((task) => task.last_completed_date !== today) : tasks),
    [onlyToday, tasks, today],
  );

  const isDone = useCallback(
    (task: CarePlanTask) => task.last_completed_date === today,
    [today],
  );

  /** Distinct local days with a task_logs row this week. */
  const weeklyCount = useCallback(
    (taskId: string): number =>
      new Set(
        taskLogs.filter((row) => row.task_id === taskId).map((row) => localDayOf(row.created_at)),
      ).size,
    [taskLogs],
  );

  /** Keep care_plan_logs in sync for the provider compliance panel. */
  const recordCompliance = useCallback(
    async (task: CarePlanTask, value: string) => {
      const numeric = Number(value);
      await logTask({
        taskId: task.id,
        patientId,
        valueBoolean:
          task.task_type === 'boolean' ? /^(1|true|yes|y|done)$/i.test(value.trim()) : null,
        valueNumber: task.task_type === 'number' && Number.isFinite(numeric) ? numeric : null,
      });
    },
    [patientId],
  );

  const addOptimisticLog = useCallback((task: CarePlanTask): string => {
    const id = `optimistic-${task.id}-${today}`;
    setTaskLogs((previous) => [
      ...previous,
      { id, task_id: task.id, created_at: new Date().toISOString() },
    ]);
    return id;
  }, [today]);

  const dropLog = useCallback((id: string) => {
    setTaskLogs((previous) => previous.filter((row) => row.id !== id));
  }, []);

  const markDoneLocally = (task: CarePlanTask) => {
    if (onlyToday) {
      setTasks((current) => current.filter((item) => item.id !== task.id));
    } else {
      setTasks((current) =>
        current.map((item) =>
          item.id === task.id ? { ...item, last_completed_date: today } : item,
        ),
      );
    }
  };

  const checkoff = async (task: CarePlanTask) => {
    if (savingId || isDone(task)) return;
    setSavingId(task.id);
    const previousTasks = tasks;

    // Optimistic: mark done and bump the weekly counter immediately.
    markDoneLocally(task);
    const hasLogToday = taskLogs.some(
      (row) => row.task_id === task.id && localDayOf(row.created_at) === today,
    );
    const optimisticId = hasLogToday ? null : addOptimisticLog(task);

    try {
      const ok = await checkOffTask(task.id, today);
      if (!ok) {
        setTasks(previousTasks);
        if (optimisticId) dropLog(optimisticId);
        notify(t('care.checkoffFailed'), 'error');
        return;
      }

      if (!hasLogToday) {
        const logged = await logTaskValue({ taskId: task.id, userId: patientId, value: 'done' });
        if (!logged && optimisticId) dropLog(optimisticId);
      }
      if (task.task_type === 'boolean') {
        await recordCompliance(task, 'true');
      }
      notify(t('care.checkedOff'), 'success');
    } catch (error) {
      setTasks(previousTasks);
      if (optimisticId) dropLog(optimisticId);
      console.error('CARE ERROR:', error);
      notify(describeError(error), 'error');
    } finally {
      setSavingId(null);
    }
  };

  const submitLog = async (task: CarePlanTask, value: string, note: string): Promise<boolean> => {
    try {
      const saved = await logTaskValue({ taskId: task.id, userId: patientId, value, note });
      if (!saved) {
        notify(t('care.logFailed'), 'error');
        return false;
      }

      const hasLogToday = taskLogs.some(
        (row) => row.task_id === task.id && localDayOf(row.created_at) === today,
      );
      if (!hasLogToday) addOptimisticLog(task);

      await recordCompliance(task, value);
      await checkOffTask(task.id, today);
      markDoneLocally(task);
      notify(t('care.logged'), 'success');
      return true;
    } catch (error) {
      console.error('CARE ERROR:', error);
      notify(describeError(error), 'error');
      return false;
    }
  };

  if (loading) {
    return <p className="care-muted" aria-busy="true">{t('places.searching')}</p>;
  }

  if (plans.length === 0) {
    return <p className="care-muted">{t('care.noPlans')}</p>;
  }

  if (onlyToday && dueTasks.length === 0) {
    return <p className="care-muted">{t('care.nothingDue')}</p>;
  }

  return (
    <div style={styles.wrap}>
      {plans.map((plan) => {
        const planTasks = dueTasks.filter((task) => task.plan_id === plan.id);
        if (planTasks.length === 0) return null;
        return (
          <div key={plan.id} style={styles.plan}>
            <span className="eyebrow" style={styles.planTitle}>{plan.title}</span>
            <ul className="care-list">
              {planTasks.map((task) => {
                const done = isDone(task);
                return (
                  <li key={task.id} className={done ? 'care-task is-done' : 'care-task'}>
                    <span style={styles.instruction}>{task.task_name}</span>

                    <label style={styles.control}>
                      <input
                        type="checkbox"
                        checked={done}
                        disabled={savingId === task.id || done}
                        aria-label={task.task_name}
                        onChange={(event) => {
                          if (event.target.checked) void checkoff(task);
                        }}
                      />
                    </label>

                    <SlimButton
                      variant="secondary"
                      disabled={savingId === task.id}
                      onClick={() => setLogTarget(task)}
                    >
                      {done ? <Check size={14} aria-hidden="true" /> : null}
                      {t('care.submit')}
                    </SlimButton>

                    <span style={styles.compliance}>
                      {t('care.compliance', {
                        done: weeklyCount(task.id),
                        target: 7,
                        unit: t('care.goalDays'),
                      })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      {logTarget ? (
        <TaskLogModal
          task={logTarget}
          onClose={() => setLogTarget(null)}
          onSubmit={(value, note) => submitLog(logTarget, value, note)}
        />
      ) : null}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'grid', gap: '0.75rem' },
  plan: { display: 'grid', gap: '0.4rem' },
  planTitle: { margin: 0 },
  instruction: { fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' },
  control: { display: 'inline-flex', alignItems: 'center' },
  compliance: {
    gridColumn: '1 / -1',
    color: 'var(--text-muted, #557b76)',
    fontSize: '0.72rem',
  },
};
