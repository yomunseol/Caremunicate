import { useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';
import type { IncomingCall } from '../hooks/useCall';

// ---------------------------------------------------------------------------
// CallDeck — the multi-call notification surface.
//
// A single ringing call is handled by CallLayer's standard incoming card. When
// more than one call is ringing (or when a call is already live and another
// rings in), this renders the stacked "deck of cards" in the header. Clicking
// the stack opens a list with Join / Decline per call. One live session at a
// time: joining a queued call ends the current one in the call store.
// ---------------------------------------------------------------------------

export default function CallDeck() {
  const { t } = useLang();
  const { incomingCalls, status, acceptIncoming, declineIncoming } = useCallContext();
  const [open, setOpen] = useState(false);

  if (incomingCalls.length === 0) return null;
  // One focused ring: the full CallLayer card owns it.
  if (incomingCalls.length === 1 && status === 'incoming') return null;

  const top = incomingCalls[0];
  const layers = Math.min(incomingCalls.length, 3);

  const nameOf = (call: IncomingCall) => call.name || t('chat.participant');
  const kindOf = (call: IncomingCall) =>
    call.kind === 'emergency' ? t('call.kindEmergency') : t('call.kindVideo');

  return (
    <div className="call-deck">
      <button
        type="button"
        className="call-deck-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('call.activeCalls')}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="call-deck-stack" aria-hidden="true">
          {/* Deeper cards first so the nearest back card paints above them. */}
          {Array.from({ length: layers - 1 }, (_, index) => {
            const depth = layers - 1 - index;
            return <span key={depth} className="call-deck-back" data-depth={depth} />;
          })}
          <span className="call-deck-front">
            <span className="call-deck-name">{nameOf(top)}</span>
            <span className="call-deck-kind">{kindOf(top)}</span>
          </span>
        </span>
      </button>

      {open ? (
        <div className="call-deck-menu" role="menu" aria-label={t('call.activeCalls')}>
          <div className="call-deck-title">{t('call.activeCalls')}</div>
          <ul className="call-deck-list">
            {incomingCalls.map((call) => (
              <li className="call-deck-row" key={`${call.roomId}:${call.from}`}>
                <div className="call-deck-row-copy">
                  <strong>{nameOf(call)}</strong>
                  <span>{kindOf(call)}</span>
                </div>
                <button
                  type="button"
                  className="call-deck-join"
                  onClick={() => void acceptIncoming(call)}
                >
                  <Phone size={13} aria-hidden="true" /> {t('call.joinNow')}
                </button>
                <button
                  type="button"
                  className="call-deck-decline"
                  onClick={() => declineIncoming(call)}
                >
                  <PhoneOff size={13} aria-hidden="true" /> {t('call.decline')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
