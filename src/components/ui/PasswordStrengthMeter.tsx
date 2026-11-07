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

/**
 * Cr-1 scoring:
 *   critical  <= 4
 *   weak      5–7, or 8–11 without both a number and a special
 *   moderate  8–9 with number + special; 10–11 with number + special
 *             (missing upper/lower keeps it moderate)
 *   strong    10–11 with upper + lower + number + special
 *   resilient >=12, strong baseline, plus unicode/rare OR >=2 specials/numbers
 */
export const getPasswordStage = (password: string): PasswordStage => {
  const length = password.length;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[^A-Za-z0-9\s]/.test(password);
  const hasUnicode = /[^\x00-\x7F]/.test(password);
  const specialCount = (password.match(/[^A-Za-z0-9\s]/g) ?? []).length;
  const numberCount = (password.match(/\d/g) ?? []).length;

  const moderateBaseline = hasNumber && hasSpecial;
  const strongBaseline = hasUpper && hasLower && hasNumber && hasSpecial;

  if (length <= 4) return 'critical';
  if (length <= 7) return 'weak';
  if (length <= 9) return moderateBaseline ? 'moderate' : 'weak';
  if (length <= 11) {
    if (strongBaseline) return 'strong';
    return moderateBaseline ? 'moderate' : 'weak';
  }
  if (strongBaseline && (hasUnicode || specialCount >= 2 || numberCount >= 2)) {
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
  const isStrong = stage === 'strong' || stage === 'resilient';

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
              filter: isStrong ? 'drop-shadow(0 0 6px currentColor)' : 'none',
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
        <p className="password-strength-meter__error" role="alert" style={styles.error}>
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
    color: '#ef4444',
    fontSize: '0.74rem',
    fontWeight: 600,
    lineHeight: 1.4,
    animation: 'password-strength-fade-in 200ms ease-out',
  },
};
