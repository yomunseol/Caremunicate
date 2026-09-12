import { useEffect, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useLang } from '../i18n';

type TwoFactorMethod = 'none' | 'email' | 'app';

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

const noticeStyle = {
  margin: 0,
  padding: '0.6rem 0.8rem',
  border: '1px solid #f0d27a',
  borderRadius: '0.7rem',
  background: '#fff7d6',
  color: '#8a6d1a',
  fontSize: '0.82rem',
  fontWeight: 600,
  lineHeight: 1.45,
};

const resendRowStyle = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'stretch',
};

const resendButtonStyle = {
  border: '1px solid rgba(62, 169, 133, 0.3)',
  borderRadius: '999px',
  padding: '0.6rem 0.9rem',
  background: 'transparent',
  color: '#216e5d',
  fontWeight: 700,
  cursor: 'pointer',
  fontSize: '0.82rem',
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
  const { t } = useLang();
  const [method, setMethod] = useState<TwoFactorMethod>('none');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [factorId, setFactorId] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [emailEnrolling, setEmailEnrolling] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  // Yellow, non-blocking notice when the OTP send fails (never blocks the view).
  const [sendNotice, setSendNotice] = useState('');
  // Resend cooldown, counted down one second at a time.
  const [resendIn, setResendIn] = useState(0);

  // Load the real state once: a TOTP factor from Supabase MFA, plus the
  // saved profile preference ('email' | 'app' | 'none').
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
          savedMethod = m === 'email' || m === 'app' ? m : 'none';
        }
      }

      if (cancelled) return;

      // A real TOTP factor always wins the display state.
      if (factor) {
        setFactorId(factor.id);
        setMethod('app');
        if (userId) {
          await supabase
            .from('profiles')
            .update({ preferred_2fa_method: 'app' })
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

  // Tick the resend cooldown down to zero.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

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

  // Sends (or resends) the email OTP. Fault-tolerant: a send error surfaces a
  // yellow notice and returns false, but the caller still opens the code-entry
  // view — a code may arrive even when the API reported a failure.
  const sendEmailCode = async (): Promise<boolean> => {
    const userEmail = (await supabase.auth.getUser()).data.user?.email ?? '';
    const { data, error } = await supabase.auth.signInWithOtp({
      email: userEmail,
      options: { shouldCreateUser: false },
    });
    console.log('[2FA] email OTP send response:', { data, error });

    if (error) {
      console.log('OTP send error:', error);
      setSendNotice(t('tfa.sendError'));
      return false;
    }

    setSendNotice('');
    setResendIn(30);
    return true;
  };

  const handleMethodChange = async (next: TwoFactorMethod) => {
    if (loading || next === method) return;
    setError('');
    setMessage('');
    setSendNotice('');
    setLoading(true);

    // Leaving app (authenticator): unenroll the live TOTP factor first.
    if (method === 'app' && next !== 'app') {
      const ok = await unenrollTotp();
      if (!ok) {
        setLoading(false);
        return;
      }
    }

    if (next === 'none') {
      setMethod('none');
      await savePreference('none');
      setMessage(t('tfa.msg.off'));
    } else if (next === 'email') {
      // Trigger a native email OTP so the user can prove inbox access. The code
      // entry view opens even if the send fails, so the user is never dead-ended.
      const sent = await sendEmailCode();
      setEmailCode('');
      setMessage(sent ? t('tfa.msg.sent') : '');
      setEmailEnrolling(true);
    } else {
      // 'app': kick off the TOTP enrollment wizard.
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
        setError(t('tfa.err.enroll'));
      }
    }

    setLoading(false);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!factorId || !verificationCode.trim()) {
      setError(t('tfa.err.enterAppCode'));
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
    setMethod('app');
    await savePreference('app');
    setMessage(t('tfa.msg.activeApp'));
    setLoading(false);
  };

  const handleEmailVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const token = emailCode.trim();
    if (!token) {
      setError(t('tfa.err.enterEmailCode'));
      return;
    }

    setLoading(true);
    setError('');

    const userEmail = (await supabase.auth.getUser()).data.user?.email ?? '';
    const { data, error } = await supabase.auth.verifyOtp({
      email: userEmail,
      token,
      type: 'email',
    });
    console.log('[2FA] email OTP verify response:', { data, error });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    console.log('[2FA] Email code verified. Saving email preference.');
    setEmailCode('');
    setEmailEnrolling(false);
    setMethod('email');
    await savePreference('email');
    setMessage(t('tfa.msg.activeEmail'));
    setLoading(false);
  };

  // Resend the email code (30s cooldown). Same send path as the radio handler,
  // so it uses shouldCreateUser: false and never dead-ends on failure.
  const handleResendEmailCode = async () => {
    if (resendIn > 0 || loading) return;

    setLoading(true);
    setError('');
    try {
      const sent = await sendEmailCode();
      if (sent) setMessage(t('tfa.msg.sent'));
    } finally {
      setLoading(false);
    }
  };

  const handleCancelEnroll = () => {
    setEnrolling(false);
    setTotpUri('');
    setVerificationCode('');
    setEmailEnrolling(false);
    setEmailCode('');
    setError('');
    setSendNotice('');
    setResendIn(0);
    // The unverified factor may still exist server-side; reconcile.
    void (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      const factor = listError ? null : findTotpFactor(data?.all ?? []);
      console.log('[2FA] After cancel, TOTP factor found:', factor ? factor.id : 'none');
      setFactorId(factor?.id ?? '');
      setMethod(factor ? 'app' : 'none');
    })();
  };

  const active = method !== 'none';

  return (
    <section style={settingsCardStyle} aria-labelledby="two-factor-heading">
      <div style={cardContentStyle}>
        <div>
          <p style={eyebrowStyle}>{t('tfa.eyebrow')}</p>
          <h2 id="two-factor-heading" style={titleStyle}>
            {t('tfa.title')}
          </h2>
          <p style={descriptionStyle}>
            {t('tfa.desc')}
          </p>
        </div>

        {loading && <p style={statusStyle}>{t('tfa.checking')}</p>}
        {error && <p style={errorStyle} role="alert">{error}</p>}
        {message && <p style={statusStyle}>{message}</p>}

        {!enrolling && !emailEnrolling ? (
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
                <strong>{t('tfa.none')}</strong>
                <br />
                <small style={{ color: '#557b76' }}>{t('tfa.noneDesc')}</small>
              </span>
              {method === 'none' ? (
                <span style={{ ...badgeStyle, background: '#e7f0ee', color: '#216e5d' }}>{t('tfa.current')}</span>
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
                <strong>{t('tfa.email')}</strong>
                <br />
                <small style={{ color: '#557b76' }}>{t('tfa.emailDesc')}</small>
              </span>
              {method === 'email' ? (
                <span style={{ ...badgeStyle, background: '#e7f0ee', color: '#216e5d' }}>{t('tfa.active')}</span>
              ) : null}
            </label>

            <label style={methodRowStyle}>
              <input
                type="radio"
                name="two-factor-method"
                checked={method === 'app'}
                onChange={() => void handleMethodChange('app')}
                disabled={loading}
                style={methodRadioStyle}
              />
              <span>
                <strong>{t('tfa.app')}</strong>
                <br />
                <small style={{ color: '#557b76' }}>{t('tfa.appDesc')}</small>
              </span>
              {method === 'app' ? (
                <span style={{ ...badgeStyle, background: '#e7f0ee', color: '#216e5d' }}>{t('tfa.active')}</span>
              ) : null}
            </label>
          </>
        ) : null}

        {enrolling ? (
          <form onSubmit={handleVerify} style={{ display: 'grid', gap: '0.9rem' }}>
            <div style={qrCardStyle}>
              <QRCodeSVG value={totpUri} size={180} />
              <p style={{ margin: 0, color: '#557b76', fontSize: '0.9rem', textAlign: 'center' }}>
                {t('tfa.qrHelp')}
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
              placeholder={t('tfa.codePlaceholder')}
              aria-label={t('tfa.appCodeAria')}
              disabled={loading}
              required
            />

            <button type="submit" style={buttonStyle} disabled={loading}>
              {loading ? t('tfa.verifying') : t('tfa.verifyEnable')}
            </button>

            <button type="button" style={secondaryButtonStyle} onClick={handleCancelEnroll} disabled={loading}>
              {t('common.cancel')}
            </button>
          </form>
        ) : null}

        {emailEnrolling ? (
          <form onSubmit={handleEmailVerify} style={{ display: 'grid', gap: '0.9rem' }}>
            {sendNotice ? <p style={noticeStyle} role="status">{sendNotice}</p> : null}

            <p style={descriptionStyle}>
              {sendNotice ? t('tfa.emailEnterDesc') : t('tfa.emailSentDesc')}
            </p>

            <div style={resendRowStyle}>
              <input
                style={{ ...inputStyle, width: 'auto', flex: 1, minWidth: 0 }}
                value={emailCode}
                onChange={(event) => setEmailCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                placeholder={t('tfa.codePlaceholder')}
                aria-label={t('tfa.emailCodeAria')}
                disabled={loading}
                required
              />
              <button
                type="button"
                style={{
                  ...resendButtonStyle,
                  ...(resendIn > 0 || loading ? { opacity: 0.55, cursor: 'not-allowed' as const } : null),
                }}
                onClick={() => void handleResendEmailCode()}
                disabled={resendIn > 0 || loading}
              >
                {resendIn > 0 ? t('tfa.resendIn', { seconds: resendIn }) : t('tfa.resend')}
              </button>
            </div>

            <button type="submit" style={buttonStyle} disabled={loading}>
              {loading ? t('tfa.verifying') : t('tfa.verifyEmail')}
            </button>

            <button type="button" style={secondaryButtonStyle} onClick={handleCancelEnroll} disabled={loading}>
              {t('common.cancel')}
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}
