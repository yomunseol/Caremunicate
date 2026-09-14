import { useState } from 'react';
import { Activity, LayoutGrid, Lock, LockOpen, Maximize, UserMinus, Users, X } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';
import CallDevicePicker from './CallDevicePicker';

// ---------------------------------------------------------------------------
// The "⋮" overflow menu — every secondary action lives here so the main bar
// stays minimal. Nothing in here is load-bearing for the call itself: the view
// toggle, fullscreen, device settings, the stats drawer, and the host-only
// section (waiting room, lock, password, participant removal).
//
// All of these controls previously sat on the call bar or in a separate
// security panel; the logic behind them is unchanged.
// ---------------------------------------------------------------------------

type CallOverflowMenuProps = {
  view: 'gallery' | 'speaker';
  statsOpen: boolean;
  onToggleView: () => void;
  onFullscreen: () => void;
  onToggleStats: () => void;
  onClose: () => void;
};

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <div className="call-switch-row">
      <span className="call-switch-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={checked ? 'call-switch is-on' : 'call-switch'}
        onClick={onChange}
      >
        <span className="call-switch-knob" aria-hidden="true" />
      </button>
    </div>
  );
}

export default function CallOverflowMenu({
  view,
  statsOpen,
  onToggleView,
  onFullscreen,
  onToggleStats,
  onClose,
}: CallOverflowMenuProps) {
  const { t } = useLang();
  const {
    isHost,
    policy,
    updatePolicy,
    setMeetingPassword,
    participants,
    kickPeer,
    devices,
    micId,
    camId,
    selectMic,
    selectCamera,
  } = useCallContext();

  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const applyPassword = async () => {
    setSaving(true);
    try {
      await setMeetingPassword(password);
      // The plaintext is dropped the instant the digest is written.
      setPassword('');
    } catch (error) {
      console.error('CALL ERROR:', error);
    } finally {
      setSaving(false);
    }
  };

  const remotes = participants.filter((person) => !person.self);

  return (
    <div className="call-overflow" role="dialog" aria-label={t('call.participants')}>
      <div className="call-overflow-head">
        <strong>{t('call.participants')}</strong>
        <button type="button" className="call-panel-close" aria-label={t('common.close')} onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <button type="button" className="call-overflow-item" onClick={onToggleView}>
        {view === 'gallery' ? <Users size={16} /> : <LayoutGrid size={16} />}
        <span>{view === 'gallery' ? t('call.speakerView') : t('call.galleryView')}</span>
      </button>

      <button type="button" className="call-overflow-item" onClick={onFullscreen}>
        <Maximize size={16} />
        <span>Fullscreen</span>
      </button>

      <div className="call-overflow-section">
        <span className="call-overflow-section-title">Settings</span>
        <CallDevicePicker
          compact
          mics={devices.mics}
          cams={devices.cams}
          micId={micId}
          camId={camId}
          onSelectMic={(id) => void selectMic(id)}
          onSelectCamera={(id) => void selectCamera(id)}
        />
      </div>

      <button
        type="button"
        className={statsOpen ? 'call-overflow-item is-on' : 'call-overflow-item'}
        aria-pressed={statsOpen}
        onClick={onToggleStats}
      >
        <Activity size={16} />
        <span>Call stats</span>
      </button>

      {isHost && policy ? (
        <div className="call-overflow-section">
          <span className="call-overflow-section-title">{t('call.hostControls')}</span>

          <Switch
            label={t('call.waitingRoom')}
            checked={policy.lobby_enabled}
            onChange={() => updatePolicy({ lobby_enabled: !policy.lobby_enabled })}
          />

          <Switch
            label={policy.locked ? t('call.unlockMeeting') : t('call.lockMeeting')}
            checked={policy.locked}
            onChange={() => updatePolicy({ locked: !policy.locked })}
          />

          <div className="call-overflow-password">
            <span className="call-switch-label">{t('call.requirePassword')}</span>
            <span className="call-password-row">
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                aria-label={t('call.requirePassword')}
                placeholder={policy.has_password ? '••••••••' : ''}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="ghost-button"
                disabled={saving}
                aria-busy={saving}
                onClick={() => void applyPassword()}
              >
                {policy.has_password ? <Lock size={15} /> : <LockOpen size={15} />}
              </button>
            </span>
          </div>

          <span className="call-switch-label">{t('call.removeParticipant')}</span>
          <ul className="call-overflow-list">
            {remotes.length === 0 ? (
              <li className="call-overflow-empty">—</li>
            ) : (
              remotes.map((person) => (
                <li key={person.id} className="call-overflow-row">
                  <span className="call-overflow-name">{person.name || t('chat.participant')}</span>
                  <button
                    type="button"
                    className="call-overflow-remove"
                    title={t('call.removeParticipant')}
                    aria-label={`${t('call.removeParticipant')} — ${person.name}`}
                    onClick={() => kickPeer(person.id)}
                  >
                    <UserMinus size={14} aria-hidden="true" />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
