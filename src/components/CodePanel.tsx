import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// CodePanel — the ONE 6-box verification-code input.
//
// Reused by every code-entry surface so verify UI is never duplicated:
//   - Signup email verification
//   - Login email 2FA
//   - Password reset
//
// Behaviour: auto-focus, numeric-only boxes, auto-advance on type, backspace
// steps back, arrow keys navigate, paste splits across the boxes, and the
// joined value is reported through onChange. onComplete fires once when all
// boxes are filled. The resend control owns its own 60s countdown; the parent
// only supplies the send function.
// ---------------------------------------------------------------------------

export type CodePanelProps = {
  value: string;
  onChange: (code: string) => void;
  /** Number of boxes (default 6). */
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Inline error message under the boxes (invalid / expired). */
  error?: string;
  /** Red border without a message (e.g. a failed attempt). */
  isError?: boolean;
  /** Accessible label for the group. */
  label?: string;
  /** Called once when the joined value reaches `length`. */
  onComplete?: (code: string) => void;
  /** Send a new code. Return false to leave the resend button enabled. */
  onResend?: () => boolean | void | Promise<boolean | void>;
  /** Countdown after the code was sent (default 60 seconds). */
  resendAfterSeconds?: number;
  resendDisabled?: boolean;
};

const digitsOnly = (raw: string): string => raw.replace(/\D+/g, '');

export default function CodePanel({
  value,
  onChange,
  length = 6,
  disabled = false,
  autoFocus = true,
  error,
  isError = false,
  label,
  onComplete,
  onResend,
  resendAfterSeconds = 60,
  resendDisabled = false,
}: CodePanelProps) {
  const { t } = useLang();
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const [secondsLeft, setSecondsLeft] = useState(resendAfterSeconds);
  const completedRef = useRef(false);

  useEffect(() => {
    if (autoFocus) boxes.current[0]?.focus();
  }, [autoFocus]);

  // The panel owns the resend countdown, so no parent duplicates this logic.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = window.setTimeout(() => setSecondsLeft((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [secondsLeft]);

  useEffect(() => {
    if (!onComplete) return;
    if (value.length === length) {
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete(value);
      }
      return;
    }
    completedRef.current = false;
  }, [value, length, onComplete]);

  const chars = Array.from({ length }, (_, index) => value[index] ?? '');
  const invalid = Boolean(error) || isError;
  const groupLabel = label ?? t('auth.enterVerificationCode');

  const setAt = (index: number, next: string) => {
    const arr = chars.slice();
    arr[index] = next;
    onChange(arr.join('').slice(0, length));
  };

  /** Fill from `index` forward with a run of digits (typing or paste). */
  const fillFrom = (index: number, run: string) => {
    const arr = chars.slice();
    let cursor = index;
    for (const digit of run.split('')) {
      if (cursor >= length) break;
      arr[cursor] = digit;
      cursor += 1;
    }
    onChange(arr.join('').slice(0, length));
    boxes.current[Math.min(cursor, length - 1)]?.focus();
  };

  const handleChange = (index: number, raw: string) => {
    const digits = digitsOnly(raw);
    if (!digits) {
      setAt(index, '');
      return;
    }
    if (digits.length === 1) {
      setAt(index, digits);
      boxes.current[Math.min(index + 1, length - 1)]?.focus();
      return;
    }
    fillFrom(index, digits);
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      if (chars[index]) {
        setAt(index, '');
        return;
      }
      event.preventDefault();
      const prev = Math.max(0, index - 1);
      setAt(prev, '');
      boxes.current[prev]?.focus();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      boxes.current[Math.max(0, index - 1)]?.focus();
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      boxes.current[Math.min(length - 1, index + 1)]?.focus();
    }
  };

  const handlePaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const digits = digitsOnly(event.clipboardData?.getData('text') ?? '');
    if (!digits) return;
    event.preventDefault();
    fillFrom(index, digits);
  };

  const resend = async () => {
    if (secondsLeft > 0 || resendDisabled || !onResend) return;
    const result = await onResend();
    if (result !== false) setSecondsLeft(resendAfterSeconds);
  };

  return (
    <div className="code-panel">
      <div className="code-panel-boxes" role="group" aria-label={groupLabel}>
        {chars.map((char, index) => (
          <input
            key={index}
            ref={(node) => {
              boxes.current[index] = node;
            }}
            className={`code-box${invalid ? ' is-invalid' : ''}`}
            dir="ltr"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            maxLength={1}
            aria-label={`${groupLabel} ${index + 1}`}
            aria-invalid={invalid}
            value={char}
            readOnly={disabled}
            aria-disabled={disabled}
            onChange={(event) => handleChange(index, event.target.value)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            onPaste={(event) => handlePaste(index, event)}
            onFocus={(event) => event.target.select()}
          />
        ))}
      </div>

      {error ? (
        <p className="code-panel-error" role="alert">
          {error}
        </p>
      ) : null}

      {onResend ? (
        <button
          type="button"
          className="code-panel-resend"
          onClick={() => void resend()}
          disabled={resendDisabled || secondsLeft > 0}
        >
          {secondsLeft > 0
            ? t('auth.resendCodeIn', { seconds: secondsLeft })
            : t('auth.resendCode')}
        </button>
      ) : null}
    </div>
  );
}
