import { useEffect, useState } from 'react';
import { CalendarPlus, Hash, Phone, X } from 'lucide-react';
import { useLang } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useCallContext } from '../context/CallContext';
import { isValidWordCode, normalizeCode } from '../lib/wordcode';
import type { BookableProvider } from './BookingFlow';

// ---------------------------------------------------------------------------
// The patient's "Video call" bottom sheet.
//
// Three destinations, and every one of them is live:
//   1. Call your care team — joins the assigned doctor's personal room, but
//      ONLY while that line is 'active'. Otherwise the row is disabled and says
//      why ('line closed') instead of failing at the RPC.
//   2. Join with code — a 4-word code, straight to that room.
//   3. Book appointment — hands off to the booking modal.
//
// The doctor's line is looked up on open, so the first option is never a guess.
// ---------------------------------------------------------------------------

type VideoCallSheetProps = {
  careTeam: { userId: string; name: string } | null;
  onClose: () => void;
  onBook: () => void;
};

export default function VideoCallSheet({ careTeam, onClose, onBook }: VideoCallSheetProps) {
  const { t } = useLang();
  const { startCall } = useCallContext();
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  const [code, setCode] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Ring the care team directly; the callee's inbox shows the call popup.
  const callCareTeam = () => {
    if (!careTeam?.userId) return;
    onClose();
    void startCall(careTeam.userId, 'video', careTeam.name);
  };

  // The button stays disabled until the input is a real 4-word code, so there is
  // no invented "invalid code" string and no way to submit junk.
  const codeReady = isValidWordCode(code);

  const joinWithCode = () => {
    if (!codeReady) return;
    window.location.hash = `#call/${normalizeCode(code)}`;
  };

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={trapRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('dash.videoCall')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-grabber" aria-hidden="true" />

        <div className="sheet-head">
          <h3 className="sheet-title">{t('dash.videoCall')}</h3>
          <button type="button" className="cal-icon-btn ghost-button" aria-label={t('common.close')} onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="sheet-options">
          {/* 1. Ring the care team — a direct video call request. */}
          <button
            type="button"
            className="sheet-option"
            onClick={callCareTeam}
            disabled={!careTeam}
          >
            <span className="sheet-option-icon" aria-hidden="true">
              <Phone size={17} />
            </span>
            <span className="sheet-option-copy">
              <strong>{t('call.callCareTeam')}</strong>
              <span className="sheet-option-note">{careTeam?.name ?? t('call.lineClosed')}</span>
            </span>
          </button>

          {/* 2. Join any room by its 4-word code. */}
          <form
            className="sheet-option sheet-option-form"
            onSubmit={(event) => {
              event.preventDefault();
              joinWithCode();
            }}
          >
            <span className="sheet-option-icon" aria-hidden="true">
              <Hash size={17} />
            </span>
            <span className="sheet-option-copy">
              <strong>{t('call.joinWithCode')}</strong>
              {/* The format is a literal, so it needs no translation. */}
              <input
                className="input ltr-isolate"
                dir="ltr"
                value={code}
                placeholder="word-word-word-word"
                aria-label={t('call.joinWithCode')}
                autoComplete="off"
                onChange={(event) => setCode(event.target.value)}
              />
            </span>
            <button
              type="submit"
              className="primary-button"
              disabled={!codeReady}
              title={t('call.joinWithCode')}
            >
              {t('call.joinCall')}
            </button>
          </form>

          {/* 3. Hand off to booking. */}
          <button
            type="button"
            className="sheet-option"
            onClick={() => {
              onClose();
              onBook();
            }}
          >
            <span className="sheet-option-icon" aria-hidden="true">
              <CalendarPlus size={17} />
            </span>
            <span className="sheet-option-copy">
              <strong>{t('cal.bookAppointment')}</strong>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export type { BookableProvider };
