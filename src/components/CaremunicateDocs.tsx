import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Lock, LockOpen, Plus, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { loadCallSession } from '../lib/callSessions';
import {
  createCareDoc,
  listCareDocs,
  saveCareDoc,
  type CareDoc,
} from '../lib/caremunicateDocs';

// ---------------------------------------------------------------------------
// Caremunicate Documents — collaborative documents for the current call.
//
// Backed by public.caremunicate_docs (call_id = the call room id). The list is
// scoped to this call; content + title autosave after 1s. A doc created as
// "locked" becomes read-only once the call session has ended; "unlocked" docs
// stay editable.
// ---------------------------------------------------------------------------

const AUTOSAVE_MS = 1000;

type LockStatus = 'locked' | 'unlocked';

type CaremunicateDocsProps = {
  onClose: () => void;
};

export default function CaremunicateDocs({ onClose }: CaremunicateDocsProps) {
  const { t } = useLang();
  const { user } = useAuth();
  const { roomId, sessionId, status } = useCallContext();
  const trapRef = useFocusTrap<HTMLElement>(true);
  const callId = roomId ?? '';

  const [docs, setDocs] = useState<CareDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [lockStatus, setLockStatus] = useState<LockStatus>('unlocked');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newLock, setNewLock] = useState<LockStatus>('unlocked');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');
  const [sessionEnded, setSessionEnded] = useState(false);

  const pendingRef = useRef<{ id: string; title: string; content: string } | null>(null);
  const timerRef = useRef<number | null>(null);

  const activeDoc = docs.find((doc) => doc.id === activeId) ?? null;
  const readOnly = Boolean(activeDoc && activeDoc.lock_status === 'locked' && sessionEnded);

  // Load this call's documents.
  useEffect(() => {
    if (!callId) {
      setLoading(false);
      return;
    }
    let active = true;
    void (async () => {
      const list = await listCareDocs(callId);
      if (!active) return;
      setDocs(list);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [callId]);

  // Locked docs freeze once the call session has ended.
  useEffect(() => {
    if (!sessionId) {
      setSessionEnded(status === 'ended');
      return;
    }
    let active = true;
    void (async () => {
      const session = await loadCallSession(sessionId);
      if (!active) return;
      setSessionEnded(Boolean(session?.ended_at) || status === 'ended');
    })();
    return () => {
      active = false;
    };
  }, [sessionId, status]);

  const flush = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setSaveState('saving');
    const saved = await saveCareDoc(pending);
    if (!saved) {
      setSaveState('idle');
      setError(t('auth.msg.errorGeneric'));
      return;
    }
    setDocs((previous) => previous.map((doc) => (doc.id === saved.id ? saved : doc)));
    setSaveState('saved');
  }, [t]);

  // Flush the last keystrokes when the panel closes.
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      void flush();
    },
    [flush],
  );

  const scheduleSave = (nextTitle: string, nextContent: string) => {
    if (!activeDoc || readOnly) return;
    setSaveState('idle');
    setError('');
    pendingRef.current = { id: activeDoc.id, title: nextTitle, content: nextContent };
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void flush();
    }, AUTOSAVE_MS);
  };

  const openDoc = (id: string) => {
    const doc = docs.find((item) => item.id === id);
    if (!doc) {
      setActiveId(null);
      setTitle('');
      setContent('');
      return;
    }
    setActiveId(doc.id);
    setTitle(doc.title);
    setContent(doc.content ?? '');
    setLockStatus(doc.lock_status);
    setSaveState('idle');
    setError('');
  };

  const create = async () => {
    if (!callId || !user) return;
    setBusy(true);
    setError('');
    try {
      const created = await createCareDoc({
        callId,
        creatorId: user.id,
        title: newTitle,
        lockStatus: newLock,
      });
      if (!created) {
        setError(t('auth.msg.errorGeneric'));
        return;
      }
      setDocs((previous) => [created, ...previous]);
      setActiveId(created.id);
      setTitle(created.title);
      setContent(created.content ?? '');
      setLockStatus(created.lock_status);
      setNewTitle('');
      setNewLock('unlocked');
      setCreating(false);
      setSaveState('idle');
    } finally {
      setBusy(false);
    }
  };

  const onChangeTitle = (value: string) => {
    setTitle(value);
    scheduleSave(value, content);
  };

  const onChangeContent = (value: string) => {
    setContent(value);
    scheduleSave(title, value);
  };

  return (
    <aside
      ref={trapRef}
      className="call-participants call-docs"
      style={styles.panel}
      role="dialog"
      aria-label={t('call.docsTitle')}
    >
      <header style={styles.head}>
        <strong>{t('careDocs.title')}</strong>
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

      {!callId ? (
        <p style={styles.muted}>{t('call.docsNoSession')}</p>
      ) : loading ? (
        <p style={styles.muted} aria-busy="true">{t('places.searching')}</p>
      ) : (
        <>
          <div style={styles.toolbar}>
            <select
              style={styles.select}
              value={activeId ?? ''}
              aria-label={t('careDocs.select')}
              onChange={(event) => openDoc(event.target.value)}
            >
              <option value="">{t('careDocs.select')}</option>
              {docs.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.title} — {doc.lock_status === 'locked' ? t('careDocs.locked') : t('careDocs.unlocked')}
                </option>
              ))}
            </select>

            <button
              type="button"
              style={styles.createButton}
              onClick={() => {
                setCreating((open) => !open);
                setError('');
              }}
            >
              <Plus size={15} aria-hidden="true" /> {t('careDocs.create')}
            </button>
          </div>

          {creating ? (
            <div style={styles.form}>
              <input
                style={styles.input}
                value={newTitle}
                placeholder={t('careDocs.titleLabel')}
                aria-label={t('careDocs.titleLabel')}
                onChange={(event) => setNewTitle(event.target.value)}
              />
              <div style={styles.radioRow}>
                <label style={styles.radio}>
                  <input
                    type="radio"
                    name="doc-lock"
                    checked={newLock === 'locked'}
                    onChange={() => setNewLock('locked')}
                  />
                  {t('careDocs.locked')}
                </label>
                <label style={styles.radio}>
                  <input
                    type="radio"
                    name="doc-lock"
                    checked={newLock === 'unlocked'}
                    onChange={() => setNewLock('unlocked')}
                  />
                  {t('careDocs.unlocked')}
                </label>
              </div>
              <div style={styles.formActions}>
                <button type="button" style={styles.ghost} onClick={() => setCreating(false)} disabled={busy}>
                  {t('common.cancel')}
                </button>
                <button type="button" style={styles.createButton} onClick={() => void create()} disabled={busy}>
                  {busy ? t('call.saving') : t('careDocs.create')}
                </button>
              </div>
            </div>
          ) : null}

          {error ? <p style={styles.error} role="alert">{error}</p> : null}

          {activeDoc ? (
            <div style={styles.editor}>
              <div style={styles.badges}>
                <span style={lockStatus === 'locked' ? styles.badgeLocked : styles.badgeUnlocked}>
                  {lockStatus === 'locked' ? (
                    <Lock size={12} aria-hidden="true" />
                  ) : (
                    <LockOpen size={12} aria-hidden="true" />
                  )}
                  {lockStatus === 'locked' ? t('careDocs.locked') : t('careDocs.unlocked')}
                </span>
                {readOnly ? <span style={styles.readOnly}>{t('careDocs.readOnly')}</span> : null}
              </div>

              <input
                style={styles.input}
                value={title}
                placeholder={t('careDocs.titleLabel')}
                aria-label={t('careDocs.titleLabel')}
                disabled={readOnly}
                onChange={(event) => onChangeTitle(event.target.value)}
              />

              <textarea
                style={styles.textarea}
                value={content}
                disabled={readOnly}
                placeholder={t('call.docsPlaceholder')}
                aria-label={t('call.docsPlaceholder')}
                onChange={(event) => onChangeContent(event.target.value)}
              />

              <span style={styles.status} role="status">
                {saveState === 'saving'
                  ? t('call.saving')
                  : saveState === 'saved'
                    ? t('careDocs.autosaved')
                    : ''}
              </span>
            </div>
          ) : (
            <p style={styles.muted}>
              {docs.length === 0 ? t('careDocs.noDocs') : t('careDocs.select')}
            </p>
          )}
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
    gridTemplateRows: 'auto auto auto 1fr',
    gap: '0.6rem',
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
  muted: { margin: 0, color: '#9fc4b8', fontSize: '0.82rem', lineHeight: 1.5 },
  toolbar: { display: 'grid', gap: '0.5rem' },
  select: {
    width: '100%',
    padding: '0.5rem 0.6rem',
    borderRadius: '0.6rem',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#f2fffa',
    fontFamily: 'inherit',
    fontSize: '0.82rem',
  },
  createButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.35rem',
    border: 'none',
    borderRadius: '999px',
    padding: '0.5rem 0.8rem',
    background: 'linear-gradient(120deg, #48b58f, #7adab1)',
    color: '#072c2a',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: '0.82rem',
  },
  form: {
    display: 'grid',
    gap: '0.5rem',
    padding: '0.7rem',
    borderRadius: '0.7rem',
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
  },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' },
  input: {
    width: '100%',
    padding: '0.55rem 0.7rem',
    borderRadius: '0.6rem',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#f2fffa',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
  },
  radioRow: { display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.82rem', color: '#d9fff0' },
  radio: { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' },
  ghost: {
    border: '1px solid rgba(255, 255, 255, 0.25)',
    borderRadius: '999px',
    padding: '0.45rem 0.8rem',
    background: 'transparent',
    color: '#d9fff0',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  editor: { display: 'grid', gap: '0.5rem', minHeight: 0 },
  badges: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' },
  badgeLocked: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    paddingInline: '0.5rem',
    paddingBlock: '0.12rem',
    borderRadius: '999px',
    background: 'rgba(224, 101, 90, 0.22)',
    color: '#ffd9d4',
    fontSize: '0.7rem',
    fontWeight: 800,
  },
  badgeUnlocked: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    paddingInline: '0.5rem',
    paddingBlock: '0.12rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.24)',
    color: '#d9fff0',
    fontSize: '0.7rem',
    fontWeight: 800,
  },
  readOnly: { color: '#f0d27a', fontSize: '0.72rem', fontWeight: 700 },
  textarea: {
    minHeight: '9rem',
    resize: 'vertical',
    borderRadius: '0.7rem',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#f2fffa',
    padding: '0.7rem',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    lineHeight: 1.5,
  },
  status: { minHeight: '1rem', fontSize: '0.72rem', color: '#9fc4b8' },
  error: { margin: 0, color: '#ffd9d4', fontSize: '0.8rem', fontWeight: 600 },
};
