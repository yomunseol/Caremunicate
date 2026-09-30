import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Plus } from 'lucide-react';
import { useLang } from '../i18n';
import CreateCarePlanModal from './CreateCarePlanModal';
import { dayKey } from '../lib/time';
import {
  complianceForTask,
  loadLogs,
  loadPlansForPatient,
  loadTasksForPlans,
  type CarePlan,
  type CarePlanLog,
  type CarePlanTask,
} from '../lib/carePlans';

// ---------------------------------------------------------------------------
// The doctor's Care Plans tab: the active plan summary and each task's
// compliance ("Task completed 4/7 days this week").
// ---------------------------------------------------------------------------

type CarePlanPanelProps = {
  patientId: string;
};

const EIGHT_WEEKS_MS = 56 * 86_400_000;

export default function CarePlanPanel({ patientId }: CarePlanPanelProps) {
  const { t, locale } = useLang();

  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [tasks, setTasks] = useState<CarePlanTask[]>([]);
  const [logs, setLogs] = useState<CarePlanLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    try {
      const nextPlans = await loadPlansForPatient(patientId);
      const nextTasks = await loadTasksForPlans(nextPlans.map((plan) => plan.id));
      const since = dayKey(new Date(Date.now() - EIGHT_WEEKS_MS), 'carePlanPanel');
      const nextLogs = await loadLogs(patientId, since);
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

  return (
    <div style={styles.wrap}>
      <button type="button" className="primary-button" style={styles.create} onClick={() => setCreating(true)}>
        <Plus size={15} aria-hidden="true" /> {t('care.createPlan')}
      </button>

      {loading ? (
        <p className="care-muted" aria-busy="true">{t('places.searching')}</p>
      ) : plans.length === 0 ? (
        <p className="care-muted">{t('care.noPlans')}</p>
      ) : (
        plans.map((plan) => {
          const planTasks = tasks.filter((task) => task.plan_id === plan.id);
          return (
            <div key={plan.id} className="panel">
              <div className="eyebrow" style={{ margin: 0 }}>{plan.title}</div>
              <ul className="care-list" style={styles.list}>
                {planTasks.map((task) => {
                  const compliance = complianceForTask(task, logs, locale);
                  const pct = Math.min(100, Math.round((compliance.done / compliance.target) * 100));
                  return (
                    <li key={task.id} className="care-task is-summary">
                      <span style={styles.instruction}>{task.instruction}</span>
                      <span style={styles.sentence}>
                        {t('care.compliance', {
                          done: compliance.done,
                          target: compliance.target,
                          unit: t(compliance.unit === 'week' ? 'care.goalWeeks' : 'care.goalDays'),
                        })}
                      </span>
                      <span className="care-progress" aria-hidden="true">
                        <span className="care-progress-fill" style={{ inlineSize: `${pct}%` }} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}

      {creating ? (
        <CreateCarePlanModal
          patientId={patientId}
          onClose={() => setCreating(false)}
          onCreated={() => void load()}
        />
      ) : null}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'grid', gap: '1rem' },
  create: { justifySelf: 'start' },
  list: { display: 'grid', gap: '0.6rem', marginBlockStart: '0.6rem' },
  instruction: { fontWeight: 700, overflowWrap: 'anywhere' },
  sentence: { color: 'var(--accent-strong, #216e5d)', fontSize: '0.82rem', fontWeight: 700 },
};
