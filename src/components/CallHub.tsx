import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import {
  ensurePersonalRoom,
  resolveJoin,
  setPersonalRoomStatus,
  type JoinRefusal,
  type PersonalRoom,
} from '../lib/callRooms';
import { normalizeCode } from '../lib/wordcode';

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
  const { t } = useLang();
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
                {lineCopied ? t('call.copied') : `📋 ${t('call.copyCode')}`}
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
                Retry
              </button>
            </div>
          ) : (
            <span className="call-hub-muted">
              {lineBusy ? t('places.searching') : t('call.lineClosed')}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  joinForm: { display: 'grid', gap: '0.5rem' },
  lineChip: {
    // Light-surface skin; layout comes from .call-code-chip.
    background: 'var(--accent-soft, rgba(62, 169, 133, 0.14))',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    color: 'var(--accent-strong, #216e5d)',
  },
};
