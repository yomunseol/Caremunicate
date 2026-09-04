import { useEffect, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

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

function findTotpFactor(factors: Factor[] | undefined): Factor | null {
  return factors?.find((factor) => factor.factor_type === 'totp') ?? null;
}

export default function TwoFactorSetup() {
  const [isMfaEnabled, setIsMfaEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [factorId, setFactorId] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [enrolling, setEnrolling] = useState(false);

  const refreshFactors = async () => {
    setLoading(true);
    setError('');

    const { data, error: listError } = await supabase.auth.mfa.listFactors();

    if (listError) {
      setError(listError.message);
    } else {
      const factor = findTotpFactor(data?.all ?? []);
      setIsMfaEnabled(Boolean(factor));
      setFactorId(factor?.id ?? '');
    }

    setLoading(false);
  };

  useEffect(() => {
    void refreshFactors();
  }, []);

  const handleEnable = async () => {
    setLoading(true);
    setError('');
    setVerificationCode('');

    const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp' });

    if (enrollError) {
      setError(enrollError.message);
    } else if (data?.totp?.uri) {
      setEnrolling(true);
      setFactorId(data.id);
      setTotpUri(data.totp.uri);
    } else {
      setError('Unable to start two-factor setup.');
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

    if (verifyError) {
      setError(verifyError.message);
    } else {
      setIsMfaEnabled(true);
      setEnrolling(false);
      setTotpUri('');
      setVerificationCode('');
    }

    setLoading(false);
  };

  const handleDisable = async () => {
    setLoading(true);
    setError('');

    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    const factor = listError ? null : findTotpFactor(data?.all ?? []);

    if (listError || !factor) {
      setError(listError?.message ?? 'No TOTP factor found.');
      setLoading(false);
      return;
    }

    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });

    if (unenrollError) {
      setError(unenrollError.message);
    } else {
      setIsMfaEnabled(false);
      setFactorId('');
      setTotpUri('');
      setEnrolling(false);
    }

    setLoading(false);
  };

  return (
    <section style={settingsCardStyle} aria-labelledby="two-factor-heading">
      <div style={cardContentStyle}>
        <div>
          <p style={eyebrowStyle}>Account security</p>
          <h2 id="two-factor-heading" style={titleStyle}>
            Two-Factor Authentication
          </h2>
          <p style={descriptionStyle}>
            Protect your account with a 6-digit authentication code from an authenticator app.
          </p>
        </div>

        {loading && <p style={statusStyle}>Checking two-factor status...</p>}
        {error && <p style={errorStyle} role="alert">{error}</p>}

        {!loading && isMfaEnabled ? (
          <>
            <p style={statusStyle}>2FA is Active</p>
            <button type="button" style={secondaryButtonStyle} onClick={handleDisable} disabled={loading}>
              Disable 2FA
            </button>
          </>
        ) : null}

        {!loading && !isMfaEnabled && !enrolling ? (
          <button type="button" style={buttonStyle} onClick={handleEnable} disabled={loading}>
            Enable 2FA
          </button>
        ) : null}

        {enrolling && !isMfaEnabled ? (
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
              maxLength={6}
              pattern="[0-9]{6}"
              placeholder="Enter 6-digit code"
              aria-label="Six-digit authentication code"
              required
            />

            <button type="submit" style={buttonStyle} disabled={loading}>
              Verify and enable 2FA
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}
