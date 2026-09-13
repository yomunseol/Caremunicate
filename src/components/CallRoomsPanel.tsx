import { useState, type FormEvent } from 'react';
import { useLang } from '../i18n';
import { checkRoom, createRoom, normalizeCode } from '../lib/callRooms';

// ---------------------------------------------------------------------------
// Call rooms panel.
//
// Hosting (providers only): pick an optional password, generate a 4-word code,
// and land in /call/{code}.
// Joining (everyone): type a code; if the room is password-protected the panel
// reveals a password step before letting the caller through.
//
// The room itself is validated again by the /call/{code} route, so this panel
// only ever *navigates* — it never opens a call directly.
// ---------------------------------------------------------------------------

type CallRoomsPanelProps = {
  /** True for doctor / department / hospital accounts. */
  canHost: boolean;
};

export default function CallRoomsPanel({ canHost }: CallRoomsPanelProps) {
  const { t } = useLang();

  const [hostPassword, setHostPassword] = useState('');
  const [hostBusy, setHostBusy] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  // Waiting room defaults ON, as specified.
  const [waitingRoom, setWaitingRoom] = useState(true);

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinNeedsPassword, setJoinNeedsPassword] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const enterRoom = (code: string) => {
    // Fires hashchange, which the app router already listens for.
    window.location.hash = `#call/${code}`;
  };

  const closeJoin = () => {
    setJoinOpen(false);
    setJoinCode('');
    setJoinPassword('');
    setJoinNeedsPassword(false);
    setJoinError(null);
    setJoinBusy(false);
  };

  const startMeeting = async () => {
    setHostBusy(true);
    setHostError(null);
    try {
      const code = await createRoom(hostPassword, waitingRoom);
      enterRoom(code);
      setHostPassword('');
    } catch (error) {
      console.error('CALL ERROR:', error);
      setHostError('call.roomNotFound');
    } finally {
      setHostBusy(false);
    }
  };

  const submitJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeCode(joinCode);
    if (!normalized) {
      setJoinError('call.roomNotFound');
      return;
    }

    setJoinBusy(true);
    setJoinError(null);
    try {
      const result = await checkRoom(normalized, joinNeedsPassword ? joinPassword : '');
      if (!result || result.status === 'ended') {
        setJoinError('call.roomNotFound');
        return;
      }

      if (result.has_password && !result.ok) {
        // Reveal the password step and let the visitor try again.
        setJoinNeedsPassword(true);
        if (joinNeedsPassword) setJoinError('call.wrongPassword');
        return;
      }

      closeJoin();
      enterRoom(normalized);
    } catch (error) {
      console.error('CALL ERROR:', error);
      setJoinError('call.roomNotFound');
    } finally {
      setJoinBusy(false);
    }
  };

  return (
    <div className="panel call-rooms-panel">
      <div className="eyebrow">{t('dash.videoTitle')}</div>

      {canHost ? (
        <div className="call-host-form">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={t('call.passwordOptional')}
            aria-label={t('call.passwordOptional')}
            value={hostPassword}
            onChange={(event) => setHostPassword(event.target.value)}
          />
          <button
            className="primary-button"
            type="button"
            onClick={() => void startMeeting()}
            disabled={hostBusy}
            aria-busy={hostBusy}
          >
            {t('call.startMeeting')}
          </button>
        </div>
      ) : null}

      {canHost ? (
        <label className="call-waiting-toggle">
          <input
            type="checkbox"
            checked={waitingRoom}
            onChange={(event) => setWaitingRoom(event.target.checked)}
          />
          <span>{t('call.waitingForHost')}</span>
        </label>
      ) : null}

      <button
        className="ghost-button call-join-trigger"
        type="button"
        onClick={() => {
          setJoinOpen(true);
          setJoinError(null);
        }}
      >
        {t('call.joinWithCode')}
      </button>

      {hostError ? <span className="field-error">{t(hostError)}</span> : null}

      {joinOpen ? (
        <div className="call-modal-backdrop" role="presentation" onClick={closeJoin}>
          <form
            className="call-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('call.joinWithCode')}
            onSubmit={(event) => void submitJoin(event)}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="call-modal-head">
              <strong>{t('call.joinWithCode')}</strong>
              <button
                type="button"
                className="call-modal-close"
                aria-label={t('common.close')}
                onClick={closeJoin}
              >
                ×
              </button>
            </div>

            <label className="call-modal-field">
              <span>{t('call.callCode')}</span>
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
            </label>

            {joinNeedsPassword ? (
              <label className="call-modal-field">
                <span>{t('call.enterPassword')}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  aria-label={t('call.enterPassword')}
                  value={joinPassword}
                  onChange={(event) => {
                    setJoinPassword(event.target.value);
                    setJoinError(null);
                  }}
                />
              </label>
            ) : null}

            {joinError ? <span className="field-error">{t(joinError)}</span> : null}

            <div className="call-modal-actions">
              <button type="button" className="ghost-button" onClick={closeJoin}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="primary-button" disabled={joinBusy} aria-busy={joinBusy}>
                {t('call.joinWithCode')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
