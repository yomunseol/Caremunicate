import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useLang } from '../i18n';
import CodePanel from './CodePanel';
import PasswordStrengthMeter, { passwordMeetsRules } from './PasswordStrengthMeter';

// ---------------------------------------------------------------------------
// Forgot-password, 3 steps, all on the login screen (no route change):
//   1. email        -> resetPasswordForEmail() sends the recovery email
//   2. 6-digit code -> verifyOtp({ type: 'recovery' }) creates a recovery session
//   3. new password -> updateUser(), then sign out and hand back to login
//
// The code comes from the project's existing Supabase recovery template. We add
// no sender: the 2FA RPCs are authenticated-only and cannot serve a signed-out
// user, so both flows ride the auth provider's built-in code templates.
// ---------------------------------------------------------------------------

type Step = 'email' | 'code' | 'password';

type PasswordResetFlowProps = {
  initialEmail?: string;
  onSuccess: () => void;
  onCancel: () => void;
};

export default function PasswordResetFlow({
  initialEmail = '',
  onSuccess,
  onCancel,
}: PasswordResetFlowProps) {
  const { t } = useLang();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const mapSendError = (message: string): string =>
    /not found|no user|invalid/i.test(message)
      ? t('auth.err.emailNotFound')
      : t('auth.err.codeSend');

  const requestCode = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const address = email.trim();
    if (!address) {
      setError(t('auth.err.emailRequired'));
      return;
    }

    setBusy(true);
    setError('');
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(address, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      console.log('Password reset email response:', { error: resetError });

      if (resetError) {
        setError(mapSendError(resetError.message ?? ''));
        return;
      }

      setStep('code');
      setResendIn(60);
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = code.trim();
    if (token.length !== 6) {
      setError(t('auth.err.invalidCode'));
      return;
    }

    setBusy(true);
    setError('');
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token,
        type: 'recovery',
      });
      console.log('Password reset verify response:', { error: verifyError });

      if (verifyError) {
        setError(t('auth.err.invalidCode'));
        setCode('');
        return;
      }

      setStep('password');
    } finally {
      setBusy(false);
    }
  };

  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const canSubmit =
    passwordMeetsRules(password) && confirmPassword.length > 0 && !mismatch && !busy;

  const updatePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;

    setBusy(true);
    setError('');
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      console.log('Password update response:', { error: updateError });

      if (updateError) {
        setError(t('auth.err.passwordUpdate'));
        return;
      }

      // The recovery session is not the normal login session: drop it so the
      // user signs in with the new password (as the spec asks). A failed sign-out
      // must not strand the user — the password is already changed.
      try {
        await supabase.auth.signOut();
      } catch (signOutError) {
        console.error('Post-reset sign-out failed:', signOutError);
      }
      onSuccess();
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (resendIn > 0 || busy) return;
    await requestCode();
  };

  return (
    <div style={{ display: 'grid', gap: '0.7rem' }}>
      {error && step !== 'code' ? <p className="field-error" role="alert">{error}</p> : null}

      {step === 'email' ? (
        <form onSubmit={(event) => void requestCode(event)} style={{ display: 'grid', gap: '0.6rem' }}>
          <p className="auth-copy" style={{ margin: 0 }}>{t('auth.enterEmailForReset')}</p>
          <input
            className="input"
            type="email"
            autoComplete="email"
            aria-label={t('login.labelEmail')}
            placeholder={t('login.phEmail')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            required
          />
          <button className="primary-button" type="submit" disabled={busy}>
            {t('reset.send')}
          </button>
          <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>
            {t('login.backToSignIn')}
          </button>
        </form>
      ) : null}

      {step === 'code' ? (
        <form onSubmit={verifyCode} style={{ display: 'grid', gap: '0.6rem' }}>
          <p className="auth-copy" style={{ margin: 0 }}>
            {t('auth.resetEmailSent', { email: email.trim() })}
          </p>
          <CodePanel
            value={code}
            onChange={setCode}
            disabled={busy}
            autoFocus
            error={error || undefined}
            label={t('login.labelEmailCode')}
            onResend={() => void resend()}
            resendSecondsLeft={resendIn}
            resendDisabled={busy}
          />
          <button className="primary-button" type="submit" disabled={busy || code.length !== 6}>
            {busy ? t('tfa.verifying') : t('auth.verifyCode')}
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              setStep('email');
              setError('');
              setCode('');
            }}
            disabled={busy}
          >
            {t('login.changeEmail')}
          </button>
        </form>
      ) : null}

      {step === 'password' ? (
        <form onSubmit={updatePassword} style={{ display: 'grid', gap: '0.6rem' }}>
          <p className="auth-copy" style={{ margin: 0 }}>{t('auth.resetPassword')}</p>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            aria-label={t('auth.password')}
            placeholder={t('auth.password')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          <PasswordStrengthMeter password={password} />
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            aria-label={t('auth.confirmPassword')}
            placeholder={t('auth.confirmPassword')}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            disabled={busy}
          />
          {mismatch ? <p className="field-error" role="alert">{t('auth.err.passwordMismatch')}</p> : null}
          <button className="primary-button" type="submit" disabled={!canSubmit}>
            {busy ? t('tfa.verifying') : t('auth.resetPassword')}
          </button>
          <button className="ghost-button" type="button" onClick={onCancel} disabled={busy}>
            {t('login.backToSignIn')}
          </button>
        </form>
      ) : null}
    </div>
  );
}
