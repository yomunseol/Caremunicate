import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { useToast } from '../context/ToastContext';
import { supabase } from '../lib/supabase';
import SlimButton from './ui/SlimButton';

// ---------------------------------------------------------------------------
// Profile settings — change the display name, or delete the account.
//
// The name is written to profiles.full_name (keyed on user_id) and the caller
// is told to re-read the profile so the header updates immediately. Account
// deletion calls the founder-run delete_user() RPC, then signs out.
// ---------------------------------------------------------------------------

type AccountSettingsProps = {
  onProfileUpdated?: () => void;
};

export default function AccountSettings({ onProfileUpdated }: AccountSettingsProps) {
  const { user, signOut } = useAuth();
  const { t } = useLang();
  const { notify } = useToast();

  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!user) return;
      const { data } = await supabase
        .from('profiles')
        .select('full_name, username')
        .eq('user_id', user.id)
        .maybeSingle();

      if (cancelled) return;
      const row = data as { full_name?: string | null; username?: string | null } | null;
      setFullName(String(row?.full_name ?? row?.username ?? user.user_metadata?.fullName ?? ''));
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const saveName = async () => {
    if (!user || saving || !fullName.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ full_name: fullName.trim() })
        .eq('user_id', user.id);
      if (error) throw error;
      notify(t('account.nameSaved'), 'success');
      onProfileUpdated?.();
    } catch (error) {
      console.error('ACCOUNT NAME ERROR:', error);
      notify(t('account.nameFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const { error } = await supabase.rpc('delete_user');
      if (error) throw error;
      await signOut().catch(() => undefined);
      window.location.href = '/';
    } catch (error) {
      console.error('ACCOUNT DELETE ERROR:', error);
      notify(t('account.deleteFailed'), 'error');
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (!user) return null;

  return (
    <div className="panel account-settings">
      <div className="eyebrow">{t('account.settingsEyebrow')}</div>

      <label className="account-settings-row">
        <span>{t('auth.fullName')}</span>
        <input
          className="input"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
        />
      </label>

      <div className="account-settings-actions">
        <SlimButton
          variant="primary"
          disabled={saving || !fullName.trim()}
          aria-busy={saving}
          onClick={() => void saveName()}
        >
          {t('account.saveName')}
        </SlimButton>

        <SlimButton
          variant="secondary"
          className="account-danger"
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={15} aria-hidden="true" /> {t('account.deleteAccount')}
        </SlimButton>
      </div>

      {confirming
        ? createPortal(
            <div
              className="cal-modal-backdrop"
              role="presentation"
              onClick={() => {
                if (!deleting) setConfirming(false);
              }}
            >
              <div
                className="cal-modal"
                role="dialog"
                aria-modal="true"
                aria-label={t('account.deleteTitle')}
                onClick={(event) => event.stopPropagation()}
              >
                <h3 className="cal-modal-title">{t('account.deleteTitle')}</h3>
                <p className="cal-muted">{t('account.deleteConfirm')}</p>
                <div className="cal-modal-footer">
                  <SlimButton
                    variant="secondary"
                    disabled={deleting}
                    onClick={() => setConfirming(false)}
                  >
                    {t('common.cancel')}
                  </SlimButton>
                  <SlimButton
                    variant="primary"
                    className="account-danger"
                    disabled={deleting}
                    aria-busy={deleting}
                    onClick={() => void deleteAccount()}
                  >
                    {t('account.deleteAccount')}
                  </SlimButton>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
