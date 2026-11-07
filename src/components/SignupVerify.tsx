import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useLang } from '../i18n';
import CodePanel from './CodePanel';

// ---------------------------------------------------------------------------
// Signup verification — the mandatory gate after signUp() when Supabase requires
// email confirmation (data.session === null). The 6-digit code comes from the
// project's existing "Confirm signup" email template; we only verify it here.
// verifyOtp({ type: 'signup' }) creates the session, so the dashboard cannot be
// reached until this succeeds (AuthContext reports no user without a session).
// ---------------------------------------------------------------------------

type SignupVerifyProps = {
  email: string;
  onVerified: () => void;
  onBack: () => void;
};

export default function SignupVerify({ email, onVerified, onBack }: SignupVerifyProps) {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const verifyToken = async (tokenValue: string) => {
    if (busy) return;
    const token = tokenValue.trim();
    if (token.length !== 6) {
      setError(t('auth.err.invalidCode'));
      return;
    }

    setBusy(true);
    setError('');
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: token,
        type: 'signup',
      });
      console.log('Signup verify response:', { error: verifyError });

      if (verifyError) {
        setError(t('auth.err.invalidCode'));
        setCode('');
        return;
      }

      onVerified();
    } catch (caught) {
      console.error('Signup verify crashed:', caught);
      setError(t('auth.err.invalidCode'));
    } finally {
      setBusy(false);
    }
  };

  const verify = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void verifyToken(code);
  };

  const resend = async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim(),
      });
      console.log('Signup resend response:', { error: resendError });

      if (resendError) {
        setError(t('auth.err.codeSend'));
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={verify} style={{ display: 'grid', gap: '0.85rem' }}>
      <CodePanel
        value={code}
        onChange={setCode}
        disabled={busy}
        autoFocus
        label={t('auth.enter_otp')}
        error={error || undefined}
        onResend={resend}
        resendDisabled={busy}
        onComplete={(next) => {
          if (!busy) void verifyToken(next);
        }}
      />

      <button className="primary-button" type="submit" disabled={busy || code.length !== 6}>
        {busy ? t('tfa.verifying') : t('auth.verify_button')}
      </button>

      <button className="ghost-button" type="button" onClick={onBack} disabled={busy}>
        {t('login.backToSignIn')}
      </button>
    </form>
  );
}
