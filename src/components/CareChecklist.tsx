import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { useLang } from '../i18n';
import { useToast } from '../context/ToastContext';
import { describeError } from '../lib/errors';
import { dayKey } from '../lib/time';
import {
  complianceForTask,
  isDueToday,
  loadLogs,
  loadPlansForPatient,
  loadTasksForPlans,
  logTask,
  type CarePlan,
  type CarePlanLog,
  type CarePlanTask,
} from '../lib/carePlans';

// ---------------------------------------------------------------------------
// The patient checklist — shared by the #care page and the dashboard widget.
//
// Loads the patient's active plans/tasks + this week's logs, renders one row per
// task (a checkbox for boolean, a number input for number) and writes a
// care_plan_logs row on submit, ticking the row without a full refetch.
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const today = todayKey();

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    try {
      const nextPlans = await loadPlansForPatient(patientId);
      const nextTasks = await loadTasksForPlans(nextPlans.map((plan) => plan.id));
      const weekAgo = dayKey(new Date(Date.now() - 7 * 86_400_000), 'careChecklist');
      const nextLogs = await loadLogs(patientId, weekAgo);
      setPlans(nextPlans);
      setTasks(nextTasks);
      setLogs(nextLogs);
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The log for a task today, if any. */
  const loggedToday = useCallback(
    (taskId: string): CarePlanLog | undefined =>
      logs.find((log) => log.task_id === taskId && log.log_date === today),
    [logs, today],
  );

  const dueTasks = useMemo(
    () => (onlyToday ? tasks.filter((task) => isDueToday(task, logs, locale)) : tasks),
    [onlyToday, tasks, logs, locale],
  );

  const submit = async (task: CarePlanTask) => {
    if (savingId) return;
    setSavingId(task.id);
    try {
      const existing = loggedToday(task.id);
      const raw = drafts[task.id] ?? '';
      const valueBoolean = task.metric_type === 'boolean' ? raw === 'true' : null;
      const valueNumber =
        task.metric_type === 'number' ? Number(raw === '' ? existing?.value_number ?? 0 : raw) : null;

      const saved = await logTask({
        taskId: task.id,
        patientId,
        valueBoolean,
        valueNumber,
      });
      if (!saved) {
        notify(t('care.saveFailed'), 'error');
        return;
      }
      setLogs((previous) => [
        ...previous.filter((log) => !(log.task_id === task.id && log.log_date === saved.log_date)),
        saved,
      ]);
      notify(t('care.logged'), 'success');
    } catch (error) {
      console.error('CARE ERROR:', error);
      notify(describeError(error), 'error');
    } finally {
      setSavingId(null);
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
                const done = loggedToday(task.id);
                const compliance = complianceForTask(task, logs, locale);
                const draft =
                  drafts[task.id] ??
                  (task.metric_type === 'boolean'
                    ? done?.value_boolean
                      ? 'true'
                      : 'false'
                    : done?.value_number !== undefined && done?.value_number !== null
                      ? String(done.value_number)
                      : '');
                return (
                  <li key={task.id} className={done ? 'care-task is-done' : 'care-task'}>
                    <span style={styles.instruction}>{task.instruction}</span>

                    {task.metric_type === 'boolean' ? (
                      <label style={styles.control}>
                        <input
                          type="checkbox"
                          checked={draft === 'true'}
                          disabled={savingId === task.id}
                          aria-label={task.instruction}
                          onChange={(event) =>
                            setDrafts((previous) => ({
                              ...previous,
                              [task.id]: event.target.checked ? 'true' : 'false',
                            }))
                          }
                        />
                      </label>
                    ) : (
                      <label style={styles.control}>
                        <input
                          className="input care-number"
                          type="number"
                          inputMode="decimal"
                          value={draft}
                          disabled={savingId === task.id}
                          aria-label={task.instruction}
                          onChange={(event) =>
                            setDrafts((previous) => ({ ...previous, [task.id]: event.target.value }))
                          }
                        />
                      </label>
                    )}

                    <button
                      type="button"
                      className="primary-button care-log"
                      disabled={savingId === task.id}
                      aria-busy={savingId === task.id}
                      onClick={() => void submit(task)}
                    >
                      {done ? <Check size={15} aria-hidden="true" /> : null}
                      {t('care.submit')}
                    </button>

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
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'grid', gap: '1rem' },
  plan: { display: 'grid', gap: '0.5rem' },
  planTitle: { margin: 0 },
  instruction: { fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' },
  control: { display: 'inline-flex', alignItems: 'center' },
  compliance: { color: 'var(--text-muted, #557b76)', fontSize: '0.76rem' },
};
