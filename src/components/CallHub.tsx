import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Clipboard, Copy, Lock, LockOpen, MoreVertical, Pencil, Trash2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { fmtDate } from '../lib/time';
import {
  ensurePersonalRoom,
  resolveJoin,
  setPersonalRoomStatus,
  type JoinRefusal,
  type PersonalRoom,
} from '../lib/callRooms';
import { normalizeCode } from '../lib/wordcode';
import {
  duplicateCareDoc,
  listMyCareDocs,
  renameCareDoc,
  saveCareDoc,
  softDeleteCareDoc,
  type CareDoc,
} from '../lib/caremunicateDocs';

// ---------------------------------------------------------------------------
// The Call Hub — the ONE call entry point (/call).
//
// Top to bottom: the page title, the join-with-code box for everyone, and the
// personal line card. The personal line is the meeting mechanism; the former
// provider-only "Start meeting" card has been removed. There is no second call
// surface: everything either navigates to /call/<words> or calls startCall()
// directly for a 1:1.
// ---------------------------------------------------------------------------

/** Every refusal reason maps to an existing, translated string. */
const REFUSAL_KEYS: Record<JoinRefusal, string> = {
  roomNotFound: 'call.roomNotFound',
  meetingLocked: 'call.meetingLocked',
  lineClosed: 'call.lineClosed',
  meetingFull: 'call.meetingFull',
  password: 'call.enterPassword',
};

const goToRoom = (code: string) => {
  // Word-code URLs only — the router listens for the hash.
  window.location.hash = `#call/${normalizeCode(code)}`;
};

export default function CallHub() {
  const { t, locale } = useLang();
  const { user } = useAuth();

  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinNeedsPassword, setJoinNeedsPassword] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  /** The REAL message when the join guard threw — shown in dev only. */
  const [joinGuardError, setJoinGuardError] = useState<string | null>(null);

  const [line, setLine] = useState<PersonalRoom | null>(null);
  const [lineBusy, setLineBusy] = useState(false);
  const [lineCopied, setLineCopied] = useState(false);
  /** Raw reason the personal line could not be loaded, if it threw. */
  const [lineError, setLineError] = useState<string | null>(null);

  // My Documents — every doc this user created, across calls.
  const [myDocs, setMyDocs] = useState<CareDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState(false);
  const [viewingDoc, setViewingDoc] = useState<CareDoc | null>(null);
  const [draft, setDraft] = useState('');
  const [savingDoc, setSavingDoc] = useState(false);
  const [saveError, setSaveError] = useState(false);
  // Per-row actions: ⋯ menu, rename dialog, delete confirmation.
  const [menuDocId, setMenuDocId] = useState<string | null>(null);
  const [renameDoc, setRenameDoc] = useState<CareDoc | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteDoc, setDeleteDoc] = useState<CareDoc | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState('');

  const loadDocs = useCallback(async () => {
    if (!user?.id) {
      setDocsLoading(false);
      return;
    }
    setDocsLoading(true);
    setDocsError(false);
    const list = await listMyCareDocs(user.id);
    setMyDocs(list ?? []);
    setDocsError(list === null);
    setDocsLoading(false);
  }, [user?.id]);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  const openDoc = (doc: CareDoc) => {
    setMenuDocId(null);
    setViewingDoc(doc);
    setDraft(doc.content ?? '');
    setSaveError(false);
  };

  const closeDoc = () => {
    setViewingDoc(null);
    setDraft('');
    setSaveError(false);
  };

  const saveDoc = async () => {
    if (!viewingDoc || viewingDoc.lock_status === 'locked') return;
    setSavingDoc(true);
    setSaveError(false);
    try {
      const saved = await saveCareDoc({
        id: viewingDoc.id,
        title: viewingDoc.title,
        content: draft,
      });
      if (!saved) {
        setSaveError(true);
        return;
      }
      setMyDocs((previous) => previous.map((doc) => (doc.id === saved.id ? saved : doc)));
      setViewingDoc(saved);
      setDraft(saved.content ?? '');
    } finally {
      setSavingDoc(false);
    }
  };

  const showNotice = (text: string) => {
    setActionNotice(text);
    window.setTimeout(() => setActionNotice(''), 2500);
  };

  const duplicate = async (doc: CareDoc) => {
    setMenuDocId(null);
    setActionBusy(true);
    const copy = await duplicateCareDoc(doc);
    setActionBusy(false);
    if (!copy) {
      showNotice(t('careDocs.error'));
      return;
    }
    setMyDocs((previous) => [copy, ...previous]);
    showNotice(t('careDocs.copied'));
  };

  const saveRename = async () => {
    if (!renameDoc) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;
    setActionBusy(true);
    const saved = await renameCareDoc(renameDoc.id, nextTitle);
    setActionBusy(false);
    if (!saved) {
      showNotice(t('careDocs.error'));
      return;
    }
    setMyDocs((previous) => previous.map((doc) => (doc.id === saved.id ? saved : doc)));
    setViewingDoc((current) => (current?.id === saved.id ? saved : current));
    setRenameDoc(null);
    setRenameValue('');
  };

  const confirmDeleteDoc = async () => {
    if (!deleteDoc) return;
    const id = deleteDoc.id;
    setActionBusy(true);
    const removed = await softDeleteCareDoc(id);
    setActionBusy(false);
    if (!removed) {
      showNotice(t('careDocs.error'));
      return;
    }
    setMyDocs((previous) => previous.filter((doc) => doc.id !== id));
    setViewingDoc((current) => (current?.id === id ? null : current));
    setDeleteDoc(null);
  };

  // The personal line is created lazily, once, and keeps its code forever.
  // A throw is reported inline with its raw code and a retry, exactly like
  // startFailed — never a silent empty card.
  const loadLine = useCallback(async () => {
    if (!user?.id) return;
    setLineBusy(true);
    setLineError(null);
    try {
      setLine(await ensurePersonalRoom(user.id));
    } catch (error) {
      console.error('CALL ERROR:', error);
      const failure = error as { code?: string; message?: string } | null;
      setLineError(failure?.code ?? failure?.message ?? String(error));
    } finally {
      setLineBusy(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void loadLine();
  }, [loadLine]);

  const submitJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setJoinBusy(true);
    setJoinError(null);
    setJoinGuardError(null);
    try {
      // The one guard, shared with the /call/<param> route.
      const verdict = await resolveJoin(joinCode, {
        password: joinNeedsPassword ? joinPassword : '',
        userId: user?.id,
      });

      if (!verdict.ok) {
        if (verdict.reason === 'password') {
          setJoinNeedsPassword(true);
          setJoinError(joinNeedsPassword ? REFUSAL_KEYS.password : null);
          return;
        }
        setJoinError(REFUSAL_KEYS[verdict.reason]);
        return;
      }

      goToRoom(verdict.code);
    } catch (error) {
      // The guard threw — the RPC failed or we have a bug. Show the REAL
      // message rather than blaming a room that may well exist.
      console.error('CALL ERROR:', error);
      const failure = error as { code?: string; message?: string } | null;
      setJoinGuardError(failure?.code ?? failure?.message ?? String(error));
    } finally {
      setJoinBusy(false);
    }
  };

  const isLineOpen = line?.status === 'active';

  const toggleLine = async () => {
    if (!line || lineBusy) return;
    setLineBusy(true);
    try {
      const next = isLineOpen ? 'waiting' : 'active';
      await setPersonalRoomStatus(line.id, next);
      setLine({ ...line, status: next });
    } catch (error) {
      console.error('CALL ERROR:', error);
    } finally {
      setLineBusy(false);
    }
  };

  const copyLineCode = () => {
    if (!line) return;
    setLineCopied(true);
    void navigator.clipboard
      ?.writeText(line.code)
      .catch(() => {})
      .finally(() => window.setTimeout(() => setLineCopied(false), 2000));
  };

  return (
    <section className="section call-hub" aria-labelledby="call-hub-heading">
      <div className="section-heading">
        <div className="eyebrow">{t('common.appName')}</div>
        <h2 id="call-hub-heading">{t('call.callHub')}</h2>
      </div>

      <div className="call-hub-grid">
        {/* Join a room — everyone. */}
        <div className="panel">
          <div className="eyebrow">{t('call.joinWithCode')}</div>
          <form style={styles.joinForm} onSubmit={(event) => void submitJoin(event)}>
            <input
              className="input ltr-isolate"
              dir="ltr"
              autoComplete="off"
              placeholder="mint-fox-river-halo"
              aria-label={t('call.callCode')}
              value={joinCode}
              onChange={(event) => {
                setJoinCode(event.target.value);
                setJoinError(null);
              }}
            />

            {joinNeedsPassword ? (
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                placeholder={t('call.enterPassword')}
                aria-label={t('call.enterPassword')}
                value={joinPassword}
                onChange={(event) => {
                  setJoinPassword(event.target.value);
                  setJoinError(null);
                }}
              />
            ) : null}

            <button type="submit" className="primary-button" disabled={joinBusy} aria-busy={joinBusy}>
              {t('call.joinWithCode')}
            </button>
          </form>
          {joinError ? <span className="field-error">{t(joinError)}</span> : null}
          {joinGuardError && import.meta.env.DEV ? (
            <span className="call-dev-banner" role="alert">
              Guard threw: <span className="error-detail">{joinGuardError}</span>
            </span>
          ) : null}
        </div>

        {/* Your personal line. Rendered unconditionally so /call is always
            exactly two cards; the body degrades if the row is unavailable. */}
        <div className="panel">
          <div className="eyebrow">{t('call.personalCode')}</div>

          {line ? (
            /* ONE row: label · mono code · copy · flexible spacer · switch.
               Wraps gracefully on narrow screens and nothing touches the edge. */
            <div className="call-line-row">
              <span className="call-line-label">{t('call.openLine')}</span>

              <span
                className="call-code-chip"
                style={styles.lineChip}
                dir="ltr"
                title={line.code}
              >
                {line.code}
              </span>

              <button
                type="button"
                className="ghost-button call-line-copy"
                onClick={copyLineCode}
                title={t('call.copyCode')}
                aria-label={`${t('call.copyCode')} — ${line.code}`}
              >
                {lineCopied ? (
                  t('call.copied')
                ) : (
                  <>
                    <Clipboard size={14} aria-hidden="true" /> {t('call.copyCode')}
                  </>
                )}
              </button>

              <span className="call-line-spacer" aria-hidden="true" />

              <button
                type="button"
                role="switch"
                aria-checked={isLineOpen}
                aria-label={t('call.openLine')}
                className={isLineOpen ? 'call-switch is-on' : 'call-switch'}
                disabled={lineBusy}
                onClick={() => void toggleLine()}
              >
                <span className="call-switch-knob" aria-hidden="true" />
              </button>
            </div>
          ) : lineError ? (
            /* Self-reporting: the raw code, then a way to try again. */
            <div className="call-line-error">
              <span className="field-error">
                {t('call.startFailed')}
                <span className="error-detail">({lineError})</span>
              </span>
              <button
                type="button"
                className="ghost-button"
                disabled={lineBusy}
                aria-busy={lineBusy}
                onClick={() => void loadLine()}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <span className="call-hub-muted">
              {lineBusy ? t('places.searching') : t('call.lineClosed')}
            </span>
          )}
        </div>
      </div>

      <div className="panel call-hub-my-docs">
        <div className="eyebrow">{t('careDocs.myDocs')}</div>

        {docsLoading ? (
          <span className="call-hub-muted">{t('places.searching')}</span>
        ) : docsError ? (
          <span className="field-error">{t('careDocs.error')}</span>
        ) : myDocs.length === 0 ? (
          <span className="call-hub-muted">{t('careDocs.none')}</span>
        ) : (
          <ul className="call-docs-list">
            {myDocs.map((doc) => (
              <li key={doc.id} className="call-doc-item">
                <button type="button" className="call-doc-row" onClick={() => openDoc(doc)}>
                  <span className="call-doc-title">{doc.title}</span>
                  <span className="call-doc-meta">
                    {doc.lock_status === 'locked' ? (
                      <Lock size={13} aria-hidden="true" />
                    ) : (
                      <LockOpen size={13} aria-hidden="true" />
                    )}
                    {doc.lock_status === 'locked' ? t('careDocs.locked') : t('careDocs.unlocked')}
                    <span aria-hidden="true">·</span>
                    {fmtDate(doc.updated_at, locale, 'CallHub')}
                  </span>
                </button>

                <button
                  type="button"
                  className="call-doc-more"
                  aria-label={t('common.more')}
                  aria-haspopup="menu"
                  aria-expanded={menuDocId === doc.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuDocId((current) => (current === doc.id ? null : doc.id));
                  }}
                >
                  <MoreVertical size={16} />
                </button>

                {menuDocId === doc.id ? (
                  <div className="call-doc-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuDocId(null);
                        setRenameDoc(doc);
                        setRenameValue(doc.title);
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" /> {t('careDocs.rename')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void duplicate(doc)}
                      disabled={actionBusy}
                    >
                      <Copy size={14} aria-hidden="true" /> {t('careDocs.duplicate')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={() => {
                        setMenuDocId(null);
                        setDeleteDoc(doc);
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" /> {t('careDocs.delete')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {actionNotice ? (
          <span className="call-doc-notice" role="status">{actionNotice}</span>
        ) : null}
      </div>

      {viewingDoc ? (
        <div className="call-doc-modal" role="dialog" aria-modal="true" aria-label={viewingDoc.title}>
          <div className="call-doc-card">
            <header>
              <strong>{viewingDoc.title}</strong>
              <button
                type="button"
                className="call-panel-close"
                onClick={closeDoc}
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </header>

            <span className="call-doc-meta">
              {viewingDoc.lock_status === 'locked' ? (
                <Lock size={13} aria-hidden="true" />
              ) : (
                <LockOpen size={13} aria-hidden="true" />
              )}
              {viewingDoc.lock_status === 'locked' ? t('careDocs.locked') : t('careDocs.unlocked')}
              <span aria-hidden="true">·</span>
              {t('careDocs.updated')}{' '}
              {fmtDate(viewingDoc.updated_at, locale, 'CallHub')}
            </span>

            <textarea
              value={draft}
              readOnly={viewingDoc.lock_status === 'locked'}
              aria-label={viewingDoc.title}
              onChange={(event) => setDraft(event.target.value)}
            />

            {saveError ? (
              <span className="field-error" role="alert">{t('careDocs.error')}</span>
            ) : null}

            <div className="call-doc-actions">
              {viewingDoc.lock_status === 'unlocked' ? (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveDoc()}
                  disabled={savingDoc}
                >
                  {savingDoc ? t('call.saving') : t('careDocs.save')}
                </button>
              ) : null}
              <button type="button" className="ghost-button" onClick={closeDoc}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameDoc ? (
        <div className="call-doc-modal" role="dialog" aria-modal="true" aria-label={t('careDocs.rename')}>
          <div className="call-doc-card">
            <header>
              <strong>{t('careDocs.rename')}</strong>
              <button
                type="button"
                className="call-panel-close"
                onClick={() => setRenameDoc(null)}
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </header>
            <input
              className="input"
              value={renameValue}
              aria-label={t('careDocs.titleLabel')}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <div className="call-doc-actions">
              <button type="button" className="ghost-button" onClick={() => setRenameDoc(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void saveRename()}
                disabled={actionBusy || !renameValue.trim()}
              >
                {actionBusy ? t('call.saving') : t('careDocs.save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteDoc ? (
        <div className="call-doc-modal" role="dialog" aria-modal="true" aria-label={t('careDocs.delete')}>
          <div className="call-doc-card">
            <header>
              <strong>{t('careDocs.delete')}</strong>
              <button
                type="button"
                className="call-panel-close"
                onClick={() => setDeleteDoc(null)}
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </header>
            <p style={styles.confirmText}>{t('careDocs.confirmDelete')}</p>
            <div className="call-doc-actions">
              <button type="button" className="ghost-button" onClick={() => setDeleteDoc(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void confirmDeleteDoc()}
                disabled={actionBusy}
              >
                {t('careDocs.delete')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  joinForm: { display: 'grid', gap: '0.5rem' },
  confirmText: { margin: 0, color: 'var(--text, #133b35)', fontSize: '0.9rem', lineHeight: 1.5 },
  lineChip: {
    // Light-surface skin; layout comes from .call-code-chip.
    background: 'var(--accent-soft, rgba(62, 169, 133, 0.14))',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    color: 'var(--accent-strong, #216e5d)',
  },
};
