import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCallContext } from '../context/CallContext';
import { useToast } from '../context/ToastContext';
import { useLang } from '../i18n';
import { isProvider } from '../lib/roles';
import { supabase } from '../lib/supabase';
import {
  createRoom,
  ensurePersonalRoom,
  resolveJoin,
  setPersonalRoomStatus,
  type JoinRefusal,
  type PersonalRoom,
} from '../lib/callRooms';
import { normalizeCode } from '../lib/wordcode';
import { saveCallPrefs, stashPendingPolicy } from '../lib/callPrefs';
import CallSettingsModal, { type MeetingSettings } from './CallSettingsModal';

// ---------------------------------------------------------------------------
// The Call Hub — the ONE call entry point (/call).
//
// Top to bottom: the page title, the provider-only "Start meeting" button (and
// its settings modal), the join-with-code box for everyone, and the personal
// line card. There is no second start-meeting implementation and no other call
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
  const { notify } = useToast();
  const { rememberCreatedRoom } = useCallContext();

  const [canHost, setCanHost] = useState(false);
  /** The DB truth behind the gate: logged on mount and on every 42501. */
  const [freshRole, setFreshRole] = useState('');
  const [freshPlan, setFreshPlan] = useState<string | null>(null);
  /** Set only when the DB itself says this account is not a provider. */
  const [notProvider, setNotProvider] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  /** The raw Postgres/Supabase code or message behind hostError. */
  const [hostErrorDetail, setHostErrorDetail] = useState<string | null>(null);

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

  /**
   * The DB truth: role + plan read STRAIGHT from profiles, never from the
   * session cache, the login-time context, or user_metadata — except as the
   * last resort when the profile row is genuinely absent (a normal state).
   */
  const readProfile = useCallback(async (): Promise<{ role: string; plan: string | null }> => {
    if (!user?.id) return { role: '', plan: null };

    const { data, error } = await supabase
      .from('profiles')
      .select('role, plan')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      console.error('CALL ERROR:', error.message);
      return { role: '', plan: null };
    }

    const row = data as { role?: string; plan?: string } | null;
    return {
      role: String(row?.role ?? user.user_metadata?.role ?? ''),
      plan: typeof row?.plan === 'string' ? row.plan : null,
    };
  }, [user?.id, user?.user_metadata?.role]);

  // Can this account host a meeting? (doctor / department / hospital)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user?.id) return;
      const fresh = await readProfile();
      if (cancelled) return;
      setFreshRole(fresh.role);
      setFreshPlan(fresh.plan);
      const provider = isProvider(fresh.role);
      setCanHost(provider);
      if (import.meta.env.DEV) {
        console.log('CALL HUB GATE:', {
          role: fresh.role,
          plan: fresh.plan,
          source: 'fresh-fetch',
          canHost: provider,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, readProfile]);

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

  const startMeeting = async (settings: MeetingSettings) => {
    // Re-check the DB immediately before starting: a role that changed in
    // another tab must never open a meeting from a stale gate.
    const atStart = await readProfile();
    setFreshRole(atStart.role);
    setFreshPlan(atStart.plan);
    if (!isProvider(atStart.role)) {
      setCanHost(false);
      setSettingsOpen(false);
      notify(t('call.notProvider'), 'info');
      return;
    }

    setHostBusy(true);
    setHostError(null);
    setHostErrorDetail(null);
    try {
      // The plaintext password only travels into createRoom, which hashes it.
      const password = settings.requirePassword ? settings.password : '';

      // createRoom awaits the insert fully before returning, so the row exists
      // by the time the route guard looks for it.
      const room = await createRoom({
        password,
        lobbyEnabled: settings.waitingRoom,
        autoMute: settings.autoMute,
        allowShare: settings.allowScreenShare,
      });

      // Hand the room to the provider so /call/<code> opens it by id — the
      // channel is call:${room.id} and the host needs no lookup at all.
      rememberCreatedRoom(room);

      if (user?.id) {
        void saveCallPrefs(user.id, {
          waitingRoom: settings.waitingRoom,
          requirePassword: settings.requirePassword,
          autoMute: settings.autoMute,
          allowScreenShare: settings.allowScreenShare,
        });
      }
      stashPendingPolicy({
        lobby_enabled: settings.waitingRoom,
        locked: false,
        auto_mute: settings.autoMute,
        allow_share: settings.allowScreenShare,
        has_password: Boolean(password.trim()),
      });

      setSettingsOpen(false);
      goToRoom(room.code);
    } catch (error) {
      // SECTION 2: a start failure is reported under the START card only,
      // as startFailed — never as a missing room. The raw code is shown
      // alongside it: no masked errors, ever.
      console.error('CALL ERROR:', error);
      const failure = error as { code?: string; message?: string } | null;
      const code = failure?.code ?? '';

      // 42501 = the row-level policy refused the insert. Before naming a cause,
      // ask the DB who we actually are: the gate may simply be stale.
      if (code === '42501') {
        const truth = await readProfile();
        // Log BOTH sides, so the next occurrence identifies itself as
        // gate-staleness (gate ≠ db) or genuine DB truth (gate === db).
        console.error('CALL ERROR: 42501 gate check', {
          gate: { role: freshRole, plan: freshPlan },
          db: { role: truth.role, plan: truth.plan },
        });

        setFreshRole(truth.role);
        setFreshPlan(truth.plan);

        if (!isProvider(truth.role)) {
          // The account is not a provider. That is the whole truth, and no raw
          // code belongs in front of the user for it.
          setCanHost(false);
          setHostError(null);
          setHostErrorDetail(null);
          setNotProvider(true);
          return;
        }

        // Genuinely a provider: this is a real refusal, so report it as one.
        setHostError('call.startFailed');
        setHostErrorDetail(code);
        return;
      }

      setHostError('call.startFailed');
      setHostErrorDetail(failure?.code ?? failure?.message ?? String(error));
    } finally {
      setHostBusy(false);
    }
  };

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

      {/* The DB said this account is not a provider: say so plainly, with no
          raw code — the Start card is gone, so the message lives here. */}
      {notProvider ? (
        <p className="field-error" role="alert">
          {t('call.notProvider')}
        </p>
      ) : null}

      <div className="call-hub-grid">
        {/* Start a meeting — providers only. */}
        {canHost ? (
          <div className="panel">
            <div className="eyebrow">{t('call.startMeeting')}</div>
            <button
              className="primary-button call-join-trigger"
              type="button"
              onClick={() => setSettingsOpen(true)}
              disabled={hostBusy}
              aria-busy={hostBusy}
            >
              {t('call.startMeeting')}
            </button>
            {hostError ? (
              <span className="field-error">
                {t(hostError)}
                {hostErrorDetail ? (
                  <span className="error-detail">({hostErrorDetail})</span>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null}

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
            exactly three cards; the body degrades if the row is unavailable. */}
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

      {settingsOpen ? (
        <CallSettingsModal
          busy={hostBusy}
          onClose={() => setSettingsOpen(false)}
          onStart={(settings) => void startMeeting(settings)}
        />
      ) : null}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  joinForm: { display: 'grid', gap: '0.5rem' },
  lineRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.6rem',
    flexWrap: 'wrap',
  },
  lineChip: {
    // Light-surface skin; layout comes from .call-code-chip.
    background: 'var(--accent-soft, rgba(62, 169, 133, 0.14))',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    color: 'var(--accent-strong, #216e5d)',
  },
};
