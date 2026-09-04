import { useState } from 'react';
import { supabase } from '../lib/supabase';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

function getEmailError(value) {
  const email = value.trim();
  if (!email) return 'Email is required.';
  if (!emailPattern.test(email)) return 'Enter a valid email address.';
  return '';
}

export default function Auth() {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('email');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const handleSendCode = async (event) => {
    event.preventDefault();

    const nextError = getEmailError(email);
    setEmailError(nextError);
    setErrorMessage('');
    if (nextError) return;

    setStage('loading');

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false },
    });

    if (error) {
      setStage('email');
      setErrorMessage(error.message);
      return;
    }

    setCode('');
    setSuccessMessage(`A 6-digit code has been sent to ${email.trim()}.`);
    setStage('code');
  };

  const handleVerifyCode = async (event) => {
    event.preventDefault();

    const token = code.trim();
    if (!token) {
      setErrorMessage('Enter the 6-digit code from your email.');
      return;
    }

    setErrorMessage('');
    setStage('loading');

    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: 'email',
    });

    if (error) {
      setStage('code');
      setErrorMessage(error.message);
      return;
    }

    // Supabase persists the session to localStorage, so the user
    // stays logged in after a refresh. Send them to their profile.
    window.location.hash = 'profile';
  };

  const handleBackToEmail = () => {
    setStage('email');
    setErrorMessage('');
    setSuccessMessage('');
  };

  const isSending = stage === 'loading';

  return (
    <form onSubmit={stage === 'code' ? handleVerifyCode : handleSendCode}>
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
