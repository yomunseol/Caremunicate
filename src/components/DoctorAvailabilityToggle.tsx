import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useLang } from '../i18n';
import { supabase } from '../lib/supabase';
import { describeError } from '../lib/errors';

// ---------------------------------------------------------------------------
// Provider availability — the switch patients see reflected in the Doctors
// directory (profiles.is_chattable). Shown for every provider role.
// ---------------------------------------------------------------------------

export default function DoctorAvailabilityToggle() {
  const { user } = useAuth();
  const { notify } = useToast();
  const { t } = useLang();

  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setLoading(false);
      return;
    }

    void (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('is_chattable')
        .eq('user_id', user.id)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        console.error('Doctor Availability Error:', error);
      } else if (
        data &&
        typeof (data as { is_chattable?: unknown }).is_chattable === 'boolean'
      ) {
        setAvailable(Boolean((data as { is_chattable: boolean }).is_chattable));
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const toggle = async () => {
    if (!user?.id || busy) return;
    const next = !available;
    const previous = available;
    setAvailable(next);
    setBusy(true);

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ is_chattable: next })
        .eq('user_id', user.id);

      if (error) {
        console.error('Doctor Availability Error:', error);
        setAvailable(previous);
        notify(`${t('available_for_chat')} (${describeError(error)})`, 'error');
      }
    } catch (error) {
      console.error('Doctor Availability Error:', error);
      setAvailable(previous);
      notify(t('available_for_chat'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="call-switch-row">
        <span className="call-switch-label">{t('available_for_chat')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={available}
          aria-label={t('available_for_chat')}
          className={available ? 'call-switch is-on' : 'call-switch'}
          disabled={busy || loading}
          onClick={() => void toggle()}
        >
          <span className="call-switch-knob" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
