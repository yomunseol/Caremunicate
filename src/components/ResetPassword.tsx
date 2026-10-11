import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { supabase } from '../lib/supabase';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// /reset-password — where a Supabase recovery email lands.
//
// Supabase puts the recovery tokens in the URL fragment; the browser client's
// detectSessionInUrl (constructed in lib/supabase.ts, before React renders)
// exchanges them for a session asynchronously. So a single getSession() can race
// the exchange and read null. We therefore await EITHER getSession() OR an
// onAuthStateChange event, with a 3s ceiling — after which the link is treated
// as expired. A missing session never yields a blank screen; the new password is
// written with updateUser(), and a failed write is recorded in public.email_log.
// ---------------------------------------------------------------------------

/** Same floor as signup, so the two screens cannot disagree. */
const MIN_LENGTH = 8;
/** How long to wait for the client to exchange the fragment tokens. */
const SESSION_GRACE_MS = 3000;

type Strength = 0 | 1 | 2 | 3 | 4;

const strengthColor = (strength: Strength): string =>
  strength >= 3 ? '#216e5d' : strength === 2 ? '#b8860b' : '#9c3636';

export default function ResetPassword() {
  const { t, locale } = useLang();

  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // Wait up to SESSION_GRACE_MS for the recovery session, watching both the
  // one-shot read and the auth-state stream so neither side of the race is lost.
  useEffect(() => {
    let cancelled = false;
    let settled = false;

    const finish = (session: { user?: { email?: string | null } } | null) => {
      if (cancelled || settled) return;
      settled = true;
      setHasSession(Boolean(session));
      setEmail(session?.user?.email ?? '');
      setChecking(false);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') finish(session);
    });

    const startedAt = Date.now();
    const poll = async () => {
      if (cancelled || settled) return;
      const { data } = await supabase.auth.getSession();
      if (cancelled || settled) return;
      if (data.session) {
        finish(data.session);
        return;
      }
      if (Date.now() - startedAt >= SESSION_GRACE_MS) {
        finish(null);
        return;
      }
      window.setTimeout(() => void poll(), 250);
    };
    void poll();

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  // 0–4: length, mixed case, digit, special — mirrors the signup rules.
  const strength = useMemo<Strength>(() => {
    let score = 0;
    if (password.length >= MIN_LENGTH) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[!@#$%^&*]/.test(password)) score += 1;
    return score as Strength;
  }, [password]);

  const strengthLabel =
    strength >= 3 ? t('reset.strength.strong') : strength === 2 ? t('reset.strength.fair') : t('reset.strength.weak');

  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const canSubmit =
    hasSession && password.length >= MIN_LENGTH && confirmPassword.length > 0 && !mismatch && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      console.log('Password update response:', { error: updateError });

      if (updateError) {
        setError(updateError.message);
        // CR4: record the failed update for diagnosis. Best-effort — the RLS
        // insert policy allows only type='recovery-ui' rows for authenticated.
        try {
          const { error: logError } = await supabase
            .from('email_log')
            .insert({ email, type: 'recovery-ui', locale, error: updateError.message });
          if (logError) console.error('recovery-ui email_log insert failed:', logError.message);
        } catch (logCaught) {
          console.error('recovery-ui email_log insert threw:', logCaught);
        }
        return;
      }

      // The recovery session is now a real session, so hand off to this repo's
      // post-auth route: the dashboard (#profile).
      setDone(true);
      window.setTimeout(() => {
        window.location.href = '/#profile';
      }, 1200);
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
        ) : done ? (
          <>
            <h2 id="reset-heading" style={styles.title}>{t('auth.resetTitle')}</h2>
            <p style={styles.success} role="status">{t('reset.success')}</p>
          </>
        ) : !hasSession ? (
          <>
            <h2 id="reset-heading" style={styles.title}>{t('auth.resetTitle')}</h2>
            <p style={styles.error} role="alert">{t('reset.invalidLink')}</p>
            <button type="button" className="primary-button" onClick={backToLogin}>
              {t('reset.requestNew')}
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
              <div style={styles.strengthRow}>
                <div
                  style={styles.strengthTrack}
                  role="img"
                  aria-label={`${t('auth.password')}: ${strengthLabel}`}
                >
                  {[0, 1, 2, 3].map((segment) => (
                    <span
                      key={segment}
                      style={{
                        ...styles.strengthSegment,
                        background: segment < strength ? strengthColor(strength) : '#e2ece9',
                      }}
                    />
                  ))}
                </div>
                <span style={{ ...styles.strengthLabel, color: strengthColor(strength) }}>
                  {strengthLabel}
                </span>
              </div>
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
              <p style={styles.error} role="alert">{t('auth.err.passwordMismatch')}</p>
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
  strengthRow: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  strengthTrack: { display: 'flex', flex: 1, gap: '0.25rem' },
  strengthSegment: { height: '6px', flex: 1, borderRadius: '999px', transition: 'background 0.15s ease' },
  strengthLabel: { fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap' },
  error: { margin: 0, color: '#9c3636', fontWeight: 600, fontSize: '0.88rem' },
  success: { margin: 0, color: '#216e5d', fontWeight: 700, fontSize: '0.9rem' },
};
