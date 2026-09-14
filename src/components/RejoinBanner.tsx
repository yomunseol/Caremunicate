import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCallContext } from '../context/CallContext';
import { resolveJoin } from '../lib/callRooms';
import { forgetActiveRoom, readActiveRoom } from '../lib/callPrefs';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// "Rejoin meeting?" banner.
//
// The call store records the room code while a tab is in a call, so a reload
// (or an accidental back-navigation) can offer to drop straight back in. The
// room is re-checked first: if it ended, locked, filled up or now needs a
// password, the marker is dropped and no banner appears.
// ---------------------------------------------------------------------------

export default function RejoinBanner() {
  const { t } = useLang();
  const { user } = useAuth();
  const { roomCode } = useCallContext();
  const [room, setRoom] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const code = readActiveRoom();
      if (!code) return;

      try {
        const verdict = await resolveJoin(code, { userId: user?.id });
        if (cancelled) return;

        if (verdict.ok) {
          setRoom(verdict.code);
        } else {
          // Not rejoinable any more — stop offering.
          forgetActiveRoom();
        }
      } catch (error) {
        console.error('CALL ERROR:', error);
        forgetActiveRoom();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Already in a call: nothing to offer.
  if (!room || roomCode) return null;

  const dismiss = () => {
    forgetActiveRoom();
    setRoom(null);
  };

  return (
    <div className="rejoin-banner" role="status">
      <span className="rejoin-text">{t('call.rejoinMeeting')}</span>
      <span className="call-code-chip rejoin-chip" dir="ltr" title={room}>
        {room}
      </span>
      <button
        type="button"
        className="primary-button"
        onClick={() => {
          window.location.hash = `#call/${room}`;
        }}
      >
        {t('call.joinNow')}
      </button>
      <button type="button" className="ghost-button" onClick={dismiss}>
        {t('common.cancel')}
      </button>
    </div>
  );
}
