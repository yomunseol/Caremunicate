import { useEffect, useState } from 'react';
import { Building2, CheckCircle2, Stethoscope, UserRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { getPlans, type PlanId } from './PricingSection';

// ---------------------------------------------------------------------------
// Onboarding wizard — Role -> Plan -> Profile -> Welcome.
//
// Enforced by App: an authenticated user whose profiles.onboarding_complete is
// not true is routed to /onboarding. The final step upserts the profile row
// (so email-confirmation signups with no row yet also work) and hard-redirects
// to /dashboard after 1.5s.
// ---------------------------------------------------------------------------

type OnboardingRole = 'doctor' | 'patient' | 'hospital';
type Step = 1 | 2 | 3 | 4;

type FormState = {
  role: OnboardingRole | '';
  plan: PlanId | '';
  fullName: string;
  specialty: string;
  clinicName: string;
};

const INITIAL_FORM: FormState = {
  role: '',
  plan: '',
  fullName: '',
  specialty: '',
  clinicName: '',
};

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
    value: 'hospital',
    Icon: Building2,
    titleKey: 'onboarding.role_hospital_manager',
    descKey: 'onboarding.role_admin_desc',
  },
];

const plansForRole = (role: OnboardingRole | ''): PlanId[] =>
  role === 'doctor'
    ? ['doctor']
    : role === 'hospital'
      ? ['department', 'hospital']
      : ['basic', 'plus', 'pro'];

export default function OnboardingWizard() {
  const { user } = useAuth();
  const { t, tString } = useLang();
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const plans = getPlans(t);
  const options = plans.filter((plan) => plansForRole(form.role).includes(plan.id));
  const totalSteps = 3;

  useEffect(() => {
    if (step !== 4) return;
    const timer = window.setTimeout(() => {
      window.location.href = '/dashboard';
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [step]);

  const selectRole = (role: OnboardingRole) => {
    setForm((previous) => ({
      ...previous,
      role,
      // The doctor has one plan, so preselect it. Patient/hospital managers
      // choose on the next step.
      plan: role === 'doctor' ? 'doctor' : '',
      specialty: role === 'doctor' ? previous.specialty : '',
      clinicName: role === 'hospital' ? previous.clinicName : '',
    }));
    setError('');
  };

  const selectPlan = (plan: PlanId) => {
    setForm((previous) => ({ ...previous, plan }));
    setError('');
  };

  const planLabel = (plan: { id: PlanId; name: string }) =>
    plan.id === 'doctor'
      ? t('onboarding.plan_doctor')
      : plan.id === 'department'
        ? t('onboarding.plan_department')
        : plan.id === 'hospital'
          ? t('onboarding.plan_hospital')
          : plan.name;

  const reportSaveError = (error: unknown) => {
    const detail = error as { message?: string; details?: string; hint?: string };
    console.error(
      'Supabase Profile Update Error:',
      detail.message,
      detail.details,
      detail.hint,
    );
    setError(detail.message || t('onboarding.error'));
  };

  const complete = async () => {
    if (!user || !form.role || !form.plan || !form.fullName.trim() || busy) return;
    setBusy(true);
    setError('');

    const payload = {
      user_id: user.id,
      username: form.fullName.trim(),
      full_name: form.fullName.trim(),
      role: form.role,
      plan: form.plan,
      onboarding_complete: true,
      ...(form.role === 'doctor' ? { specialty: form.specialty.trim() || null } : {}),
      ...(form.role === 'hospital'
        ? {
            clinic: form.clinicName.trim() || null,
            clinic_name: form.clinicName.trim() || null,
          }
        : {}),
    };

    console.log('Profile Save Payload:', payload);

    try {
      const { error: saveError } = await supabase
        .from('profiles')
        .upsert(payload, { onConflict: 'user_id' });

      if (saveError) {
        reportSaveError(saveError);
        return;
      }

      setStep(4);
    } catch (caught) {
      reportSaveError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section onboarding-page" aria-labelledby="onboarding-heading">
      <div className="onboarding-card">
        {step < 4 ? (
          <>
            <div className="onboarding-progress">
              <span>{t('onboarding.title')}</span>
              <span>{tString('onboarding.step_of', { current: step, total: totalSteps })}</span>
            </div>
            <div className="onboarding-heading">
              <h2 id="onboarding-heading">
                {step === 1
                  ? t('onboarding.step_1')
                  : step === 2
                    ? t('onboarding.step_2')
                    : t('onboarding.step_3')}
              </h2>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="onboarding-roles" role="group" aria-label={t('onboarding.step_1')}>
              {ROLE_OPTIONS.map((option) => {
                const Icon = option.Icon;
                const active = form.role === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={active ? 'onboarding-role active' : 'onboarding-role'}
                    aria-pressed={active}
                    onClick={() => selectRole(option.value)}
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
                disabled={!form.role}
                onClick={() => setStep(2)}
              >
                {t('onboarding.next')}
              </button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="onboarding-roles" role="group" aria-label={t('onboarding.step_2')}>
              {options.map((plan) => {
                const active = form.plan === plan.id;
                return (
                  <button
                    key={plan.id}
                    type="button"
                    className={active ? 'onboarding-role active' : 'onboarding-role'}
                    aria-pressed={active}
                    onClick={() => selectPlan(plan.id)}
                  >
                    <span className="onboarding-role-copy">
                      <strong>{planLabel(plan)}</strong>
                      <small>
                        {plan.price}
                        {plan.cadence} · {plan.subtitle}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="onboarding-actions">
              <button type="button" className="ghost-button" onClick={() => setStep(1)}>
                {t('onboarding.back')}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!form.plan}
                onClick={() => setStep(3)}
              >
                {t('onboarding.next')}
              </button>
            </div>
          </>
        ) : null}

        {step === 3 ? (
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
                value={form.fullName}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, fullName: event.target.value }))
                }
                required
              />
            </div>

            {form.role === 'doctor' ? (
              <div className="field-wrap">
                <label className="onboarding-label" htmlFor="onboarding-specialty">
                  {t('onboarding.specialty')}
                </label>
                <input
                  id="onboarding-specialty"
                  className="input"
                  value={form.specialty}
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, specialty: event.target.value }))
                  }
                />
              </div>
            ) : null}

            {form.role === 'hospital' ? (
              <div className="field-wrap">
                <label className="onboarding-label" htmlFor="onboarding-clinic">
                  {t('onboarding.clinic_name')}
                </label>
                <input
                  id="onboarding-clinic"
                  className="input"
                  value={form.clinicName}
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, clinicName: event.target.value }))
                  }
                />
              </div>
            ) : null}

            {error ? <p className="field-error" role="alert">{error}</p> : null}

            <div className="onboarding-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setStep(2);
                  setError('');
                }}
                disabled={busy}
              >
                {t('onboarding.back')}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !form.fullName.trim()}
              >
                {busy ? t('onboarding.saving') : t('onboarding.complete')}
              </button>
            </div>
          </form>
        ) : null}

        {step === 4 ? (
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
