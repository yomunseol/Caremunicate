import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { FileText, Lock, LockOpen, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { loadCallSession } from '../lib/callSessions';
import {
  createClinicalDoc,
  isDocLocked,
  loadClinicalDoc,
  saveClinicalDoc,
  type ClinicalDoc,
  type EditMode,
} from '../lib/clinicalDocs';

// ---------------------------------------------------------------------------
// Caremunicate Docs — a doctor's clinical notes for the current call session.
//
// "Create New Doc" asks for the edit_mode first:
//   Locked (meeting_only) — read-only once the call session ends.
//   Unlocked (anytime)    — editable indefinitely.
// The lock is derived (edit_mode + whether the session has ended) and enforced
// by RLS; this panel only mirrors it. Autosave is debounced and flushed on
// unmount so a refresh mid-typing keeps the last keystrokes.
// ---------------------------------------------------------------------------

const AUTOSAVE_MS = 800;

type CallDocsPanelProps = {
  onClose: () => void;
};

export default function CallDocsPanel({ onClose }: CallDocsPanelProps) {
  const { t } = useLang();
  const { user } = useAuth();
  const { sessionId } = useCallContext();
  const trapRef = useFocusTrap<HTMLElement>(true);

  const [doc, setDoc] = useState<ClinicalDoc | null>(null);
  const [content, setContent] = useState('');
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<{ id: string; content: string } | null>(null);

  const flush = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setStatus('saving');
    const saved = await saveClinicalDoc({ id: pending.id, content: pending.content });
    if (saved) {
      setDoc(saved);
      setStatus('saved');
    } else {
      // A save against a locked doc is refused by RLS — lock the field too.
      setStatus('error');
      setLocked(true);
    }
  }, []);

  // Load the doc + the session (for the lock check) when the panel opens.
  useEffect(() => {
    if (!sessionId || !user) {
      setLoading(false);
      return;
    }
    let active = true;

    void (async () => {
      const session = await loadCallSession(sessionId);
      const existing = await loadClinicalDoc(sessionId, user.id);
      if (!active) return;
      setDoc(existing);
      setContent(existing?.content ?? '');
      setLocked(isDocLocked(existing, session));
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [sessionId, user]);

  // Debounce + flush-on-unmount.
  const onChange = (value: string) => {
    setContent(value);
    if (!doc || locked) return;
    setStatus('idle');
    pendingRef.current = { id: doc.id, content: value };
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void flush();
    }, AUTOSAVE_MS);
  };

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      void flush();
    },
    [flush],
  );

  const create = async (editMode: EditMode) => {
    if (!sessionId || !user) return;
    setChoosing(false);
    setLoading(true);
    const created = await createClinicalDoc({
      sessionId,
      authorId: user.id,
      editMode,
    });
    if (!created) {
      setLoading(false);
      return;
    }
    setDoc(created);
    setContent('');
    setLocked(isDocLocked(created, { ended_at: null }));
    setLoading(false);
  };

  const modeLabel = doc
    ? t(doc.edit_mode === 'anytime' ? 'call.editModeUnlocked' : 'call.editModeLocked')
    : '';

  return (
    <aside
      ref={trapRef}
      className="call-participants call-docs"
      style={styles.panel}
      role="dialog"
      aria-label={t('call.docsTitle')}
    >
      <header style={styles.head}>
        <strong>{t('call.docsTitle')}</strong>
        <button
          type="button"
          className="call-panel-close"
          onClick={onClose}
          aria-label={t('common.close')}
          style={styles.close}
        >
          <X size={16} />
        </button>
      </header>

      {!sessionId ? (
        <p style={styles.muted}>{t('call.docsNoSession')}</p>
      ) : loading ? (
        <p style={styles.muted} aria-busy="true">{t('places.searching')}</p>
      ) : !doc ? (
        choosing ? (
          <div style={styles.choose}>
            <span style={styles.chooseTitle}>{t('call.createDoc')}</span>
            <button type="button" style={styles.option} onClick={() => void create('meeting_only')}>
              <Lock size={15} aria-hidden="true" />
              <span style={styles.optionText}>
                <span style={styles.optionTitle}>{t('call.editModeLocked')}</span>
                <span style={styles.optionHint}>{t('call.editModeLockedHint')}</span>
              </span>
            </button>
            <button type="button" style={styles.option} onClick={() => void create('anytime')}>
              <LockOpen size={15} aria-hidden="true" />
              <span style={styles.optionText}>
                <span style={styles.optionTitle}>{t('call.editModeUnlocked')}</span>
                <span style={styles.optionHint}>{t('call.editModeUnlockedHint')}</span>
              </span>
            </button>
            <button type="button" className="ghost-button" onClick={() => setChoosing(false)}>
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button type="button" className="primary-button" onClick={() => setChoosing(true)}>
            <FileText size={15} aria-hidden="true" /> {t('call.createDoc')}
          </button>
        )
      ) : (
        <>
          <div style={styles.badges}>
            <span style={styles.modeBadge} data-mode={doc.edit_mode}>
              {doc.edit_mode === 'anytime' ? <LockOpen size={12} aria-hidden="true" /> : <Lock size={12} aria-hidden="true" />}
              {modeLabel}
            </span>
            {locked ? <span style={styles.lockBadge}>{t('call.locked')}</span> : null}
          </div>

          <textarea
            className="call-docs-textarea"
            style={styles.textarea}
            value={content}
            disabled={locked}
            placeholder={t('call.docsPlaceholder')}
            aria-label={t('call.docsPlaceholder')}
            onChange={(event) => onChange(event.target.value)}
          />

          <span style={styles.status} role="status">
            {status === 'saving' ? t('call.saving') : status === 'saved' ? t('call.saved') : ''}
          </span>
        </>
      )}
    </aside>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineEnd: 0,
    zIndex: 1,
    width: 'min(24rem, 92vw)',
    pointerEvents: 'auto',
    display: 'grid',
    gridTemplateRows: 'auto auto 1fr auto',
    gap: '0.5rem',
    padding: '0.9rem',
    background: 'rgba(9, 32, 27, 0.96)',
    borderInlineStart: '1px solid rgba(255, 255, 255, 0.16)',
    color: '#f2fffa',
    overflowY: 'auto',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255, 255, 255, 0.12)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  muted: { margin: 0, color: '#9fc4b8', fontSize: '0.82rem' },
  choose: { display: 'grid', gap: '0.5rem', alignContent: 'start' },
  chooseTitle: { fontWeight: 800, fontSize: '0.9rem' },
  option: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.5rem',
    padding: '0.6rem 0.7rem',
    borderRadius: '0.8rem',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#f2fffa',
    textAlign: 'start',
    cursor: 'pointer',
  },
  optionText: { display: 'grid', gap: '0.15rem' },
  optionTitle: { fontWeight: 800, fontSize: '0.85rem' },
  optionHint: { fontSize: '0.72rem', color: '#bfe6d7' },
  badges: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' },
  modeBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    paddingBlock: '0.2rem',
    paddingInline: '0.55rem',
    borderRadius: '999px',
    background: 'rgba(255, 255, 255, 0.12)',
    fontSize: '0.7rem',
    fontWeight: 800,
  },
  lockBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    paddingBlock: '0.2rem',
    paddingInline: '0.55rem',
    borderRadius: '999px',
    background: 'rgba(224, 101, 90, 0.2)',
    color: '#ffd9d4',
    fontSize: '0.7rem',
    fontWeight: 800,
  },
  textarea: {
    width: '100%',
    minHeight: '12rem',
    resize: 'vertical',
    padding: '0.7rem',
    borderRadius: '0.8rem',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    background: 'rgba(255, 255, 255, 0.06)',
    color: '#f2fffa',
    font: 'inherit',
    fontSize: '0.85rem',
    lineHeight: 1.5,
  },
  status: { minHeight: '1rem', fontSize: '0.72rem', color: '#bfe6d7' },
};
