import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCallContext } from '../context/CallContext';
import { checkRoom, normalizeCode } from '../lib/callRooms';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// /call/{code} — the entry point for a code room.
//
// check_call_room gates entry, then the room opens into the GREEN ROOM (or the
// waiting room for a guest when the room has one). No media is announced and no
// peer connection is built here — that happens on "Join now" in CallLayer.
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
  const { status, stage, roomCode, notify, openRoom } = useCallContext();
  const [checking, setChecking] = useState(true);

  // Keyed by normalized code so a re-run never opens the room twice.
  const opened = useRef<string | null>(null);
  // Only redirect once we have actually been somewhere (green room / lobby /
  // session), so the initial idle state does not bounce us straight home.
  const sawActivity = useRef(false);

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

        if (opened.current === normalized) return;
        opened.current = normalized;

        const isHost = Boolean(user && result.host_id && result.host_id === user.id);
        // The waiting room is only enforced when the RPC explicitly says so.
        const lobby = result.lobby_enabled === true;

        await openRoom(normalized, { isHost, code: normalized, lobby });
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
  }, [code, user, openRoom, notify]);

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

  return (
    <section className="section call-page">
      <p className="hero-copy" aria-busy={checking}>{t('call.connecting')}</p>
    </section>
  );
}
