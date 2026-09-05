import { useState, type FormEvent } from 'react';
import type { AuthResponse, Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

type View = 'password' | 'app_code' | 'email_code';
type TwoFactorMethod = 'none' | 'email' | 'app';

interface PasswordAuthProps {
  onAuthenticated?: () => void;
}

function findTotpFactor(factors: Factor[] | undefined): Factor | null {
  return factors?.find((factor) => factor.factor_type === 'totp' && factor.status === 'verified') ?? null;
}

export default function PasswordAuth({ onAuthenticated }: PasswordAuthProps) {
  const { setPending2FA } = useAuth();
  const [view, setView] = useState<View>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  // Central navigation used after every successful auth step. Prefer the
  // parent-provided callback (App's navigate uses pushState + setRoute
  // together), and fall back to a hash change otherwise.
  const goToProfile = () => {
    setPending2FA(false);

    if (onAuthenticated) {
      onAuthenticated();
      return;
    }

    window.location.hash = 'profile';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!email.trim() || !password) {
      setError('Please enter both email and password.');
      return;
    }

    setLoading(true);
    setError('');
    setMessage('');

    const response: AuthResponse = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    console.log('Password Response:', response);
    const { data, error: signInError } = response;

    if (signInError) {
      console.log('Password Response (error):', signInError);
      setError('Invalid credentials');
      setLoading(false);
      return;
    }

    console.log('Password Response (session):', data.session?.user);

    // Fetch this user's saved 2FA preference from the profiles table.
    const userId = data.session?.user.id ?? '';
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('preferred_2fa_method')
      .eq('user_id', userId)
      .maybeSingle();
    console.log('Profile Fetch:', { profile, error: profileError });

    const preference = (profile?.preferred_2fa_method as TwoFactorMethod | undefined) ?? 'none';
    console.log('2FA preference:', preference);

    // Branch A: no 2FA.
    if (preference === 'none') {
      console.log('Branch A (none): redirecting to profile.');
      goToProfile();
      return;
    }

    setPending2FA(true);

    // Branch B: authenticator app 2FA.
    if (preference === 'app') {
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      console.log('Intercepted Factors:', factors);
      console.log('MFA Factors (error):', listError);

      const factor = listError ? null : findTotpFactor(factors?.all ?? []);
      console.log('Branch B (app): matched totp factor:', factor);

      if (listError) {
        // Fail closed — cannot confirm the factor, so block sign-in.
        setPending2FA(false);
        setError(listError.message);
        setLoading(false);
        return;
      }

      if (factor) {
        // Hold the factor id and show the authenticator code screen.
        console.log('Branch B (app): requiring authenticator code. Factor id:', factor.id);
        setFactorId(factor.id);
        setCode('');
        setView('app_code');
        setLoading(false);
        return;
      }

      // Preference says 'app' but no verified factor exists — allow sign-in
      // rather than locking the user out of a stale preference.
      console.log('Branch B (app): no verified totp factor despite preference. Logging in.');
      goToProfile();
      return;
    }

    // Branch C: email 2FA. Trigger a native email OTP code.
    if (preference === 'email') {
      const { data: otpData, error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false },
      });
      console.log('Branch C (email): signInWithOtp response:', { data: otpData, error: otpError });

      if (otpError) {
        setPending2FA(false);
        setError(otpError.message);
        setLoading(false);
        return;
      }

      console.log('Branch C (email): email code sent. Switching to email_code view.');
      setCode('');
      setView('email_code');
      setLoading(false);
      return;
    }

    // Unknown preference value — default to allowing sign-in.
    console.log('Unknown 2FA preference. Logging in.');
    goToProfile();
  };

  const handleAppCodeSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const token = code.trim();
    if (!token) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setLoading(true);
    setError('');
    setMessage('');

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });
    console.log('Challenge Response:', { data: challengeData, error: challengeError });

    if (challengeError || !challengeData) {
      setError(challengeError?.message ?? 'Unable to start verification.');
      setLoading(false);
      return;
    }

    const { data: verifyData, error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code: token,
    });
    console.log('Verify Response:', { data: verifyData, error: verifyError });

    if (verifyError) {
      setError(verifyError.message);
      setCode('');
      setLoading(false);
      return;
    }

    console.log('Branch B (app): 2FA verified. Logging in.');
    goToProfile();
  };

  const handleEmailCodeSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const token = code.trim();
    if (!token) {
      setError('Enter the 6-digit code from your email.');
      return;
    }

    setLoading(true);
    setError('');
    setMessage('');

    const { data, error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: 'email',
    });
    console.log('Email OTP Verify Response:', { data, error });

    if (error) {
      setError(error.message);
      setCode('');
      setLoading(false);
      return;
    }

    console.log('Branch C (email): email code verified. Logging in.');
    // Explicitly navigate to the profile. This is the ONLY place the user
    // should leave the login screen after email 2FA — never redirect on the
    // auth session event alone.
    goToProfile();
  };

  const goBackToPassword = () => {
    setPending2FA(false);
    setView('password');
    setError('');
    setMessage('');
    setCode('');
  };

  const styles = {
    card: {
      width: '100%',
      padding: '1.4rem',
      border: '1px solid rgba(62, 169, 133, 0.18)',
      borderRadius: '1.35rem',
      background: 'linear-gradient(180deg, rgba(250, 255, 252, 0.98), rgba(238, 249, 244, 0.92))',
      boxShadow: '0 22px 46px rgba(17, 55, 47, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
      color: '#133b35',
      display: 'grid',
      gap: '0.85rem',
    },
    eyebrow: {
      margin: 0,
      color: '#3ea985',
      fontSize: '0.7rem',
      fontWeight: 800,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
    },
    title: { margin: '0.2rem 0 0', fontSize: '1.15rem', lineHeight: 1.25 },
    description: { margin: 0, color: '#557b76', fontSize: '0.86rem', lineHeight: 1.6 },
    input: {
      width: '100%',
      border: '1px solid rgba(15, 58, 50, 0.12)',
      borderRadius: '0.8rem',
      padding: '0.8rem 1rem',
      background: '#fff',
      fontSize: '1rem',
      color: '#133b35',
    },
    field: { display: 'grid', gap: '0.4rem' },
    label: { fontSize: '0.75rem', fontWeight: 700, color: '#216e5d', letterSpacing: '0.04em' },
    primaryButton: {
      border: 'none',
      borderRadius: '999px',
      padding: '0.78rem 1rem',
      background: 'linear-gradient(120deg, #48b58f, #7adab1)',
      color: '#072c2a',
      fontWeight: 700,
      cursor: 'pointer',
      fontSize: '0.95rem',
    },
    ghostButton: {
      border: '1px solid rgba(62, 169, 133, 0.3)',
      borderRadius: '999px',
      padding: '0.6rem 1rem',
      background: 'transparent',
      color: '#216e5d',
      fontWeight: 700,
      cursor: 'pointer',
      fontSize: '0.85rem',
    },
    error: { margin: 0, color: '#9c3636', fontWeight: 600, fontSize: '0.9rem' },
    message: { margin: 0, color: '#216e5d', fontWeight: 600, fontSize: '0.9rem' },
  };

  const isCodeView = view === 'app_code' || view === 'email_code';

  return (
    <div style={styles.card} role="form" aria-label="Secure sign in">
      <div>
        <p style={styles.eyebrow}>Secure access</p>
        <h2 style={styles.title}>
          {view === 'app_code'
            ? 'Enter your authenticator code'
            : view === 'email_code'
              ? 'Enter your email code'
              : 'Welcome back'}
        </h2>
        <p style={styles.description}>
          {view === 'app_code'
            ? 'Enter the 6-digit code from your authenticator app to finish signing in.'
            : view === 'email_code'
              ? `A 6-digit code was sent to ${email.trim()}. Enter it below to finish signing in.`
              : 'Sign in with your email and password.'}
        </p>
      </div>

      {error ? <p style={styles.error} role="alert">{error}</p> : null}
      {message ? <p style={styles.message}>{message}</p> : null}

      {view === 'password' ? (
        <form onSubmit={handlePasswordSubmit} style={{ display: 'grid', gap: '0.85rem' }}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="pa-email">Email</label>
            <input
              id="pa-email"
              style={styles.input}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="pa-password">Password</label>
            <input
              id="pa-password"
              style={styles.input}
              type="password"
              autoComplete="current-password"
              placeholder="Your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button type="submit" style={styles.primaryButton} disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      ) : null}

      {view === 'app_code' ? (
        <form onSubmit={handleAppCodeSubmit} style={{ display: 'grid', gap: '0.85rem' }}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="pa-app-code">Authenticator code</label>
            <input
              id="pa-app-code"
              style={{ ...styles.input, letterSpacing: '0.2em', textAlign: 'center' }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              placeholder="000000"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button type="submit" style={styles.primaryButton} disabled={loading}>
            {loading ? 'Verifying...' : 'Verify and sign in'}
          </button>

          <button type="button" style={styles.ghostButton} onClick={goBackToPassword} disabled={loading}>
            Back to sign in
          </button>
        </form>
      ) : null}

      {view === 'email_code' ? (
        <form onSubmit={handleEmailCodeSubmit} style={{ display: 'grid', gap: '0.85rem' }}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="pa-email-code">Email code</label>
            <input
              id="pa-email-code"
              style={{ ...styles.input, letterSpacing: '0.2em', textAlign: 'center' }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              placeholder="000000"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button type="submit" style={styles.primaryButton} disabled={loading}>
            {loading ? 'Verifying...' : 'Verify and sign in'}
          </button>

          <button type="button" style={styles.ghostButton} onClick={goBackToPassword} disabled={loading}>
            Change email
          </button>
        </form>
      ) : null}

      {isCodeView && !loading ? (
        <p style={{ ...styles.message, textAlign: 'center' }}>
          Signed in as {email.trim()}
        </p>
      ) : null}
    </div>
  );
}
