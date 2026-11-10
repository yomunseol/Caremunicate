import { useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLang } from '../i18n';
import type { CarePlanTask } from '../lib/carePlans';
import SlimButton from './ui/SlimButton';

// ---------------------------------------------------------------------------
// Log Task — a small portaled dialog for a task value + optional note.
// Submit writes to task_logs and, on success, checks the task off for today.
// ---------------------------------------------------------------------------

type TaskLogModalProps = {
  task: CarePlanTask;
  onClose: () => void;
  onSubmit: (value: string, note: string) => Promise<boolean>;
};

export default function TaskLogModal({ task, onClose, onSubmit }: TaskLogModalProps) {
  const { t } = useLang();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!value.trim()) {
      setError(true);
      return;
    }
    setBusy(true);
    try {
      const ok = await onSubmit(value.trim(), note.trim());
      if (ok) onClose();
      else setError(true);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div style={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className="care-plan-dialog task-log-dialog"
        style={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={t('care.submit')}
        onClick={(event) => event.stopPropagation()}
      >
        <header style={styles.head}>
          <strong style={styles.title}>{task.task_name}</strong>
          <button type="button" className="ghost-button" aria-label={t('common.close')} onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <label style={styles.field}>
          <span style={styles.label}>{t('care.value')}</span>
          <input
            className="input care-plan-control"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(false);
            }}
            autoFocus
          />
        </label>

        <label style={styles.field}>
          <span style={styles.label}>{t('care.note')}</span>
          <textarea
            className="input care-plan-control"
            style={styles.textarea}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        {error ? (
          <span className="field-error" role="alert">{t('care.logFailed')}</span>
        ) : null}

        <div style={styles.actions}>
          <SlimButton variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </SlimButton>
          <SlimButton variant="primary" disabled={busy} aria-busy={busy} onClick={() => void submit()}>
            {t('care.submit')}
          </SlimButton>
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
  },
  card: {
    display: 'grid',
    gap: '0.7rem',
    width: 'min(26rem, 100%)',
    padding: '1rem',
    borderRadius: '1.2rem',
    background: '#f7fdf9',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    boxShadow: '0 28px 64px rgba(6, 26, 22, 0.4)',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  title: { overflowWrap: 'anywhere', fontSize: '0.95rem' },
  field: { display: 'grid', gap: '0.35rem' },
  label: { color: 'var(--text-muted, #557b76)', fontSize: '0.78rem', fontWeight: 700 },
  textarea: { blockSize: 'auto', minBlockSize: '4.5rem', paddingBlock: '0.55rem', resize: 'vertical' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' },
};
