import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { useLang } from '../i18n';
import { useToast } from '../context/ToastContext';
import { describeError } from '../lib/errors';
import { dayKey } from '../lib/time';
import {
  checkOffTask,
  complianceForTask,
  loadLogs,
  loadPlansForPatient,
  loadTasksForPlans,
  logTask,
  logTaskValue,
  type CarePlan,
  type CarePlanLog,
  type CarePlanTask,
} from '../lib/carePlans';
import SlimButton from './ui/SlimButton';
import TaskLogModal from './TaskLogModal';

// ---------------------------------------------------------------------------
// The patient checklist — shared by the #care page and the dashboard widget.
//
// A checkbox checks the task off for today (last_completed_date) and removes
// it from the list until tomorrow. "Log" opens a value + note dialog that
// writes to task_logs and also records the value for compliance.
// ---------------------------------------------------------------------------

type CareChecklistProps = {
  patientId: string;
  /** Only the tasks due today (the dashboard widget); default: every task. */
  onlyToday?: boolean;
};

const todayKey = (): string => dayKey(new Date(), 'careChecklist');

export default function CareChecklist({ patientId, onlyToday = false }: CareChecklistProps) {
  const { t, locale } = useLang();
  const { notify } = useToast();

  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [tasks, setTasks] = useState<CarePlanTask[]>([]);
  const [logs, setLogs] = useState<CarePlanLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [logTarget, setLogTarget] = useState<CarePlanTask | null>(null);

  const today = todayKey();

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    try {
      const nextPlans = await loadPlansForPatient(patientId);
      const nextTasks = await loadTasksForPlans(
        nextPlans.map((plan) => plan.id),
        onlyToday ? { dueOnly: true, today } : undefined,
      );
      const weekAgo = dayKey(new Date(Date.now() - 7 * 86_400_000), 'careChecklist');
      const nextLogs = await loadLogs(patientId, weekAgo);
      setPlans(nextPlans);
      setTasks(nextTasks);
      setLogs(nextLogs);
    } finally {
      setLoading(false);
    }
  }, [patientId, onlyToday, today]);

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

  const recordCompliance = useCallback(
    async (task: CarePlanTask, value: string) => {
      const numeric = Number(value);
      const saved = await logTask({
        taskId: task.id,
        patientId,
        valueBoolean:
          task.task_type === 'boolean' ? /^(1|true|yes|y|done)$/i.test(value.trim()) : null,
        valueNumber: task.task_type === 'number' && Number.isFinite(numeric) ? numeric : null,
      });
      if (!saved) return;
      setLogs((previous) => [
        ...previous.filter(
          (log) => !(log.task_id === task.id && log.log_date === saved.log_date),
        ),
        saved,
      ]);
    },
    [patientId],
  );

  const checkoff = async (task: CarePlanTask) => {
    if (savingId || isDone(task)) return;
    setSavingId(task.id);
    const previous = tasks;
    setTasks((current) => current.filter((item) => item.id !== task.id));
    try {
      const ok = await checkOffTask(task.id, today);
      if (!ok) {
        setTasks(previous);
        notify(t('care.checkoffFailed'), 'error');
        return;
      }
      if (task.task_type === 'boolean') {
        await recordCompliance(task, 'true');
      }
      notify(t('care.checkedOff'), 'success');
    } catch (error) {
      setTasks(previous);
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
      await recordCompliance(task, value);
      await checkOffTask(task.id, today);
      setTasks((current) => current.filter((item) => item.id !== task.id));
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
                const compliance = complianceForTask(task, logs, locale);
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
                        done: compliance.done,
                        target: compliance.target,
                        unit: t(compliance.unit === 'week' ? 'care.goalWeeks' : 'care.goalDays'),
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
