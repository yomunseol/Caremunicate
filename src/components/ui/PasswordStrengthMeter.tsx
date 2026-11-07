import type { CSSProperties } from 'react';
import { useLang } from '../../i18n';

export type PasswordStage = 'critical' | 'weak' | 'moderate' | 'strong' | 'resilient';

type StageConfig = {
  width: number;
  color: string;
};

const STAGES: Record<PasswordStage, StageConfig> = {
  critical: { width: 20, color: '#ef4444' },
  weak: { width: 40, color: '#f97316' },
  moderate: { width: 60, color: '#eab308' },
  strong: { width: 80, color: '#22c55e' },
  resilient: { width: 100, color: '#10b981' },
};

/** Standard English QWERTY special characters. */
const standardSpecialCharsRegex = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/;
/** Anything outside word chars, whitespace, and the standard QWERTY set. */
const hasBeyondSpecialChars = /[^\w\s!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/;

/**
 * Cr-1 scoring:
 *   Beyond-QWERTY characters (unicode, rare symbols, emojis) skip all
 *   complexity checks: strength is purely length-based.
 *   Otherwise:
 *   critical  <= 4
 *   weak      5–7, or 8–11 without 2 of upper/number/QWERTY-special
 *   moderate  8–9 with >=2 of [upper, number, standard special]
 *   strong    10–11 with upper + lower + number + standard special
 *   resilient >=12, strong baseline, plus >=2 standard specials/numbers
 */
export const getPasswordStage = (password: string): PasswordStage => {
  const length = password.length;

  if (hasBeyondSpecialChars.test(password)) {
    if (length <= 4) return 'critical';
    if (length <= 7) return 'weak';
    if (length <= 9) return 'moderate';
    if (length <= 11) return 'strong';
    return 'resilient';
  }

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasStandardSpecial = standardSpecialCharsRegex.test(password);
  const standardSpecialCount = (password.match(new RegExp(standardSpecialCharsRegex.source, 'g')) ?? []).length;
  const numberCount = (password.match(/\d/g) ?? []).length;

  const upperNumberSpecialCount = [hasUpper, hasNumber, hasStandardSpecial].filter(Boolean).length;
  const moderateBaseline = upperNumberSpecialCount >= 2;
  const strongBaseline = hasUpper && hasLower && hasNumber && hasStandardSpecial;

  if (length <= 4) return 'critical';
  if (length <= 7) return 'weak';
  if (length <= 9) return moderateBaseline ? 'moderate' : 'weak';
  if (length <= 11) {
    if (strongBaseline) return 'strong';
    return moderateBaseline ? 'moderate' : 'weak';
  }
  if (strongBaseline && (standardSpecialCount >= 2 || numberCount >= 2)) {
    return 'resilient';
  }
  if (strongBaseline) return 'strong';
  return moderateBaseline ? 'moderate' : 'weak';
};

export const isPasswordAtLeastModerate = (password: string): boolean => {
  const stage = getPasswordStage(password);
  return stage === 'moderate' || stage === 'strong' || stage === 'resilient';
};

type PasswordStrengthMeterProps = {
  password: string;
  isSubmitted?: boolean;
};

export default function PasswordStrengthMeter({
  password,
  isSubmitted = false,
}: PasswordStrengthMeterProps) {
  const { t } = useLang();
  if (!password || password.length === 0) return null;

  const stage = getPasswordStage(password);
  const config = STAGES[stage];
  const label = t(`password.${stage}`);
  const showError = isSubmitted && !isPasswordAtLeastModerate(password);
  const glow = stage === 'resilient'
    ? 'drop-shadow(0 0 6px currentColor)'
    : stage === 'strong'
      ? 'drop-shadow(0 0 3px currentColor)'
      : 'none';

  return (
    <>
      <div className="password-strength-meter" style={styles.wrap}>
        <div
          className="password-strength-meter__track"
          style={styles.track}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={config.width}
          aria-valuetext={label}
          aria-label={label}
        >
          <span
            className="password-strength-meter__fill"
            data-stage={stage}
            style={{
              ...styles.fill,
              width: `${config.width}%`,
              background: config.color,
              color: config.color,
              filter: glow,
            }}
          />
        </div>
        <span
          className="password-strength-meter__label"
          style={{ ...styles.label, color: config.color }}
        >
          {label}
        </span>
      </div>
      {showError ? (
        <p className="password-strength-meter__error field-error" role="alert" style={styles.error}>
          {t('password.min_requirement_error')}
        </p>
      ) : null}
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    marginTop: '0.35rem',
  },
  track: {
    flex: 1,
    height: 6,
    minWidth: 0,
    borderRadius: 999,
    background: 'rgba(15, 58, 50, 0.14)',
  },
  fill: {
    display: 'block',
    height: '100%',
    borderRadius: 999,
    transition:
      'width 500ms cubic-bezier(0.16, 1, 0.3, 1), background-color 500ms cubic-bezier(0.16, 1, 0.3, 1), filter 500ms cubic-bezier(0.16, 1, 0.3, 1)',
  },
  label: {
    fontSize: '0.72rem',
    fontWeight: 800,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
    transition: 'color 500ms cubic-bezier(0.16, 1, 0.3, 1)',
  },
  error: {
    margin: '0.35rem 0 0',
    animation: 'password-strength-fade-in 200ms ease-out',
  },
};
