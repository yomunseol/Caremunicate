import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// CodePanel — the ONE 6-box verification-code input (C-04).
//
// Reused by every code-entry surface so verify UI is never duplicated:
//   - 2FA email code (PasswordAuth branch C)
//   - authenticator code (PasswordAuth branch B)
//   - signup confirm / recovery / email change (C-04 Section 2)
//
// Behaviour: numeric-only boxes, auto-advance on type, backspace steps back,
// arrow keys navigate, paste splits across the boxes, and the joined value is
// reported through onChange. Resend is OPTIONAL and may be driven from the
// parent (controlled countdown) or left off entirely.
//
// It owns NO verify logic — callers keep their own submit/verify path.
// ---------------------------------------------------------------------------

export type CodePanelProps = {
  value: string;
  onChange: (code: string) => void;
  /** Number of boxes (default 6). */
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Inline error under the boxes (invalid / expired). */
  error?: string;
  /** Accessible label for the group. */
  label?: string;
  /** Resend control — rendered only when onResend is supplied. */
  onResend?: () => void;
  /** Remaining cooldown seconds; the button is disabled while > 0. */
  resendSecondsLeft?: number;
  resendDisabled?: boolean;
};

const digitsOnly = (raw: string): string => raw.replace(/\D+/g, '');

export default function CodePanel({
  value,
  onChange,
  length = 6,
  disabled = false,
  autoFocus = false,
  error,
  label,
  onResend,
  resendSecondsLeft = 0,
  resendDisabled = false,
}: CodePanelProps) {
  const { t } = useLang();
  const boxes = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (autoFocus) boxes.current[0]?.focus();
  }, [autoFocus]);

  const chars = Array.from({ length }, (_, index) => value[index] ?? '');

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

  return (
    <div className="code-panel">
      <div
        className="code-panel-boxes"
        role="group"
        aria-label={label ?? t('login.labelEmailCode')}
      >
        {chars.map((char, index) => (
          <input
            key={index}
            ref={(node) => {
              boxes.current[index] = node;
            }}
            className={`code-box${error ? ' is-invalid' : ''}`}
            dir="ltr"
            type="text"
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            maxLength={1}
            aria-label={`${label ?? t('login.labelEmailCode')} ${index + 1}`}
            aria-invalid={Boolean(error)}
            value={char}
            disabled={disabled}
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
          onClick={onResend}
          disabled={resendDisabled || resendSecondsLeft > 0}
        >
          {resendSecondsLeft > 0
            ? t('tfa.resendIn', { seconds: resendSecondsLeft })
            : t('tfa.resend')}
        </button>
      ) : null}
    </div>
  );
}
