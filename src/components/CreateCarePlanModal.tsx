import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { createCarePlan, type Frequency, type GoalUnit, type NewTask } from '../lib/carePlans';

// ---------------------------------------------------------------------------
// Create Care Plan — a portaled dialog (a `.panel` ancestor carries an
// animation transform that would otherwise trap a fixed child).
//
//   title + N task rows (task name · frequency · duration · delete)
//   Save → insert care_plans, then its care_plan_tasks rows.
// ---------------------------------------------------------------------------

type Row = NewTask;

const emptyRow = (): Row => ({
  task_name: '',
  task_type: 'boolean',
  frequency: 'daily',
  duration_value: 7,
  duration_unit: 'day',
});

type CreateCarePlanModalProps = {
  patientId: string;
  onClose: () => void;
  onCreated: () => void;
};

export default function CreateCarePlanModal({ patientId, onClose, onCreated }: CreateCarePlanModalProps) {
  const { t } = useLang();
  const { user } = useAuth();
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  const [title, setTitle] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Escape closes; body scroll is locked while open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const patch = (index: number, next: Partial<Row>) =>
    setRows((previous) => previous.map((row, i) => (i === index ? { ...row, ...next } : row)));

  const save = async () => {
    if (saving) return;
    if (!user) {
      console.error('Care Plan Save Error:', 'No authenticated user');
      setError('createFailed');
      return;
    }

    const tasks = rows
      .filter((row) => row.task_name.trim())
      .map((row) => ({ ...row, task_name: row.task_name.trim() }));

    if (!title.trim() || tasks.length === 0) {
      setError('invalid');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const plan = await createCarePlan({
        patientId,
        doctorId: user.id,
        title: title.trim(),
        tasks,
      });
      if (!plan) {
        setError('createFailed');
        return;
      }
      onCreated();
      onClose();
    } catch (saveError) {
      console.error('Care Plan Save Error:', saveError);
      setError('createFailed');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div style={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        ref={trapRef}
        className="care-plan-dialog"
        style={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={t('care.createPlan')}
        onClick={(event) => event.stopPropagation()}
      >
        <header style={styles.head}>
          <strong>{t('care.createPlan')}</strong>
          <button type="button" className="ghost-button" aria-label={t('common.close')} onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <label style={styles.field}>
          <span style={styles.label}>{t('care.planTitle')}</span>
          <input
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>

        <div style={styles.taskList}>
          {rows.map((row, index) => (
            <div key={index} className="care-plan-row">
              <input
                className="input care-task-name"
                value={row.task_name}
                placeholder={t('task_name')}
                aria-label={t('task_name')}
                onChange={(event) => patch(index, { task_name: event.target.value })}
              />
              <select
                className="select care-task-frequency"
                value={row.frequency}
                aria-label={t('care.frequency')}
                onChange={(event) => patch(index, { frequency: event.target.value as Frequency })}
              >
                <option value="daily">{t('care.freqDaily')}</option>
                <option value="weekly">{t('care.freqWeekly')}</option>
              </select>
              <span className="care-duration">
                <input
                  className="input care-duration-value"
                  type="number"
                  min={1}
                  max={31}
                  value={row.duration_value}
                  aria-label={t('duration')}
                  onChange={(event) =>
                    patch(index, {
                      duration_value: Math.min(31, Math.max(1, Number(event.target.value) || 1)),
                    })
                  }
                />
                <select
                  className="select care-duration-unit"
                  value={row.duration_unit}
                  aria-label={t('duration')}
                  onChange={(event) =>
                    patch(index, { duration_unit: event.target.value as GoalUnit })
                  }
                >
                  <option value="day">{t('care.goalDays')}</option>
                  <option value="week">{t('care.goalWeeks')}</option>
                </select>
              </span>
              <button
                type="button"
                className="ghost-button care-remove"
                aria-label={t('common.close')}
                onClick={() => setRows((previous) => previous.filter((_, i) => i !== index))}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="ghost-button"
          style={styles.addTask}
          onClick={() => setRows((previous) => [...previous, emptyRow()])}
        >
          <Plus size={15} aria-hidden="true" /> {t('care.addTask')}
        </button>

        {error ? (
          <span className="field-error" role="alert">
            {error === 'invalid' ? t('care.invalidPlan') : t('care.saveFailed')}
          </span>
        ) : null}

        <div style={styles.actions}>
          <button type="button" className="ghost-button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving}
            aria-busy={saving}
            onClick={() => void save()}
          >
            {t('care.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    display: 'grid',
    placeItems: 'center',
    padding: '1rem',
    background: 'rgba(6, 26, 22, 0.55)',
    overflowY: 'auto',
  },
  card: {
    display: 'grid',
    gap: '0.9rem',
    width: 'min(44rem, 100%)',
    maxHeight: '90vh',
    overflowY: 'auto',
    padding: '1.25rem',
    borderRadius: '1.35rem',
    background: '#f7fdf9',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    boxShadow: '0 28px 64px rgba(6, 26, 22, 0.4)',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  field: { display: 'grid', gap: '0.35rem' },
  label: { color: 'var(--text-muted, #557b76)', fontSize: '0.78rem', fontWeight: 700 },
  taskList: { display: 'grid', gap: '0.6rem' },
  addTask: { width: '100%', marginBlockStart: '0.75rem' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' },
};
