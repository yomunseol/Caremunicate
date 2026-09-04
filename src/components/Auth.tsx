import { useState, type FormEvent } from 'react';
import type { Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

type Stage = 'email' | 'loading' | 'code' | 'totp';

function getEmailError(value: string): string {
  const email = value.trim();
  if (!email) return 'Email is required.';
  if (!emailPattern.test(email)) return 'Enter a valid email address.';
  return '';
}

function findTotpFactor(factors: Factor[] | undefined): Factor | null {
  return factors?.find((factor) => factor.factor_type === 'totp') ?? null;
}

export default function Auth() {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [code, setCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [stage, setStage] = useState<Stage>('email');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const handleSendCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextError = getEmailError(email);
    setEmailError(nextError);
    setErrorMessage('');
    if (nextError) return;

    setStage('loading');

    console.log('[Auth] Sending OTP email to:', email.trim());
    const { data, error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false },
    });

    console.log('[Auth] signInWithOtp response:', { data, error });

    if (error) {
      console.error('[Auth] signInWithOtp error:', error.message);
      setStage('email');
      setErrorMessage(error.message);
      return;
    }

    console.log('[Auth] OTP email sent successfully. Switching to code entry.');
    setCode('');
    setSuccessMessage(`A 6-digit code has been sent to ${email.trim()}.`);
    setStage('code');
  };

  const handleVerifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const token = code.trim();
    if (!token) {
      setErrorMessage('Enter the 6-digit code from your email.');
      return;
    }

    setErrorMessage('');
    setStage('loading');

    console.log('[Auth] Verifying OTP code for:', email.trim());
    const { data, error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: 'email',
    });

    console.log('[Auth] verifyOtp response:', { data, error });

    if (error) {
      console.error('[Auth] verifyOtp error:', error.message);
      setStage('code');
      setErrorMessage(error.message);
      return;
    }

    // A session now exists. Check whether the account has a verified TOTP
    // factor (authenticator-app 2FA). If so, enforce it before granting access.
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    console.log('[Auth] listFactors response:', { data: factors, error: listError });
    const factor = listError ? null : findTotpFactor(factors?.all ?? []);

    if (factor) {
      console.log('[Auth] TOTP factor found; requiring authenticator code.');
      setSuccessMessage('Email verified. Now enter the code from your authenticator app.');
      setTotpCode('');
      setStage('totp');
      return;
    }

    console.log('[Auth] No TOTP factor. Session established:', Boolean(data.session));
    window.location.hash = 'profile';
  };

  const handleVerifyTotp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const token = totpCode.trim();
    if (!token) {
      setErrorMessage('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setErrorMessage('');
    setStage('loading');

    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    const factor = listError ? null : findTotpFactor(factors?.all ?? []);

    if (listError || !factor) {
      console.error('[Auth] No TOTP factor found before verify.', { listError, factor });
      setStage('email');
      setErrorMessage(listError?.message ?? 'No authenticator factor found. Please sign in again.');
      return;
    }

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: factor.id,
    });
    console.log('[Auth] TOTP challenge response:', { data: challengeData, error: challengeError });

    if (challengeError) {
      setStage('totp');
      setErrorMessage(challengeError.message);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challengeData.id,
      code: token,
    });
    console.log('[Auth] TOTP verify response:', { error: verifyError });

    if (verifyError) {
      setStage('totp');
      setErrorMessage(verifyError.message);
      return;
    }

    console.log('[Auth] Authenticator code verified. Access granted.');
    window.location.hash = 'profile';
  };

  const handleBackToEmail = () => {
    setStage('email');
    setErrorMessage('');
    setSuccessMessage('');
  };

  const isSending = stage === 'loading';

  return (
    <form
      onSubmit={
        stage === 'totp' ? handleVerifyTotp : stage === 'code' ? handleVerifyCode : handleSendCode
      }
    >
      {successMessage ? <p className="auth-success">{successMessage}</p> : null}
      {errorMessage ? (
        <p className="field-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {stage === 'code' ? (
        <>
          <p className="auth-copy">
            We sent a 6-digit sign-in code to <strong>{email.trim()}</strong>. Enter it below to complete your login.
          </p>

          <div className="field-wrap">
            <input
              className="input"
              placeholder="6-digit code"
              aria-label="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={isSending}
              required
            />
          </div>

          <button className="primary-button" type="submit" disabled={isSending}>
            {isSending ? 'Verifying...' : 'Verify 6-digit code'}
          </button>

          <button
            className="ghost-button"
            type="button"
            disabled={isSending}
            onClick={handleBackToEmail}
          >
            Use a different email
          </button>
        </>
      ) : stage === 'totp' ? (
        <>
          <p className="auth-copy">
            For your security, enter the 6-digit code from your authenticator app for <strong>{email.trim()}</strong>.
          </p>

          <div className="field-wrap">
            <input
              className="input"
              placeholder="Authenticator code"
              aria-label="Authenticator code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value)}
              disabled={isSending}
              required
            />
          </div>

          <button className="primary-button" type="submit" disabled={isSending}>
            {isSending ? 'Verifying...' : 'Verify authenticator code'}
          </button>
        </>
      ) : (
        <>
          <div className="field-wrap">
            <input
              className="input"
              placeholder="Email address"
              aria-label="Email address"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError('');
                setErrorMessage('');
              }}
              disabled={isSending}
              aria-invalid={Boolean(emailError)}
              required
            />
            {emailError ? <span className="field-error">{emailError}</span> : null}
          </div>

          <button className="primary-button" type="submit" disabled={isSending}>
            {isSending ? 'Sending code...' : 'Email me a 6-digit code'}
          </button>
        </>
      )}
    </form>
  );
}
