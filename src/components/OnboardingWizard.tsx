import { useEffect, useState } from 'react';
import { Building2, CheckCircle2, Stethoscope, UserRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { planForRole } from './PricingSection';

// ---------------------------------------------------------------------------
// Onboarding wizard — role, then profile, then a short welcome.
//
// Enforced by App: an authenticated user whose profiles.onboarding_complete is
// not true is routed to /onboarding. The final step upserts the profile row
// (so the email-confirmation signup, which has no row yet, also works) and
// hard-redirects to the dashboard after 1.5s.
// ---------------------------------------------------------------------------

type OnboardingRole = 'doctor' | 'patient' | 'department';
type Step = 1 | 2 | 3;

const ROLE_OPTIONS: Array<{
  value: OnboardingRole;
  Icon: typeof UserRound;
  titleKey: string;
  descKey: string;
}> = [
  {
    value: 'doctor',
    Icon: Stethoscope,
    titleKey: 'onboarding.role_doctor',
    descKey: 'onboarding.role_doctor_desc',
  },
  {
    value: 'patient',
    Icon: UserRound,
    titleKey: 'onboarding.role_patient',
    descKey: 'onboarding.role_patient_desc',
  },
  {
    value: 'department',
    Icon: Building2,
    titleKey: 'onboarding.role_admin',
    descKey: 'onboarding.role_admin_desc',
  },
];

export default function OnboardingWizard() {
  const { user } = useAuth();
  const { t, tString } = useLang();
  const [step, setStep] = useState<Step>(1);
  const [role, setRole] = useState<OnboardingRole | null>(null);
  const [fullName, setFullName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [clinic, setClinic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (step !== 3) return;
    const timer = window.setTimeout(() => {
      window.location.href = '/#profile';
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [step]);

  const complete = async () => {
    if (!user || !role || !fullName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { error: saveError } = await supabase.from('profiles').upsert(
        {
          user_id: user.id,
          username: fullName.trim(),
          full_name: fullName.trim(),
          role,
          plan: planForRole(role),
          onboarding_complete: true,
          ...(role === 'doctor' ? { specialty: specialty.trim() || null } : {}),
          ...(role === 'department' ? { clinic: clinic.trim() || null } : {}),
        },
        { onConflict: 'user_id' },
      );
      if (saveError) throw saveError;
      setStep(3);
    } catch (caught) {
      console.error('ONBOARDING SAVE ERROR:', caught);
      setError(t('onboarding.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section onboarding-page" aria-labelledby="onboarding-heading">
      <div className="onboarding-card">
        {step < 3 ? (
          <>
            <div className="onboarding-progress">
              <span>{t('onboarding.title')}</span>
              <span>{tString('onboarding.step_of', { current: step, total: 2 })}</span>
            </div>
            <div className="onboarding-heading">
              <h2 id="onboarding-heading">
                {step === 1 ? t('onboarding.step_1') : t('onboarding.step_2')}
              </h2>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="onboarding-roles" role="group" aria-label={t('onboarding.step_1')}>
              {ROLE_OPTIONS.map((option) => {
                const Icon = option.Icon;
                const active = role === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={active ? 'onboarding-role active' : 'onboarding-role'}
                    aria-pressed={active}
                    onClick={() => setRole(option.value)}
                  >
                    <span className="onboarding-role-icon" aria-hidden="true">
                      <Icon size={22} />
                    </span>
                    <span className="onboarding-role-copy">
                      <strong>{t(option.titleKey)}</strong>
                      <small>{t(option.descKey)}</small>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="onboarding-actions">
              <button
                type="button"
                className="primary-button"
                disabled={!role}
                onClick={() => setStep(2)}
              >
                {t('onboarding.next')}
              </button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <form
            className="onboarding-form"
            onSubmit={(event) => {
              event.preventDefault();
              void complete();
            }}
          >
            <div className="field-wrap">
              <label className="onboarding-label" htmlFor="onboarding-name">
                {t('onboarding.full_name')}
              </label>
              <input
                id="onboarding-name"
                className="input"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                required
              />
            </div>

            {role === 'doctor' ? (
              <div className="field-wrap">
                <label className="onboarding-label" htmlFor="onboarding-specialty">
                  {t('onboarding.specialty')}
                </label>
                <input
                  id="onboarding-specialty"
                  className="input"
                  value={specialty}
                  onChange={(event) => setSpecialty(event.target.value)}
                />
              </div>
            ) : null}

            {role === 'department' ? (
              <div className="field-wrap">
                <label className="onboarding-label" htmlFor="onboarding-clinic">
                  {t('onboarding.clinic_name')}
                </label>
                <input
                  id="onboarding-clinic"
                  className="input"
                  value={clinic}
                  onChange={(event) => setClinic(event.target.value)}
                />
              </div>
            ) : null}

            {error ? <p className="field-error" role="alert">{error}</p> : null}

            <div className="onboarding-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setStep(1);
                  setError('');
                }}
                disabled={busy}
              >
                {t('onboarding.back')}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !fullName.trim()}
              >
                {busy ? t('onboarding.saving') : t('onboarding.complete')}
              </button>
            </div>
          </form>
        ) : null}

        {step === 3 ? (
          <div className="onboarding-success" role="status">
            <span className="onboarding-check" aria-hidden="true">
              <CheckCircle2 size={44} />
            </span>
            <h2 id="onboarding-heading">{t('onboarding.welcome')}</h2>
            <p>{t('onboarding.redirecting')}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
