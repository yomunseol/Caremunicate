import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCallContext } from '../context/CallContext';
import { checkRoom, normalizeCode } from '../lib/callRooms';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// /call/{code} — the entry point for a code room.
//
// The code is validated against check_call_room before the media engine is
// started, so a bad code, an ended room, or a wrong password can never open a
// call. On failure we surface the reason as a toast and return home.
// ---------------------------------------------------------------------------

type CallPageProps = {
  code: string;
};

const goHome = () => {
  window.location.hash = '#home';
};

export default function CallPage({ code }: CallPageProps) {
  const { t } = useLang();
  const { user } = useAuth();
  const { status, roomCode, notify, joinCall } = useCallContext();
  const [checking, setChecking] = useState(true);

  // Keyed by normalized code so a re-run never joins twice.
  const started = useRef<string | null>(null);
  const joined = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const normalized = normalizeCode(code);

    if (!normalized) {
      notify('room-not-found');
      goHome();
      return () => {
        cancelled = true;
      };
    }

    setChecking(true);

    const run = async () => {
      try {
        const result = await checkRoom(normalized);
        if (cancelled) return;

        if (!result || result.status === 'ended') {
          notify('room-not-found');
          goHome();
          return;
        }

        setChecking(false);

        if (started.current === normalized) return;
        started.current = normalized;
        joined.current = true;

        const isHost = Boolean(user && result.host_id && result.host_id === user.id);
        await joinCall(normalized, 'video', { isHost, code: normalized });
      } catch (error) {
        console.error('CALL ERROR:', error);
        if (cancelled) return;
        notify('room-not-found');
        goHome();
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [code, user, joinCall, notify]);

  // The engine left the room (hang up, or the host ended it for everyone); the
  // /call route has nothing left to show.
  useEffect(() => {
    if (!joined.current) return;
    if (status === 'ended' || status === 'idle') {
      joined.current = false;
      goHome();
    }
  }, [status]);

  return (
    <section className="section call-page">
      <p className="hero-copy" aria-busy={checking}>
        {t('call.connecting')}
      </p>
      {roomCode ? (
        <span className="call-page-code" dir="ltr">
          {roomCode}
        </span>
      ) : null}
    </section>
  );
}
