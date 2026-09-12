import type { CSSProperties } from 'react';
import { useLang } from '../i18n';

export type PlanId = 'free' | 'care-plus' | 'doctor' | 'clinic';

export type Plan = {
  id: PlanId;
  name: string;
  price: string;
  cadence: string;
  subtitle: string;
  bullets: string[];
  badge?: string;
  cta: string;
  // Role the sign-up form should preselect when a logged-out visitor picks
  // this plan (Doctor/Clinic are professional plans).
  signupRole: 'patient' | 'doctor';
  // Whether choosing this plan promotes a logged-in account to the doctor
  // role (profiles.role = 'doctor').
  grantsDoctorRole: boolean;
};

type Translate = (key: string, vars?: Record<string, string | number>) => string;

type PlanMeta = {
  id: PlanId;
  base: string;
  price: string;
  cadence: string;
  bulletKeys: string[];
  popular?: boolean;
  signupRole: 'patient' | 'doctor';
  grantsDoctorRole: boolean;
};

// Language-neutral plan metadata. Every visible string resolves through i18n,
// so the four plans exist once and render in all locales.
const PLAN_META: PlanMeta[] = [
  {
    id: 'free',
    base: 'pricing.free',
    price: '$0',
    cadence: '/mo',
    bulletKeys: ['pricing.free.b1', 'pricing.free.b2', 'pricing.free.b3'],
    signupRole: 'patient',
    grantsDoctorRole: false,
  },
  {
    id: 'care-plus',
    base: 'pricing.carePlus',
    price: '$9',
    cadence: '/mo',
    bulletKeys: ['pricing.carePlus.b1', 'pricing.carePlus.b2', 'pricing.carePlus.b3'],
    popular: true,
    signupRole: 'patient',
    grantsDoctorRole: false,
  },
  {
    id: 'doctor',
    base: 'pricing.doctor',
    price: '$29',
    cadence: '/mo',
    bulletKeys: ['pricing.doctor.b1', 'pricing.doctor.b2', 'pricing.doctor.b3', 'pricing.doctor.b4'],
    signupRole: 'doctor',
    grantsDoctorRole: true,
  },
  {
    id: 'clinic',
    base: 'pricing.clinic',
    price: '$79',
    cadence: '/mo',
    bulletKeys: ['pricing.clinic.b1', 'pricing.clinic.b2', 'pricing.clinic.b3'],
    signupRole: 'doctor',
    grantsDoctorRole: true,
  },
];

export const getPlans = (t: Translate): Plan[] =>
  PLAN_META.map((meta) => ({
    id: meta.id,
    name: t(`${meta.base}.name`),
    price: meta.price,
    cadence: meta.cadence,
    subtitle: t(`${meta.base}.subtitle`),
    bullets: meta.bulletKeys.map((key) => t(key)),
    badge: meta.popular ? t('pricing.mostPopular') : undefined,
    cta: t(`${meta.base}.cta`),
    signupRole: meta.signupRole,
    grantsDoctorRole: meta.grantsDoctorRole,
  }));

export const isPlanId = (value: string | null | undefined): value is PlanId =>
  typeof value === 'string' && PLAN_META.some((plan) => plan.id === value);

type PricingSectionProps = {
  onSelectPlan: (planId: PlanId) => void;
  heading: string;
  subheading: string;
  currentPlan?: PlanId | null;
  busyPlan?: PlanId | null;
};

export default function PricingSection({
  onSelectPlan,
  heading,
  subheading,
  currentPlan = null,
  busyPlan = null,
}: PricingSectionProps) {
  const { t } = useLang();
  const plans = getPlans(t);
  const busy = busyPlan !== null;

  return (
    <section className="section" id="pricing">
      <div className="section-heading">
        <div className="eyebrow">{t('pricing.eyebrow')}</div>
        <h2>{heading}</h2>
        <p>{subheading}</p>
      </div>

      <div className="pricing-grid" aria-busy={busy}>
        {plans.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          const isBusy = busyPlan === plan.id;

          return (
            <article className={`plan-card ${plan.badge ? 'featured' : ''}`} key={plan.id}>
              {plan.badge || isCurrent ? (
                <div className="plan-badges">
                  {plan.badge ? <span className="plan-badge">{plan.badge}</span> : null}
                  {isCurrent ? <span className="plan-current">{t('pricing.currentPlan')}</span> : null}
                </div>
              ) : null}

              <h3 className="plan-name">{plan.name}</h3>
              <div className="plan-price">
                {plan.price}
                <span className="plan-cadence">{plan.cadence}</span>
              </div>
              <p className="plan-subtitle">{plan.subtitle}</p>

              <ul>
                {plan.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>

              <button
                className="primary-button cta-button"
                type="button"
                onClick={() => onSelectPlan(plan.id)}
                disabled={busy}
                aria-busy={isBusy}
                aria-label={`${plan.cta} — ${plan.name} ${t('common.plan')}`}
              >
                {isBusy ? t('pricing.saving') : plan.cta}
              </button>
            </article>
          );
        })}
      </div>

      <p className="pricing-footnote">{t('pricing.footnote')}</p>
    </section>
  );
}
