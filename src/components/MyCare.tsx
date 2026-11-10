import { useCallback, useEffect, useState } from 'react';
import { Lock, Pencil, Plus, Trash2, Unlock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { useToast } from '../context/ToastContext';
import {
  deleteCarePlan,
  loadPlansForPatient,
  loadTasksForPlans,
  setCarePlanLocked,
  type CarePlan,
  type CarePlanTask,
} from '../lib/carePlans';
import CareChecklist from './CareChecklist';
import CreateCarePlanModal from './CreateCarePlanModal';
import SlimButton from './ui/SlimButton';

// ---------------------------------------------------------------------------
// #care — the patient's own Care Plans. Plan management (lock / edit / delete)
// sits above the daily checklist; every request re-reads the persisted rows.
// ---------------------------------------------------------------------------

type EditingPlan = { plan: CarePlan; tasks: CarePlanTask[] } | null;

export default function MyCare() {
  const { user } = useAuth();
  const { t } = useLang();
  const { notify } = useToast();

  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [tasks, setTasks] = useState<CarePlanTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EditingPlan>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const nextPlans = await loadPlansForPatient(user.id);
      const nextTasks = await loadTasksForPlans(nextPlans.map((plan) => plan.id));
      setPlans(nextPlans);
      setTasks(nextTasks);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setRefreshKey((key) => key + 1);
    void load();
  };

  const toggleLock = async (plan: CarePlan) => {
    if (busyId) return;
    setBusyId(plan.id);
    const nextLocked = plan.locked !== true;
    try {
      const ok = await setCarePlanLocked(plan.id, nextLocked);
      if (!ok) {
        notify(t('care.saveFailed'), 'error');
        return;
      }
      refresh();
    } finally {
      setBusyId(null);
    }
  };

  const removePlan = async (plan: CarePlan) => {
    if (busyId || plan.locked === true) return;
    if (!window.confirm(t('care.confirmDelete'))) return;
    setBusyId(plan.id);
    try {
      const ok = await deleteCarePlan(plan.id);
      if (!ok) {
        notify(t('care.saveFailed'), 'error');
        return;
      }
      refresh();
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (plan: CarePlan) => {
    if (plan.locked === true) return;
    setEditing({
      plan,
      tasks: tasks.filter((task) => task.plan_id === plan.id),
    });
  };

  if (!user) return null;

  return (
    <section className="section">
      <div className="panel care-compact">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            marginBlockEnd: '0.75rem',
          }}
        >
          <div className="eyebrow" style={{ margin: 0 }}>{t('care.myCare')}</div>
          <SlimButton variant="primary" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" /> {t('care.createPlan')}
          </SlimButton>
        </div>

        {loading ? (
          <p className="care-muted" aria-busy="true">{t('places.searching')}</p>
        ) : plans.length === 0 ? (
          <p className="care-muted panel-empty">{t('care.noPlans')}</p>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {plans.map((plan) => {
              const locked = plan.locked === true;
              const count = tasks.filter((task) => task.plan_id === plan.id).length;
              return (
                <div key={plan.id} className="care-plan-card">
                  <div className="care-plan-card-head">
                    <div>
                      <p className="care-plan-card-title">{plan.title}</p>
                      <span className="care-plan-card-meta">
                        {t('care.taskCount', { count })}
                      </span>
                    </div>

                    <div className="care-plan-card-actions">
                      {locked ? (
                        <span className="care-lock-badge">
                          <Lock size={12} aria-hidden="true" /> {t('care.locked')}
                        </span>
                      ) : null}

                      <button
                        type="button"
                        className="care-plan-icon-btn"
                        title={locked ? t('care.unlock') : t('care.lock')}
                        aria-label={locked ? t('care.unlock') : t('care.lock')}
                        disabled={busyId === plan.id}
                        onClick={() => void toggleLock(plan)}
                      >
                        {locked ? <Unlock size={15} aria-hidden="true" /> : <Lock size={15} aria-hidden="true" />}
                      </button>

                      <button
                        type="button"
                        className="care-plan-icon-btn"
                        title={t('care.editPlan')}
                        aria-label={t('care.editPlan')}
                        disabled={locked || busyId === plan.id}
                        onClick={() => openEdit(plan)}
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        className="care-plan-icon-btn is-danger"
                        title={t('care.deletePlan')}
                        aria-label={t('care.deletePlan')}
                        disabled={locked || busyId === plan.id}
                        onClick={() => void removePlan(plan)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel care-compact" style={{ marginBlockStart: '16px' }}>
        <div className="eyebrow">{t('care.todaysChecklist')}</div>
        <CareChecklist key={refreshKey} patientId={user.id} />
      </div>

      {creating ? (
        <CreateCarePlanModal
          patientId={user.id}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      ) : null}

      {editing ? (
        <CreateCarePlanModal
          patientId={user.id}
          plan={editing.plan}
          initialTasks={editing.tasks}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </section>
  );
}
