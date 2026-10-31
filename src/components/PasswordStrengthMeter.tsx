import { Check, X } from 'lucide-react';
import { useLang } from '../i18n';

// The five signup rules, in one place so the signup form and the password-reset
// step can never disagree.
export const PASSWORD_MIN_LENGTH = 8;

export const passwordChecks = {
  minLength: (value: string) => value.length >= PASSWORD_MIN_LENGTH,
  hasUpper: (value: string) => /[A-Z]/.test(value),
  hasLower: (value: string) => /[a-z]/.test(value),
  hasNumber: (value: string) => /\d/.test(value),
  hasSpecial: (value: string) => /[!@#$%^&*]/.test(value),
};

export const passwordMeetsRules = (value: string): boolean =>
  Object.values(passwordChecks).every((check) => check(value));

type PasswordStrengthMeterProps = {
  password: string;
  /** Render the "must meet all requirements" line when a rule is unmet. */
  showWeak?: boolean;
};

export default function PasswordStrengthMeter({
  password,
  showWeak = true,
}: PasswordStrengthMeterProps) {
  const { t } = useLang();

  if (password.length === 0) return null;

  const checklist = [
    { label: t('auth.ruleLength'), met: passwordChecks.minLength(password) },
    { label: t('auth.ruleUpper'), met: passwordChecks.hasUpper(password) },
    { label: t('auth.ruleLower'), met: passwordChecks.hasLower(password) },
    { label: t('auth.ruleNumber'), met: passwordChecks.hasNumber(password) },
    { label: t('auth.ruleSpecial'), met: passwordChecks.hasSpecial(password) },
  ];
  const allMet = checklist.every((item) => item.met);

  return (
    <>
      <ul className="password-checklist" aria-label={t('auth.reqAria')}>
        {checklist.map((item) => (
          <li key={item.label} className={item.met ? 'password-rule met' : 'password-rule'}>
            <span className="password-rule-icon" aria-hidden="true">
              {item.met ? <Check size={14} /> : <X size={14} />}
            </span>{' '}
            {item.label}
          </li>
        ))}
      </ul>
      {showWeak && !allMet ? <span className="field-error">{t('auth.passwordWeak')}</span> : null}
    </>
  );
}
