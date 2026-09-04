import { useState, type FormEvent } from 'react';
import type { AuthResponse, Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type View = 'password' | '2fa_code' | 'error';

function findTotpFactor(factors: Factor[] | undefined): Factor | null {
  return factors?.find((factor) => factor.factor_type === 'totp' && factor.status === 'verified') ?? null;
}

export default function PasswordAuth() {
  const [view, setView] = useState<View>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!email.trim() || !password) {
      setView('error');
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
    console.log('Auth Response:', response);
    const { data, error: signInError } = response;

    if (signInError) {
      console.log('Auth Response (error):', signInError);
      setView('error');
      setError('Invalid email or password');
      setLoading(false);
      return;
    }

    console.log('Auth Response (session):', data.session);

    // Detect 2FA: check whether the user has a verified TOTP factor.
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    console.log('MFA Factors:', factors);
    console.log('MFA Factors (error):', listError);

    const factor = listError ? null : findTotpFactor(factors?.all ?? []);
    console.log('MFA Factors (totp):', factor);

    if (listError) {
      // Treat a listing error as "can't confirm 2FA" — fail closed.
      setView('error');
      setError(listError.message);
      setLoading(false);
      return;
    }

    if (factor) {
      // Case B: user has 2FA. Store the factorId and ask for the code.
      console.log('2FA required. Factor id:', factor.id);
      setFactorId(factor.id);
      setCode('');
      setView('2fa_code');
      setLoading(false);
      return;
    }

    // Case A: no 2FA — the password session is already valid.
    console.log('No 2FA. Logging in.');
    window.location.hash = 'profile';
  };

  const handleCodeSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const token = code.trim();
    if (!token) {
      setView('2fa_code');
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
      setView('2fa_code');
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
      setView('2fa_code');
      setError(verifyError.message);
      setCode('');
      setLoading(false);
      return;
    }

    console.log('2FA verified. Logging in.');
    window.location.hash = 'profile';
  };

  const goBackToPassword = () => {
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
    center: { textAlign: 'center' as const },
  };

  return (
    <div style={styles.card} role="form" aria-label="Secure sign in">
      <div>
        <p style={styles.eyebrow}>Secure access</p>
        <h2 style={styles.title}>
          {view === '2fa_code' ? 'Enter your 2FA code' : 'Welcome back'}
        </h2>
        <p style={styles.description}>
          {view === '2fa_code'
            ? 'Enter the 6-digit code from your authenticator app to finish signing in.'
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

      {view === '2fa_code' ? (
        <form onSubmit={handleCodeSubmit} style={{ display: 'grid', gap: '0.85rem' }}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="pa-totp">Authenticator code</label>
            <input
              id="pa-totp"
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
            Use a different account
          </button>
        </form>
      ) : null}
    </div>
  );
}
