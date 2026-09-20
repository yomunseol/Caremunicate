import { useEffect, useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// /reset-password — where a Supabase recovery email lands.
//
// Supabase puts the recovery tokens in the URL fragment and the client's
// detectSessionInUrl consumes them, so either a session exists here or the link
// was expired or already used. No session → say so and offer the way back;
// never a blank screen. The new password is written with updateUser().
// ---------------------------------------------------------------------------

/** Same floor as signup, so the two screens cannot disagree. */
const MIN_LENGTH = 8;

export default function ResetPassword() {
  const { t } = useLang();
  const { notify } = useToast();

  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setHasSession(Boolean(data.session));
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const strongEnough = password.length >= MIN_LENGTH;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const canSubmit = hasSession && strongEnough && confirmPassword.length > 0 && !mismatch && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      console.log('Password update response:', { error: updateError });

      if (updateError) {
        setError(updateError.message);
        return;
      }

      notify(t('auth.passwordUpdated'), 'success');
      // Leave the recovery session behind, then land on a clean sign-in once the
      // toast has had a beat to be seen.
      await supabase.auth.signOut();
      window.setTimeout(() => {
        window.location.href = '/#login';
      }, 900);
    } finally {
      setBusy(false);
    }
  };

  const backToLogin = () => {
    window.location.href = '/#login';
  };

  return (
    <section className="section" aria-labelledby="reset-heading">
      <div style={styles.card}>
        <div className="eyebrow">{t('common.appName')}</div>

        {checking ? (
          <p className="cal-muted" aria-busy="true">{t('places.searching')}</p>
        ) : !hasSession ? (
          <>
            <h2 id="reset-heading" style={styles.title}>{t('auth.resetTitle')}</h2>
            {/* Not supplied by the spec — needs its 10-locale string. */}
            <p style={styles.error} role="alert">
              This recovery link is invalid or has expired.
            </p>
            <button type="button" className="primary-button" onClick={backToLogin}>
              {t('login.backToSignIn')}
            </button>
          </>
        ) : (
          <>
            <h2 id="reset-heading" style={styles.title}>{t('auth.resetTitle')}</h2>

            <div style={styles.field}>
              <label style={styles.label} htmlFor="rp-password">{t('auth.password')}</label>
              <input
                id="rp-password"
                className="input ltr-isolate"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
              <span style={strongEnough ? styles.ruleMet : styles.rule}>
                {t('auth.ruleLength')}
              </span>
            </div>

            <div style={styles.field}>
              <label style={styles.label} htmlFor="rp-confirm">{t('auth.confirmPassword')}</label>
              <input
                id="rp-confirm"
                className="input ltr-isolate"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={busy}
              />
            </div>

            {mismatch ? (
              /* Not supplied by the spec — needs its 10-locale string. */
              <p style={styles.error} role="alert">Passwords do not match.</p>
            ) : null}
            {error ? <p style={styles.error} role="alert">{error}</p> : null}

            <button
              type="button"
              className="primary-button"
              disabled={!canSubmit}
              aria-busy={busy}
              onClick={() => void submit()}
            >
              {t('auth.resetTitle')}
            </button>

            <button type="button" className="ghost-button" onClick={backToLogin}>
              {t('login.backToSignIn')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    display: 'grid',
    gap: '0.75rem',
    width: 'min(26rem, 100%)',
    marginInline: 'auto',
    padding: '1.4rem',
    borderRadius: '1.35rem',
    background: 'linear-gradient(180deg, rgba(250, 255, 252, 0.98), rgba(238, 249, 244, 0.92))',
    border: '1px solid rgba(62, 169, 133, 0.18)',
    boxShadow: '0 22px 46px rgba(17, 55, 47, 0.1)',
    color: '#133b35',
  },
  title: { margin: 0, fontSize: '1.15rem' },
  field: { display: 'grid', gap: '0.4rem' },
  label: { fontSize: '0.75rem', fontWeight: 700, color: '#216e5d', letterSpacing: '0.04em' },
  rule: { fontSize: '0.75rem', fontWeight: 700, color: '#9db3ad' },
  ruleMet: { fontSize: '0.75rem', fontWeight: 700, color: '#216e5d' },
  error: { margin: 0, color: '#9c3636', fontWeight: 600, fontSize: '0.88rem' },
};
