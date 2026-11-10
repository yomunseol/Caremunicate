import { useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';
import type { IncomingCall } from '../hooks/useCall';

// ---------------------------------------------------------------------------
// Incoming-call popup (top-right).
//
// Rendered globally, outside the header, so it can float above the call layer
// and every route. It appears as soon as a call is queued (inbox signal or a
// room invite), shows the caller's name + type and Accept/Decline for the
// focused call, and keeps a stacked "deck" when several callers ring at once.
// Emergency calls get the red skin.
// ---------------------------------------------------------------------------

export default function CallDeck() {
  const { t, tString } = useLang();
  const { incomingCalls, acceptIncoming, declineIncoming } = useCallContext();
  const [open, setOpen] = useState(false);

  if (incomingCalls.length === 0) return null;

  const top = incomingCalls[0];
  const layers = Math.min(incomingCalls.length, 3);
  const emergency = top.kind === 'emergency';

  const nameOf = (call: IncomingCall) => call.name || t('chat.participant');
  const kindOf = (call: IncomingCall) =>
    call.kind === 'emergency' ? t('call.kindEmergency') : t('call.kindVideo');

  return (
    <div
      className={emergency ? 'call-deck is-emergency' : 'call-deck'}
      role="region"
      aria-label={t('call.incoming')}
    >
      <div className="call-deck-card">
        <div className="call-deck-title">{t('call.incoming')}</div>

        <p className="call-deck-calling">
          {tString(emergency ? 'call.emergencyCallingAs' : 'call.callingAs', {
            name: nameOf(top),
          })}
        </p>

        <button
          type="button"
          className="call-deck-stack-trigger"
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

        <div className="call-deck-actions">
          <button
            type="button"
            className="call-deck-join"
            onClick={() => void acceptIncoming(top)}
          >
            <Phone size={14} aria-hidden="true" /> {t('call.accept')}
          </button>
          <button
            type="button"
            className="call-deck-decline"
            onClick={() => declineIncoming(top)}
          >
            <PhoneOff size={14} aria-hidden="true" /> {t('call.decline')}
          </button>
        </div>

        {incomingCalls.length > 1 ? (
          <button
            type="button"
            className="text-action call-deck-more"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {t('call.activeCalls')} ({incomingCalls.length})
          </button>
        ) : null}

        {open && incomingCalls.length > 1 ? (
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
                  {t('call.joinNow')}
                </button>
                <button
                  type="button"
                  className="call-deck-decline"
                  onClick={() => declineIncoming(call)}
                >
                  {t('call.decline')}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
