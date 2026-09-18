import type { CSSProperties } from 'react';
import { useLang } from '../i18n';

export type PlanId = 'basic' | 'plus' | 'pro' | 'starter' | 'practice' | 'organization';

/** Two families. A role never displays the other family's tiers. */
export type PlanFamily = 'patient' | 'provider';

export type Plan = {
  id: PlanId;
  family: PlanFamily;
  name: string;
  price: string;
  cadence: string;
  subtitle: string;
  bullets: string[];
  badge?: string;
  cta: string;
  // Role the sign-up form should preselect when a logged-out visitor picks
  // this plan (provider plans are professional).
  signupRole: 'patient' | 'doctor';
  // Whether choosing this plan promotes a logged-in account to a provider role.
  grantsDoctorRole: boolean;
};

export const PLAN_FAMILY: Record<PlanId, PlanFamily> = {
  basic: 'patient',
  plus: 'patient',
  pro: 'patient',
  starter: 'provider',
  practice: 'provider',
  organization: 'provider',
};

export const planFamilyOf = (plan: PlanId): PlanFamily => PLAN_FAMILY[plan];

/**
 * Legacy ids that may still be sitting in profiles.plan from before the two
 * families were named. They map onto the provider family so an old provider
 * account reads as a provider tier instead of a patient one.
 */
export const LEGACY_PLAN_ALIASES: Record<string, PlanId> = {
  'independent-doctor': 'starter',
  department: 'practice',
  hospital: 'organization',
};

/** The default tier for a family — also the badge a mismatched row falls back to. */
export const defaultPlanForFamily = (family: PlanFamily): PlanId =>
  family === 'provider' ? 'starter' : 'basic';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

type PlanMeta = {
  id: PlanId;
  family: PlanFamily;
  /** Display-name key (plans.*). */
  nameKey: string;
  /** Copy base key for the subtitle / bullets / CTA. */
  base: string;
  price: string;
  cadence: string;
  bulletKeys: string[];
  popular?: boolean;
  signupRole: 'patient' | 'doctor';
  grantsDoctorRole: boolean;
};

// Language-neutral plan metadata. Every visible string resolves through i18n,
// so the six plans exist once and render in all locales.
const PLAN_META: PlanMeta[] = [
  {
    id: 'basic',
    family: 'patient',
    nameKey: 'plans.planBasic',
    base: 'pricing.basic',
    price: '$9',
    cadence: '/mo',
    bulletKeys: ['pricing.basic.b1', 'pricing.basic.b2'],
    signupRole: 'patient',
    grantsDoctorRole: false,
  },
  {
    id: 'plus',
    family: 'patient',
    nameKey: 'plans.planPlus',
    base: 'pricing.plus',
    price: '$29',
    cadence: '/mo',
    bulletKeys: [
      'pricing.plus.b1',
      'pricing.plus.b2',
      'pricing.plus.b3',
      'pricing.plus.b4',
    ],
    popular: true,
    signupRole: 'patient',
    grantsDoctorRole: false,
  },
  {
    id: 'pro',
    family: 'patient',
    nameKey: 'plans.planPro',
    base: 'pricing.pro',
    price: '$49',
    cadence: '/mo',
    bulletKeys: [
      'pricing.pro.b1',
      'pricing.pro.b2',
      'pricing.pro.b3',
      'pricing.pro.b4',
    ],
    signupRole: 'patient',
    grantsDoctorRole: false,
  },
  {
    id: 'starter',
    family: 'provider',
    nameKey: 'plans.planStarter',
    // Provider copy: reuses the solo-practice tier's subtitle/bullets/CTA.
    base: 'pricing.independentDoctor',
    price: '$79',
    cadence: '/mo',
    bulletKeys: [
      'pricing.independentDoctor.b1',
      'pricing.independentDoctor.b2',
      'pricing.independentDoctor.b3',
      'pricing.independentDoctor.b4',
      'pricing.independentDoctor.b5',
    ],
    signupRole: 'doctor',
    grantsDoctorRole: true,
  },
  {
    id: 'practice',
    family: 'provider',
    nameKey: 'plans.planPractice',
    base: 'pricing.department',
    price: '$149',
    cadence: '/mo',
    bulletKeys: [
      'pricing.department.b1',
      'pricing.department.b2',
      'pricing.department.b3',
      'pricing.department.b4',
    ],
    signupRole: 'doctor',
    grantsDoctorRole: true,
  },
  {
    id: 'organization',
    family: 'provider',
    nameKey: 'plans.planOrganization',
    base: 'pricing.hospital',
    price: '$399',
    cadence: '/mo',
    bulletKeys: [
      'pricing.hospital.b1',
      'pricing.hospital.b2',
      'pricing.hospital.b3',
      'pricing.hospital.b4',
    ],
    signupRole: 'doctor',
    grantsDoctorRole: true,
  },
];

export const getPlans = (t: Translate): Plan[] =>
  PLAN_META.map((meta) => ({
    id: meta.id,
    family: meta.family,
    name: t(meta.nameKey),
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

/** Accepts a current id or a legacy alias; null when it is neither. */
export const normalizePlanId = (value: string | null | undefined): PlanId | null => {
  if (typeof value !== 'string' || !value) return null;
  if (isPlanId(value)) return value;
  return LEGACY_PLAN_ALIASES[value] ?? null;
};

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
