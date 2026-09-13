import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { DEFAULT_CALL_PREFS, loadCallPrefs, type CallPrefs } from '../lib/callPrefs';

// ---------------------------------------------------------------------------
// Pre-meeting settings (host, opened from "Start meeting").
//
// Seeded from the host's saved profiles.call_prefs so the next meeting starts
// pre-configured. The password lives only in this component's local state as
// plaintext — it is never hashed here, never stored in prefs, never logged.
// ---------------------------------------------------------------------------

export type MeetingSettings = CallPrefs & { password: string };

type CallSettingsModalProps = {
  busy?: boolean;
  onClose: () => void;
  onStart: (settings: MeetingSettings) => void;
};

/** Switch-style toggle (mint theme). */
function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
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

export default function CallSettingsModal({ busy = false, onClose, onStart }: CallSettingsModalProps) {
  const { t } = useLang();
  const { user } = useAuth();

  const [prefs, setPrefs] = useState<CallPrefs>(DEFAULT_CALL_PREFS);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await loadCallPrefs(user?.id ?? '');
      if (cancelled) return;
      setPrefs(saved);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const toggle = (key: keyof CallPrefs) =>
    setPrefs((previous) => ({ ...previous, [key]: !previous[key] }));

  return (
    <div className="call-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="call-modal call-settings"
        role="dialog"
        aria-modal="true"
        aria-label={t('call.meetingSettings')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="call-modal-head">
          <strong>{t('call.meetingSettings')}</strong>
          <button type="button" className="call-modal-close" aria-label={t('common.close')} onClick={onClose}>
            ×
          </button>
        </div>

        {loading ? (
          <p className="call-switch-label" aria-busy="true">
            {t('places.searching')}
          </p>
        ) : (
          <>
            <Switch label={t('call.waitingRoom')} checked={prefs.waitingRoom} onChange={() => toggle('waitingRoom')} />

            <Switch
              label={t('call.requirePassword')}
              checked={prefs.requirePassword}
              onChange={() => toggle('requirePassword')}
            />

            {prefs.requirePassword ? (
              <label className="call-modal-field">
                <span>{t('call.requirePassword')}</span>
                <span className="call-password-row">
                  <input
                    className="input"
                    // Never rendered as the digest — this is the plaintext the
                    // host typed, and it is cleared when the modal closes.
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    aria-label={t('call.requirePassword')}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    className="ghost-button call-password-toggle"
                    aria-pressed={showPassword}
                    aria-label={showPassword ? t('common.close') : t('call.requirePassword')}
                    onClick={() => setShowPassword((shown) => !shown)}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
              </label>
            ) : null}

            <Switch label={t('call.autoMute')} checked={prefs.autoMute} onChange={() => toggle('autoMute')} />
            <Switch
              label={t('call.allowScreenShare')}
              checked={prefs.allowScreenShare}
              onChange={() => toggle('allowScreenShare')}
            />
          </>
        )}

        <div className="call-modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || loading}
            aria-busy={busy}
            onClick={() => onStart({ ...prefs, password })}
          >
            {t('call.startMeeting')}
          </button>
        </div>
      </div>
    </div>
  );
}
