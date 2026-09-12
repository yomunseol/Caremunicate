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

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    cadence: '/mo',
    subtitle: 'Everything you need to start a care conversation today.',
    bullets: ['1 active conversation', 'Basic messaging', 'Email 2FA'],
    cta: 'Start Free',
    signupRole: 'patient',
    grantsDoctorRole: false,
  },
  {
    id: 'care-plus',
    name: 'Care Plus',
    price: '$9',
    cadence: '/mo',
    subtitle: 'For people who message their care team often.',
    bullets: ['Unlimited conversations', 'File sharing', 'Priority doctor replies'],
    badge: 'Most Popular',
    cta: 'Get Care Plus',
    signupRole: 'patient',
    grantsDoctorRole: false,
  },
  {
    id: 'doctor',
    name: 'Doctor',
    price: '$29',
    cadence: '/mo',
    subtitle: 'Run your own patient list and consult directly.',
    bullets: ['Patient roster', 'Group chats', 'Care notes', "Role set to 'doctor'"],
    cta: 'Start as Doctor',
    signupRole: 'doctor',
    grantsDoctorRole: true,
  },
  {
    id: 'clinic',
    name: 'Clinic',
    price: '$79',
    cadence: '/mo',
    subtitle: 'One shared workspace for your whole practice.',
    bullets: ['Multiple doctor seats', 'Shared inbox', 'Admin dashboard'],
    cta: 'Start as Clinic',
    signupRole: 'doctor',
    grantsDoctorRole: true,
  },
];

export const isPlanId = (value: string | null | undefined): value is PlanId =>
  typeof value === 'string' && PLANS.some((plan) => plan.id === value);

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
  const busy = busyPlan !== null;

  return (
    <section className="section" id="pricing">
      <div className="section-heading">
        <div className="eyebrow">Pricing</div>
        <h2>{heading}</h2>
        <p>{subheading}</p>
      </div>

      <div className="pricing-grid" aria-busy={busy}>
        {PLANS.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          const isBusy = busyPlan === plan.id;

          return (
            <article className={`plan-card ${plan.badge ? 'featured' : ''}`} key={plan.id}>
              {plan.badge || isCurrent ? (
                <div className="plan-badges">
                  {plan.badge ? <span className="plan-badge">{plan.badge}</span> : null}
                  {isCurrent ? <span className="plan-current">Current plan</span> : null}
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
                aria-label={`${plan.cta} — ${plan.name} plan`}
              >
                {isBusy ? 'Saving...' : plan.cta}
              </button>
            </article>
          );
        })}
      </div>

      <p className="pricing-footnote">Payments coming soon — all plans are free during beta.</p>
    </section>
  );
}
