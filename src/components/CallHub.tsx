import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
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

  const [canHost, setCanHost] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinNeedsPassword, setJoinNeedsPassword] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const [line, setLine] = useState<PersonalRoom | null>(null);
  const [lineBusy, setLineBusy] = useState(false);
  const [lineCopied, setLineCopied] = useState(false);

  // Can this account host a meeting? (doctor / department / hospital)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user?.id) return;
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      const role = String(
        (data as { role?: string } | null)?.role ?? user.user_metadata?.role ?? '',
      );
      setCanHost(isProvider(role));
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.user_metadata?.role]);

  // The personal line is created lazily, once, and keeps its code forever.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user?.id) return;
      const created = await ensurePersonalRoom(user.id);
      if (!cancelled) setLine(created);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const startMeeting = async (settings: MeetingSettings) => {
    setHostBusy(true);
    setHostError(null);
    try {
      // The plaintext password only travels into createRoom, which hashes it.
      const password = settings.requirePassword ? settings.password : '';

      // createRoom awaits the insert fully before returning the code, so the
      // row exists by the time the route guard looks for it.
      const { code } = await createRoom({
        password,
        lobbyEnabled: settings.waitingRoom,
        autoMute: settings.autoMute,
        allowShare: settings.allowScreenShare,
      });

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
      goToRoom(code);
    } catch (error) {
      console.error('CALL ERROR:', error);
      setHostError('call.roomNotFound');
    } finally {
      setHostBusy(false);
    }
  };

  const submitJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setJoinBusy(true);
    setJoinError(null);
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
      console.error('CALL ERROR:', error);
      setJoinError('call.roomNotFound');
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
            {hostError ? <span className="field-error">{t(hostError)}</span> : null}
          </div>
        ) : null}

        {/* Join a room — everyone. */}
        <div className="panel">
          <div className="eyebrow">{t('call.joinWithCode')}</div>
          <form style={styles.joinForm} onSubmit={(event) => void submitJoin(event)}>
            <input
              className="input"
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
        </div>

        {/* Your personal line. */}
        {line ? (
          <div className="panel">
            <div className="eyebrow">{t('call.personalCode')}</div>

            <div style={styles.lineRow}>
              <span className="call-code-chip" style={styles.lineChip} dir="ltr" title={line.code}>
                {line.code}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={copyLineCode}
                title={t('call.copyCode')}
                aria-label={`${t('call.copyCode')} — ${line.code}`}
              >
                {lineCopied ? t('call.copied') : `📋 ${t('call.copyCode')}`}
              </button>
            </div>

            <div style={styles.lineRow}>
              <span className="call-switch-label">{t('call.openLine')}</span>
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
          </div>
        ) : null}
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
