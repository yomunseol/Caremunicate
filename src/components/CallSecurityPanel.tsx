import { useState } from 'react';
import { Eye, EyeOff, ShieldCheck, X } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// In-call Security panel (host only).
//
// Live toggles write through to call_rooms and are broadcast as `call:policy`.
// The password row hashes on submit: the plaintext is a local state value that
// is cleared immediately, and the digest is written and discarded — it is never
// held in state, rendered, or logged.
// ---------------------------------------------------------------------------

type CallSecurityPanelProps = {
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

export default function CallSecurityPanel({ onClose }: CallSecurityPanelProps) {
  const { t } = useLang();
  const { policy, isHost, updatePolicy, setMeetingPassword } = useCallContext();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!isHost || !policy) return null;

  const applyPassword = async () => {
    setSaving(true);
    try {
      await setMeetingPassword(password);
      // Drop the plaintext as soon as the digest has been written.
      setPassword('');
      setShowPassword(false);
    } catch (error) {
      console.error('CALL ERROR:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="call-security" role="dialog" aria-label={t('call.security')}>
      <header className="call-security-head">
        <strong>
          <ShieldCheck size={15} aria-hidden="true" /> {t('call.security')}
        </strong>
        <button type="button" className="call-modal-close" aria-label={t('common.close')} onClick={onClose}>
          <X size={15} />
        </button>
      </header>

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

      <Switch
        label={t('call.autoMute')}
        checked={policy.auto_mute}
        onChange={() => updatePolicy({ auto_mute: !policy.auto_mute })}
      />

      <Switch
        label={t('call.allowScreenShare')}
        checked={policy.allow_share}
        onChange={() => updatePolicy({ allow_share: !policy.allow_share })}
      />

      <div className="call-security-password">
        <span className="call-switch-label">
          {t('call.requirePassword')}
        </span>
        <span className="call-password-row">
          <input
            className="input"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            aria-label={t('call.requirePassword')}
            placeholder={policy.has_password ? '••••••••' : ''}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button
            type="button"
            className="ghost-button call-password-toggle"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((shown) => !shown)}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </span>
        <button
          type="button"
          className="ghost-button call-security-save"
          disabled={saving}
          aria-busy={saving}
          onClick={() => void applyPassword()}
        >
          Set new password
        </button>
      </div>
    </aside>
  );
}
