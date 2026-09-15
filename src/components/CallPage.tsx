import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCallContext } from '../context/CallContext';
import { resolveJoin, type JoinRefusal } from '../lib/callRooms';
import { normalizeCode } from '../lib/wordcode';
import { takeCreatedRoom, takePendingPolicy } from '../lib/callPrefs';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// /call/<param> — the route guard.
//
// The SAME guard the hub uses (resolveJoin) runs here, so the two can never
// disagree. The parameter may be a word code OR a UUID; either way the store is
// opened with the UUID and the URL is canonicalized to the word code.
//
// The room then opens into the GREEN ROOM (or the waiting room for a guest).
// No media is announced and no peer connection is built until "Join now".
// ---------------------------------------------------------------------------

type CallPageProps = {
  code: string;
};

/** Refusal -> the toast key the app already ships. */
const REFUSAL_NOTICE: Record<Exclude<JoinRefusal, 'password'>, string> = {
  roomNotFound: 'room-not-found',
  meetingLocked: 'meeting-locked',
  lineClosed: 'line-closed',
  meetingFull: 'meeting-full',
};

const goHome = () => {
  window.location.hash = '#home';
};

/** A refused join lands back on the hub, where another room can be chosen. */
const goToHub = () => {
  window.location.hash = '#call';
};

export default function CallPage({ code }: CallPageProps) {
  const { t } = useLang();
  const { user } = useAuth();
  const { status, stage, roomCode, notify, openRoom } = useCallContext();

  const [checking, setChecking] = useState(true);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The REAL message when the guard itself threw — shown in dev only. */
  const [guardError, setGuardError] = useState<string | null>(null);

  // Keyed by the canonical code so a re-run never opens the room twice.
  const opened = useRef<string | null>(null);
  // Only redirect once we have actually been somewhere (green room / lobby /
  // session), so the initial idle state does not bounce us straight home.
  const sawActivity = useRef(false);

  const runGuard = useCallback(
    async (secret: string, allowRetry: boolean) => {
      const normalized = normalizeCode(code);
      if (!normalized) {
        notify('room-not-found');
        goHome();
        return;
      }

      // Host path: the room was created a moment ago and handed over. Open it
      // by id — no RPC, no read-after-write race, channel call:${room.id}.
      const created = secret ? null : takeCreatedRoom(normalized);
      if (created) {
        window.history.replaceState({}, '', `/call/${created.code}`);
        setError(null);
        setNeedsPassword(false);
        setChecking(false);

        if (opened.current !== created.code) {
          opened.current = created.code;
          await openRoom(created.id, {
            isHost: true,
            code: created.code,
            personal: false,
            lobby: false,
            policy: takePendingPolicy() ?? undefined,
          });
        }
        return;
      }

      setBusy(true);
      setGuardError(null);
      try {
        let verdict = await resolveJoin(normalized, { password: secret, userId: user?.id });

        // Insert / replication race: a doctor who just created the room can
        // land here a beat before the row is readable. One retry, then we
        // believe the answer — this is what killed "Cannot find meeting".
        if (allowRetry && !verdict.ok && verdict.reason === 'roomNotFound') {
          await new Promise((resolve) => window.setTimeout(resolve, 300));
          verdict = await resolveJoin(normalized, { password: secret, userId: user?.id });
        }

        if (!verdict.ok) {
          if (verdict.reason === 'password') {
            setNeedsPassword(true);
            setError(secret ? t('call.wrongPassword') : null);
            setChecking(false);
            return;
          }

          // Every refusal is surfaced as a toast, and lands back on the hub.
          setChecking(false);
          notify(REFUSAL_NOTICE[verdict.reason]);
          goToHub();
          return;
        }

        // Canonical URL: words only. A UUID (or a hash-style link) becomes
        // /call/<words>.
        if (normalized !== verdict.code) {
          window.history.replaceState({}, '', `/call/${verdict.code}`);
        }

        setError(null);
        setNeedsPassword(false);
        setChecking(false);

        if (opened.current === verdict.code) return;
        opened.current = verdict.code;

        // Host: prefer the policy chosen in the settings modal.
        const pendingPolicy = verdict.isHost ? takePendingPolicy() : null;

        await openRoom(verdict.key, {
          isHost: verdict.isHost,
          code: verdict.code,
          personal: verdict.personal,
          lobby: verdict.lobby,
          policy: pendingPolicy ?? verdict.policy,
        });
      } catch (caught) {
        // A throw is the RPC failing or our own bug — never a missing room.
        // SECTION 2: log it, show the REAL message in a dev banner, and stay
        // put rather than mislabelling it roomNotFound and bouncing home.
        console.error('CALL ERROR:', caught);
        const failure = caught as { code?: string; message?: string } | null;
        // Raw Postgres/Supabase code first, then the message. No masking.
        setGuardError(failure?.code ?? failure?.message ?? String(caught));
        setChecking(false);
      } finally {
        setBusy(false);
      }
    },
    [code, user?.id, openRoom, notify, t],
  );

  useEffect(() => {
    void runGuard('', true);
  }, [runGuard]);

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runGuard(password, false);
  };

  // Track that we left the entry state at least once.
  useEffect(() => {
    if (stage !== 'idle' || status !== 'idle') sawActivity.current = true;
  }, [stage, status]);

  // The room ended (host ended it, or we were denied) → nothing left to show.
  useEffect(() => {
    if (status === 'ended') {
      goHome();
      return;
    }
    // Backed out of the green room / lobby: idle again with no room attached.
    if (sawActivity.current && stage === 'idle' && status === 'idle' && !roomCode) {
      goHome();
    }
  }, [status, stage, roomCode]);

  // Visible dev banner carrying the REAL guard message. Production shows a
  // neutral line instead — but never "room not found".
  const devBanner = guardError ? (
    <div className="call-dev-banner" role="alert">
      {import.meta.env.DEV ? (
        <>
          Guard threw: <span className="error-detail">{guardError}</span>
        </>
      ) : (
        t('call.connecting')
      )}
    </div>
  ) : null;

  if (needsPassword) {
    return (
      <section className="section call-page">
        {devBanner}
        <div className="call-modal-backdrop" role="presentation">
          <form
            className="call-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('call.enterPassword')}
            onSubmit={submitPassword}
          >
            <div className="call-modal-head">
              <strong>{t('call.enterPassword')}</strong>
            </div>

            <label className="call-modal-field">
              <span>{t('call.enterPassword')}</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                aria-label={t('call.enterPassword')}
                value={password}
                autoFocus
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
              />
            </label>

            {error ? <span className="field-error">{error}</span> : null}

            <div className="call-modal-actions">
              <button type="button" className="ghost-button" onClick={goHome}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="primary-button" disabled={busy} aria-busy={busy}>
                {t('call.joinWithCode')}
              </button>
            </div>
          </form>
        </div>
      </section>
    );
  }

  return (
    <section className="section call-page">
      {devBanner}
      <p className="hero-copy" aria-busy={checking}>
        {error ?? t('call.connecting')}
      </p>
    </section>
  );
}
