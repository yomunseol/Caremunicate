import { useEffect, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type TwoFactorMethod = 'none' | 'email' | 'authenticator';

const settingsCardStyle = {
  width: '100%',
  padding: '1.4rem',
  border: '1px solid rgba(62, 169, 133, 0.18)',
  borderRadius: '1.35rem',
  background: 'linear-gradient(180deg, rgba(250, 255, 252, 0.98), rgba(238, 249, 244, 0.92))',
  boxShadow: '0 22px 46px rgba(17, 55, 47, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
  color: '#133b35',
};

const cardContentStyle = {
  display: 'grid',
  gap: '0.85rem',
};

const eyebrowStyle = {
  margin: 0,
  color: '#3ea985',
  fontSize: '0.7rem',
  fontWeight: 800,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
};

const titleStyle = {
  margin: '0.2rem 0 0',
  fontSize: '1.15rem',
  lineHeight: 1.25,
};

const descriptionStyle = {
  margin: 0,
  color: '#557b76',
  fontSize: '0.86rem',
  lineHeight: 1.6,
};

const buttonStyle = {
  border: 'none',
  borderRadius: '999px',
  padding: '0.78rem 1rem',
  background: 'linear-gradient(120deg, #48b58f, #7adab1)',
  color: '#072c2a',
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryButtonStyle = {
  ...buttonStyle,
  border: '1px solid rgba(156, 54, 54, 0.18)',
  background: 'rgba(156, 54, 54, 0.07)',
  color: '#9c3636',
};

const inputStyle = {
  width: '100%',
  border: '1px solid rgba(15, 58, 50, 0.12)',
  borderRadius: '0.8rem',
  padding: '0.8rem 1rem',
  background: '#fff',
  fontSize: '1rem',
  letterSpacing: '0.08em',
};

const statusStyle = {
  margin: 0,
  color: '#216e5d',
  fontWeight: 700,
};

const errorStyle = {
  margin: 0,
  color: '#9c3636',
  fontWeight: 600,
};

const qrCardStyle = {
  display: 'grid',
  gap: '0.7rem',
  justifyItems: 'center',
  padding: '1rem',
  border: '1px solid rgba(62, 169, 133, 0.14)',
  borderRadius: '1rem',
  background: '#fff',
};

const methodRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  gap: '0.7rem',
  alignItems: 'center',
  padding: '0.8rem 1rem',
  border: '1px solid rgba(15, 58, 50, 0.12)',
  borderRadius: '0.9rem',
  background: '#fff',
  cursor: 'pointer',
};

const methodRadioStyle = {
  width: '1.05rem',
  height: '1.05rem',
  accentColor: '#3ea985',
  margin: 0,
};

const badgeStyle = {
  fontSize: '0.68rem',
  fontWeight: 800,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '0.2rem 0.5rem',
  borderRadius: '999px',
  whiteSpace: 'nowrap' as const,
};

function findTotpFactor(factors: Factor[] | undefined): Factor | null {
  return factors?.find((factor) => factor.factor_type === 'totp') ?? null;
}

async function getUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? '';
}

export default function TwoFactorSetup() {
  const [method, setMethod] = useState<TwoFactorMethod>('none');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [factorId, setFactorId] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');

  // Load the real state once: a TOTP factor from Supabase MFA, plus the
  // saved profile preference ('email' | 'authenticator' | 'none').
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');

      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      console.log('[2FA] listFactors response:', { data: factors, error: listError });
      const factor = listError ? null : findTotpFactor(factors?.all ?? []);
      console.log('[2FA] TOTP factor found:', factor ? factor.id : 'none');

      const userId = await getUserId();
      let savedMethod: TwoFactorMethod = 'none';
      if (userId) {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('preferred_2fa_method')
          .eq('user_id', userId)
          .maybeSingle();
        void profileError;
        if (profile) {
          const m = profile.preferred_2fa_method as TwoFactorMethod;
          savedMethod = m === 'email' || m === 'authenticator' ? m : 'none';
        }
      }

      if (cancelled) return;

      // A real TOTP factor always wins the display state.
      if (factor) {
        setFactorId(factor.id);
        setMethod('authenticator');
        if (userId) {
          await supabase
            .from('profiles')
            .update({ preferred_2fa_method: 'authenticator' })
            .eq('user_id', userId)
            .maybeSingle();
        }
      } else {
        setFactorId('');
        setMethod(savedMethod);
      }

      if (listError) setError(listError.message);
      setLoading(false);
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const savePreference = async (value: TwoFactorMethod) => {
    const userId = await getUserId();
    if (!userId) {
      console.log('[2FA] savePreference skipped: no user id.');
      return;
    }

    // Does the profile row already exist?
    const { data: existing, error: findError } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    console.log('[2FA] find existing profile:', { existing, error: findError });

    let result;
    if (findError) {
      console.error('[2FA] Could not check for profile:', findError.message);
      setError(findError.message);
      return;
    }

    if (existing) {
      result = await supabase
        .from('profiles')
        .update({ preferred_2fa_method: value })
        .eq('user_id', userId)
        .maybeSingle();
      console.log('Update Result:', result);
    } else {
      // No profile yet — insert one with the user_id.
      result = await supabase
        .from('profiles')
        .insert({ user_id: userId, preferred_2fa_method: value })
        .maybeSingle();
      console.log('Insert Result:', result);
    }

    if (result.error) {
      console.error('[2FA] savePreference error:', result.error.message);
      setError(result.error.message);
    }
  };

  const unenrollTotp = async (): Promise<boolean> => {
    if (!factorId) return true;
    console.log('[2FA] Unenrolling factor:', factorId);
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    console.log('[2FA] unenroll response:', { error });
    if (error) {
      setError(error.message);
      return false;
    }
    setFactorId('');
    setTotpUri('');
    setEnrolling(false);
    setVerificationCode('');
    return true;
  };

  const handleMethodChange = async (next: TwoFactorMethod) => {
    if (loading || next === method) return;
    setError('');
    setMessage('');
    setLoading(true);

    // Leaving authenticator: unenroll the live TOTP factor first.
    if (method === 'authenticator' && next !== 'authenticator') {
      const ok = await unenrollTotp();
      if (!ok) {
        setLoading(false);
        return;
      }
    }

    if (next === 'none') {
      setMethod('none');
      await savePreference('none');
      setMessage('Two-factor authentication is off.');
    } else if (next === 'email') {
      setMethod('email');
      await savePreference('email');
      setMessage('Email codes are now your two-factor method.');
    } else {
      // 'authenticator': kick off the TOTP enrollment wizard.
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      console.log('[2FA] enroll response:', { data, error: enrollError });
      if (enrollError) {
        setError(enrollError.message);
        setLoading(false);
        return;
      }
      if (data?.totp?.uri) {
        setFactorId(data.id);
        setTotpUri(data.totp.uri);
        setVerificationCode('');
        setMethod('none'); // selection is provisional until the code verifies.
        setEnrolling(true);
        console.log('[2FA] Enrollment started. Factor id:', data.id);
      } else {
        setError('Unable to start two-factor setup.');
      }
    }

    setLoading(false);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!factorId || !verificationCode.trim()) {
      setError('Enter the 6-digit authentication code.');
      return;
    }

    setLoading(true);
    setError('');

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
    console.log('[2FA] challenge response:', { data: challengeData, error: challengeError });

    if (challengeError) {
      setError(challengeError.message);
      setLoading(false);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code: verificationCode.trim(),
    });
    console.log('[2FA] verify response:', { error: verifyError });

    if (verifyError) {
      setError(verifyError.message);
      setLoading(false);
      return;
    }

    console.log('[2FA] Factor verified. 2FA is now active.');
    setTotpUri('');
    setVerificationCode('');
    setEnrolling(false);
    setMethod('authenticator');
    await savePreference('authenticator');
    setMessage('2FA is Active using your authenticator app.');
    setLoading(false);
  };

  const handleCancelEnroll = () => {
    setEnrolling(false);
    setTotpUri('');
    setVerificationCode('');
    setError('');
    // The unverified factor may still exist server-side; reconcile.
    void (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      const factor = listError ? null : findTotpFactor(data?.all ?? []);
      console.log('[2FA] After cancel, TOTP factor found:', factor ? factor.id : 'none');
      setFactorId(factor?.id ?? '');
      setMethod(factor ? 'authenticator' : 'none');
    })();
  };

  const active = method !== 'none';

  return (
    <section style={settingsCardStyle} aria-labelledby="two-factor-heading">
      <div style={cardContentStyle}>
        <div>
          <p style={eyebrowStyle}>Account security</p>
          <h2 id="two-factor-heading" style={titleStyle}>
            Two-Factor Authentication
          </h2>
          <p style={descriptionStyle}>
            Add an extra verification step when you sign in. Email codes are the default; you can use an authenticator app instead.
          </p>
        </div>

        {loading && <p style={statusStyle}>Checking two-factor status...</p>}
        {error && <p style={errorStyle} role="alert">{error}</p>}
        {message && <p style={statusStyle}>{message}</p>}

        {!enrolling ? (
          <>
            <label style={methodRowStyle}>
              <input
                type="radio"
                name="two-factor-method"
                checked={method === 'none'}
                onChange={() => void handleMethodChange('none')}
                disabled={loading}
                style={methodRadioStyle}
              />
              <span>
                <strong>No 2FA</strong>
                <br />
                <small style={{ color: '#557b76' }}>Sign in with just your email.</small>
              </span>
              {method === 'none' ? (
                <span style={{ ...badgeStyle, background: '#e7f0ee', color: '#216e5d' }}>Current</span>
              ) : null}
            </label>

            <label style={methodRowStyle}>
              <input
                type="radio"
                name="two-factor-method"
                checked={method === 'email'}
                onChange={() => void handleMethodChange('email')}
                disabled={loading}
                style={methodRadioStyle}
              />
              <span>
                <strong>Email code</strong>
                <br />
                <small style={{ color: '#557b76' }}>Receive a one-time 6-digit code at your email. Recommended.</small>
              </span>
              {method === 'email' ? (
                <span style={{ ...badgeStyle, background: '#e7f0ee', color: '#216e5d' }}>Active</span>
              ) : null}
            </label>

            <label style={methodRowStyle}>
              <input
                type="radio"
                name="two-factor-method"
                checked={method === 'authenticator'}
                onChange={() => void handleMethodChange('authenticator')}
                disabled={loading}
                style={methodRadioStyle}
              />
              <span>
                <strong>Authenticator app</strong>
                <br />
                <small style={{ color: '#557b76' }}>Use a rotating 6-digit code from an app like Google Authenticator.</small>
              </span>
              {method === 'authenticator' ? (
                <span style={{ ...badgeStyle, background: '#e7f0ee', color: '#216e5d' }}>Active</span>
              ) : null}
            </label>
          </>
        ) : null}

        {enrolling ? (
          <form onSubmit={handleVerify} style={{ display: 'grid', gap: '0.9rem' }}>
            <div style={qrCardStyle}>
              <QRCodeSVG value={totpUri} size={180} />
              <p style={{ margin: 0, color: '#557b76', fontSize: '0.9rem', textAlign: 'center' }}>
                Open an authenticator app such as Google Authenticator, Microsoft Authenticator, Authy, or 1Password.
                Choose “Add account,” scan this QR code with your phone camera, then type the 6-digit code it shows.
              </p>
            </div>

            <input
              style={inputStyle}
              value={verificationCode}
              onChange={(event) => setVerificationCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              placeholder="Enter 6-digit code"
              aria-label="Six-digit authentication code"
              disabled={loading}
              required
            />

            <button type="submit" style={buttonStyle} disabled={loading}>
              {loading ? 'Verifying...' : 'Verify and enable 2FA'}
            </button>

            <button type="button" style={secondaryButtonStyle} onClick={handleCancelEnroll} disabled={loading}>
              Cancel
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}
