import { useEffect, useState, type FormEvent } from 'react';
import type { AuthResponse } from '@supabase/supabase-js';
import {
  resetMemoryAuthClient,
  supabase,
  supabaseMemory,
} from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { isAuthAllowed, recordAuthAttempt } from '../lib/authRateLimit';
import CodePanel from './CodePanel';
import PasswordResetFlow from './PasswordResetFlow';

type View = 'password' | 'email_code';
type TwoFactorMethod = 'none' | 'email' | 'app';

interface PasswordAuthProps {
  onAuthenticated?: () => void;
}

export default function PasswordAuth({ onAuthenticated }: PasswordAuthProps) {
  const { setPending2FA } = useAuth();
  const { t, locale } = useLang();
  const [view, setView] = useState<View>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  // Yellow, non-blocking notice shown when the OTP send fails. It never stops
  // the code-entry view from rendering.
  const [sendNotice, setSendNotice] = useState('');
  // The inline "Forgot password?" panel, shown under the password field.
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  // Clear only the memory-only trap client. Never sign out the persistent
  // client here: doing so instantly logs out a valid session restored on the
  // login screen.
  useEffect(() => {
    void resetMemoryAuthClient();
    setPending2FA(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Final step for every no-2FA success path. Clear any pending flag, then
  // hard-redirect: a full page load bypasses any React state that may not have
  // flushed after the async auth flow (same pattern as the 2FA verify
  // handlers below).
  const goToProfile = () => {
    setPending2FA(false);
    console.log('Redirecting to dashboard now');
    window.location.href = '/dashboard';
  };

  // Sends (or resends) the email code through the first-party CR3 path. The
  // locale is passed EXPLICITLY from UI state; the function always falls back to
  // English for an unknown locale, so no locale can silence the code. The
  // boolean is authoritative (the function logs and returns false on failure
  // instead of raising), and a false still surfaces a yellow notice without
  // dead-ending the code-entry view.
  const sendEmailCode = async (): Promise<boolean> => {
    const { data, error: sendError } = await supabaseMemory.rpc('request_2fa_code', {
      p_locale: locale,
    });
    console.log('Branch C (email): request_2fa_code response:', { data, error: sendError });

    if (sendError || data !== true) {
      console.log('2FA code send error:', sendError);
      setSendNotice(t('tfa.sendError'));
      return false;
    }

    setSendNotice('');
    return true;
  };

  // Step 1: The Password Trap.
  // Verify the password with a memory-only client so NOTHING is persisted to
  // localStorage yet. Fetch the user's 2FA preference from profiles and branch.
  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!email.trim() || !password) {
      setError(t('login.err.enterBoth'));
      return;
    }

    if (!(await isAuthAllowed(email))) {
      setError(t('auth.rateLimited'));
      return;
    }

    setLoading(true);
    setError('');
    setMessage('');

    try {
      const response: AuthResponse = await supabaseMemory.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      console.log('Password Response:', response);
      const { data, error: signInError } = response;

      if (signInError) {
        console.log('Password Response (error):', signInError);
        await recordAuthAttempt(email, false);
        setError(t('login.err.invalidCredentials'));
        return;
      }

      console.log('Password verified, session NOT persisted');
      console.log('Password Response (session):', data.session?.user);

      // This is a MEMORY-ONLY session on supabaseMemory. The real client still
      // has no session and AuthContext still reports user === null.
      const userId = data.session?.user.id ?? '';
      const { data: profile, error: profileError } = await supabaseMemory
        .from('profiles')
        .select('preferred_2fa_method')
        .eq('user_id', userId)
        .maybeSingle();
      console.log('Profile Fetch:', { profile, error: profileError });

      // A missing profile row (new users) returns data: null — maybeSingle()
      // never throws for zero rows. A query error is logged, not fatal: the
      // flow continues with the default 'none' preference below.
      if (profileError) {
        console.log('Profile Fetch (error):', profileError);
      }

      let preference: TwoFactorMethod = 'none';
      if (profile?.preferred_2fa_method === 'email' || profile?.preferred_2fa_method === 'app') {
        preference = profile.preferred_2fa_method;
      }
      // 2FA is EMAIL-ONLY now. If the user has any authenticator (TOTP) factor,
      // force it off: unenroll it and reset the profile preference to 'none'.
      // Email / already-off users are left untouched.
      const { data: factorsData } = await supabaseMemory.auth.mfa.listFactors();
      const totpFactors = (factorsData?.all ?? []).filter(
        (factor) => factor.factor_type === 'totp',
      );
      if (totpFactors.length > 0 || preference === 'app') {
        for (const factor of totpFactors) {
          const { error: unenrollError } = await supabaseMemory.auth.mfa.unenroll({
            factorId: factor.id,
          });
          if (unenrollError) console.log('TOTP unenroll failed:', unenrollError);
        }
        const { error: prefError } = await supabaseMemory
          .from('profiles')
          .update({ preferred_2fa_method: 'none' })
          .eq('user_id', userId);
        if (prefError) console.log('2FA preference reset failed:', prefError);
        preference = 'none';
      }
      await recordAuthAttempt(email, true);

      console.log('Resolved 2FA preference:', preference);

      // Branch A: no 2FA. This is the ONLY branch where we now create the real
      // persistent session — password verified on the memory client, then a real
      // sign-in on the persistent client that saves to localStorage.
      if (preference === 'none') {
        console.log('Branch A (none): creating persistent session.');
        const persistent = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        console.log('Branch A (none): persistent session response:', {
          data: persistent.data,
          error: persistent.error,
        });

        if (persistent.error) {
          setError(persistent.error.message);
          setLoading(false);
          return;
        }

        console.log('2FA complete, persistent session created');
        goToProfile();
        return;
      }

      // User requires 2FA. Mark them pending so the app never treats them as
      // logged in until the final step below creates the real session.
      setPending2FA(true);

      // Email 2FA. Trigger a native email OTP code, then always show
      // the code entry view — even if the send failed.
      if (preference === 'email') {
        await sendEmailCode();
        console.log('Branch C (email): switching to email_code view (send errors are non-fatal).');
        setCode('');
        setView('email_code');
        setLoading(false);
        return;
      }

      // Unknown preference value — default to allowing sign-in.
      console.log('Unknown 2FA preference. Creating persistent session.');
      const persistent = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (persistent.error) {
        setPending2FA(false);
        setError(persistent.error.message);
        setLoading(false);
        return;
      }
      console.log('2FA complete, persistent session created');
      goToProfile();
    } catch (caughtError) {
      console.log('LOGIN CRASHED:', caughtError);
      setError(caughtError instanceof Error ? caughtError.message : t('auth.msg.errorGeneric'));
    } finally {
      // Guaranteed reset: runs on every return, throw, or fallthrough above,
      // so the submit button can never stay stuck on 'Signing in...'.
      setLoading(false);
    }
  };

  // Branch C final step: email code. Verify the OTP on the MEMORY client, then
  // explicitly create the persistent session with the returned tokens.
  const verifyEmailCode = async (tokenValue: string) => {
    if (loading) return;

    const token = tokenValue.trim();
    if (!token) {
      setError(t('login.err.enterEmailCode'));
      return;
    }

    if (!(await isAuthAllowed(email))) {
      setError(t('auth.rateLimited'));
      return;
    }

    setLoading(true);
    setError('');
    setMessage('');
    console.log('Verification attempt started');

    try {
      // CR3: the code lives only in our own store (request_2fa_code hashed it),
      // so it is checked by verify_2fa_code — never native verifyOtp.
      const { data: verified, error } = await supabaseMemory.rpc('verify_2fa_code', {
        p_code: token,
      });
      console.log('Email code verify response:', { verified, error });

      if (error || verified !== true) {
        await recordAuthAttempt(email, false);
        setError(t('login.err.unableVerify'));
        setCode('');
        return;
      }

      // The password already verified in step 1 on the memory client, so a
      // persistent sign-in here creates the real session — no tokens to promote.
      const persistent = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      console.log('Branch C (email): code verified. Persistent session:', {
        data: persistent.data,
        error: persistent.error,
      });

      if (persistent.error) {
        setError(persistent.error.message);
        setCode('');
        return;
      }

      await recordAuthAttempt(email, true);
      console.log('2FA complete, persistent session created');

      // Clear all pending-2FA state so the app treats the user as fully
      // authenticated, then hard-redirect. A full page load bypasses any
      // React state that may not have flushed after the async auth flow.
      setPending2FA(false);
      console.log('Redirecting to dashboard now');
      window.location.href = '/dashboard';
    } catch (caughtError) {
      console.error('Verification attempt error:', caughtError);
      setError(caughtError instanceof Error ? caughtError.message : t('login.err.unableVerify'));
      setCode('');
    } finally {
      setLoading(false);
      console.log('Verification attempt finished');
    }
  };

  const handleEmailCodeSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void verifyEmailCode(code);
  };

  const goBackToPassword = () => {
    setPending2FA(false);
    setView('password');
    setError('');
    setMessage('');
    setCode('');
    setSendNotice('');
  };

  const styles = {
    card: {
      width: '100%',
      color: 'var(--text, #133b35)',
      display: 'grid',
      gap: '0.7rem',
    },
    description: { margin: 0, color: 'var(--text-muted, #557b76)', fontSize: '0.86rem', lineHeight: 1.6 },
    field: { display: 'grid', gap: '0.35rem' },
    label: { fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-strong, #216e5d)', letterSpacing: '0.04em' },
    error: { margin: 0, color: '#9c3636', fontWeight: 600, fontSize: '0.9rem' },
    message: { margin: 0, color: 'var(--accent-strong, #216e5d)', fontWeight: 600, fontSize: '0.9rem' },
    notice: {
      margin: 0,
      padding: '0.6rem 0.8rem',
      border: '1px solid #f0d27a',
      borderRadius: '0.7rem',
      background: '#fff7d6',
      color: '#8a6d1a',
      fontSize: '0.82rem',
      fontWeight: 600,
      lineHeight: 1.45,
    },
    resendRow: { display: 'flex', gap: '0.5rem', alignItems: 'stretch' },
    linkButton: {
      justifySelf: 'start',
      border: 'none',
      padding: 0,
      background: 'transparent',
      color: 'var(--accent-strong, #216e5d)',
      fontWeight: 700,
      fontSize: '0.82rem',
      textDecoration: 'underline',
      cursor: 'pointer',
    },
    recoveryPanel: {
      display: 'grid',
      gap: '0.6rem',
      padding: '0.8rem',
      border: '1px solid rgba(62, 169, 133, 0.28)',
      borderRadius: '0.9rem',
      background: 'rgba(62, 169, 133, 0.06)',
    },
    recoveryDone: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.45rem',
      margin: 0,
      color: 'var(--accent-strong, #216e5d)',
      fontWeight: 700,
      fontSize: '0.88rem',
    },
    resendButton: {
      border: '1px solid rgba(62, 169, 133, 0.3)',
      borderRadius: '999px',
      padding: '0.6rem 0.9rem',
      background: 'transparent',
      color: 'var(--accent-strong, #216e5d)',
      fontWeight: 700,
      cursor: 'pointer',
      fontSize: '0.82rem',
      whiteSpace: 'nowrap' as const,
    },
    resendButtonDisabled: { opacity: 0.55, cursor: 'not-allowed' as const },
  };

  const isCodeView = view === 'email_code';

  return (
    <div style={styles.card} role="form" aria-label={t('login.eyebrow')}>
      {view === 'email_code' ? (
        <p style={styles.description}>
          {sendNotice
            ? t('login.descEmailEnter', { email: email.trim() })
            : t('login.descEmailSent', { email: email.trim() })}
        </p>
      ) : null}

      {error ? <p style={styles.error} role="alert">{error}</p> : null}
      {message ? <p style={styles.message}>{message}</p> : null}

      {view === 'password' ? (
        <form onSubmit={handlePasswordSubmit} style={{ display: 'grid', gap: '0.7rem' }}>
          <div className="field-wrap">
            <input
              id="pa-email"
              className="input"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              placeholder={t('auth.email')}
              aria-label={t('auth.email')}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="field-wrap">
            <input
              id="pa-password"
              className="input"
              type="password"
              autoComplete="current-password"
              autoCapitalize="none"
              enterKeyHint="go"
              placeholder={t('login.labelPassword')}
              aria-label={t('login.labelPassword')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button type="submit" className="primary-button" style={{ justifySelf: 'start' }} disabled={loading}>
            {loading ? t('login.signingIn') : t('login.signIn')}
          </button>

          {/* "Forgot password?" sits under the password field and opens the
              inline recovery panel. A plain <div>, never a nested <form>. */}
          <button
            type="button"
            style={styles.linkButton}
            onClick={() => setRecoveryOpen((open) => !open)}
            disabled={loading}
          >
            {t('auth.forgotPassword')}
          </button>
        </form>
      ) : null}

      {/* The recovery flow has its own <form>; keeping it outside the login form
          avoids invalid nested forms and lets its submit fire normally. */}
      {view === 'password' && recoveryOpen ? (
        <div style={styles.recoveryPanel}>
          <PasswordResetFlow
            initialEmail={email}
            onCancel={() => setRecoveryOpen(false)}
            onSuccess={() => {
              setRecoveryOpen(false);
              setPassword('');
              setView('password');
              setError('');
              setMessage(t('auth.passwordResetSuccess'));
            }}
          />
        </div>
      ) : null}

      {view === 'email_code' ? (
        <form onSubmit={handleEmailCodeSubmit} style={{ display: 'grid', gap: '0.7rem' }}>
          {sendNotice ? <p style={styles.notice} role="status">{sendNotice}</p> : null}

          <div style={styles.field}>
            <label style={styles.label}>{t('login.labelEmailCode')}</label>
            <CodePanel
              value={code}
              onChange={setCode}
              disabled={loading}
              autoFocus
              isError={Boolean(error)}
              onResend={sendEmailCode}
              resendDisabled={loading}
              onComplete={(next) => {
                if (!loading) void verifyEmailCode(next);
              }}
            />
          </div>

          <button type="submit" className="primary-button" style={{ justifySelf: 'start' }} disabled={loading}>
            {loading ? t('tfa.verifying') : t('login.verifyAndSignIn')}
          </button>

          <button type="button" className="ghost-button" style={{ justifySelf: 'start' }} onClick={goBackToPassword} disabled={loading}>
            {t('login.changeEmail')}
          </button>
        </form>
      ) : null}

      {isCodeView && !loading ? (
        <p style={{ ...styles.message, textAlign: 'center' }}>
          {t('login.signedInAs', { email: email.trim() })}
        </p>
      ) : null}
    </div>
  );
}
