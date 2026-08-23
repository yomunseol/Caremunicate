import type { RouteKey } from '../types';

interface HomePageProps {
  onNavigate: (route: RouteKey) => void;
}

interface Plan {
  name: string;
  price: string;
  subtitle: string;
  description: string;
  bullets: string[];
  badge?: string;
  cta: string;
}

interface FeatureCard {
  title: string;
  description: string;
  accent: string;
}

const featureCards: FeatureCard[] = [
  {
    title: 'Emergency doctors by region',
    description:
      'A local emergency doctor layer helps patients reach fast support in every region without losing time.',
    accent: 'Regional coverage',
  },
  {
    title: 'Hospital-informed care',
    description:
      'Hospital updates, patient context, and care routing remain visible in a clear, simple care dashboard.',
    accent: 'Hospital sync',
  },
  {
    title: 'Assigned doctor options',
    description:
      'Every patient can optionally choose an assigned physician for continuity, follow-ups, and faster routing.',
    accent: 'Continuity',
  },
  {
    title: 'Independent calling concept',
    description:
      'Caremunicate supports an abstract independent platform concept for customers who want their own calling flow.',
    accent: 'Flexible access',
  },
  {
    title: 'Wishlist doctor saving',
    description:
      'Patients can save doctors to a wishlist for quick assistance, long-term care, and faster follow-ups.',
    accent: 'Quick assist',
  },
  {
    title: 'Certified and non-certified doctors',
    description:
      'The experience highlights both certified and non-certified provider paths for a broad care ecosystem.',
    accent: 'Flexible care',
  },
];

const plans: Plan[] = [
  {
    name: 'Patient Basic',
    price: '$9/month',
    subtitle: 'Essential access for occasional care needs.',
    description: 'Simple access for lighter use and everyday care discovery.',
    bullets: [
      'Up to 3 voice consultations / month',
      'Up to 1 short video consultation / month',
      'Basic doctor discovery',
      'Save up to 3 doctors to wishlist',
      'Standard queue routing',
    ],
    cta: 'Choose Basic',
  },
  {
    name: 'Patient + Assigned Doctor',
    price: '$29/month',
    subtitle: 'A dedicated physician who knows your history and prioritizes your calls.',
    description: 'A strong middle tier for continuity, priority routing, and follow-up care.',
    bullets: [
      'Up to 10 high-quality voice & video consultations',
      'Dedicated assigned doctor',
      'Priority routing & emergency line',
      'Unlimited wishlist',
      'Follow-up scheduling',
    ],
    badge: 'Most chosen',
    cta: 'Choose Assigned Doctor',
  },
  {
    name: 'Patient Pro',
    price: '$49/month',
    subtitle: 'For those who seek very often consultations.',
    description: 'A premium patient plan for frequent communication and rapid support.',
    bullets: [
      'Unlimited voice & video consultations per month (1 per day)',
      '2-3 assigned doctors',
      'Fastest priority routing',
      'Emergency line',
      'Automatic scheduling with AI',
    ],
    cta: 'Choose Pro',
  },
  {
    name: 'Independent Doctor',
    price: '$69/month',
    subtitle: 'For independent physicians who want to see patients directly on Caremunicate.',
    description: 'A doctor-focused plan for personal patient lists and direct care access.',
    bullets: [
      'Verified public doctor profile',
      'Accept voice & video consultations',
      'Personal patient list & notes',
      'Own scheduling & availability',
      'Direct payouts, no hospital required',
    ],
    cta: 'Join as doctor',
  },
  {
    name: 'Department Plan',
    price: '$149/month',
    subtitle: 'For hospital departments — onboard your team and patients together.',
    description: 'A department-level plan for internal care coordination and patient sync.',
    bullets: [
      'Up to 5 doctor accounts / department',
      'Department-wide patient sync',
      'Emergency dispatch tools',
      'Analytics & compliance dashboard',
    ],
    cta: 'Talk to sales',
  },
  {
    name: 'Hospital Plan',
    price: '$399/month',
    subtitle: 'For hospital-wide oversight and high-volume communication.',
    description: 'A large-scale plan for full hospital orchestration and AI-integrated workflows.',
    bullets: [
      'Up to 5 underlying departments',
      'Hospital-wide patient syncing',
      'Emergency dispatch tools',
      'Direct payouts and systematic tools with AI integration',
    ],
    cta: 'Talk to sales',
  },
];

function HomePage({ onNavigate }: HomePageProps) {
  return (
    <main className="main-content">
      {/* HERO SECTION */}
      <section className="section hero-section">
        <div className="hero-card">
          <div className="eyebrow">Medical communication • modern care</div>
          <h1 className="hero-title">
            Caremunicate brings calm care conversations to patients, doctors, and hospitals.
          </h1>
          <p className="hero-copy">
            A lifestyle-ready medical communication platform for emergencies, hospital updates,
            assigned doctors, and flexible care access. The experience stays simple, modern, and approachable.
          </p>

          <div className="pill-row" style={{ marginBottom: '1.5rem' }}>
            <span className="pill">24/7 emergency routing</span>
            <span className="pill">Cloud-based monthly plans</span>
            <span className="pill">Certified & community doctors</span>
          </div>

          <div className="cta-row">
            <button className="primary-button" type="button" onClick={() => onNavigate('signup')}>
              Create account
            </button>
            <button className="secondary-button" type="button" onClick={() => onNavigate('pricing')}>
              View pricing
            </button>
          </div>
        </div>

        <div className="hero-visual">
          <img src="/Caremunicate_carousel_photo.jpg" alt="Caremunicate medical communication dashboard" />
        </div>
      </section>

      {/* CORE FEATURES SECTION */}
      <section className="section">
        <div className="section-heading">
          <div className="eyebrow">Core features</div>
          <h2>Care-focused features built for front-end interaction and product storytelling.</h2>
          <p>
            The page includes core care communication ideas such as emergency routing, assigned physician support,
            hospital updates, and flexible doctor access.
          </p>
        </div>

        <div className="feature-grid">
          {featureCards.map((card) => (
            <article className="feature-card" key={card.title}>
              <div className="feature-accent">{card.accent}</div>
              <h3>{card.title}</h3>
              <p>{card.description}</p>
            </article>
          ))}
        </div>
      </section>

      {/* CARE NETWORK SECTION */}
      <section className="section care-network">
        <div className="care-grid">
          <img src="/Caremunicate_Paragraph_photo.jpg" alt="Caremunicate care network" className="care-image" />
          <div className="care-content">
            <div className="eyebrow">Care network at a glance</div>
            <h2>Simple communication layers for hospitals, doctors, and patients.</h2>
            <p className="hero-copy">
              Customers can sign in, browse care options, and save doctors to their wishlist. Doctors can join as
              independent professionals or take part in a department plan.
            </p>
            <div className="stack-list">
              <div className="stack-item">
                <strong>Emergency line</strong>
                <span>Fast, calm access to care support when a patient needs help immediately.</span>
              </div>
              <div className="stack-item">
                <strong>Hospital info</strong>
                <span>Hospitals can share care notes, procedural notes, and relevant service information.</span>
              </div>
              <div className="stack-item">
                <strong>Assigned doctors</strong>
                <span>Patients can be paired with a personal doctor when they choose that option.</span>
              </div>
            </div>
            <div className="pill-row" style={{ marginTop: '1.2rem' }}>
              <span className="pill">Customer registration</span>
              <span className="pill">Doctor registration</span>
              <span className="pill">Wishlist saving</span>
            </div>
          </div>
        </div>
      </section>

      {/* PRICING PREVIEW SECTION */}
      <section className="section">
        <div className="section-heading">
          <div className="eyebrow">Pricing preview</div>
          <h2>Fair monthly plans for patients, doctors, and hospitals.</h2>
          <p>No per-call surcharges and no hidden costs.</p>
        </div>

        <div className="pricing-grid">
          {plans.slice(0, 3).map((plan) => (
            <article className={`plan-card ${plan.badge ? 'featured' : ''}`} key={plan.name}>
              {plan.badge ? <span className="plan-badge">{plan.badge}</span> : null}
              <h3 className="plan-name">{plan.name}</h3>
              <div className="plan-price">{plan.price}</div>
              <p className="plan-subtitle">{plan.subtitle}</p>
              <p className="plan-description">{plan.description}</p>
              <button className="primary-button cta-button" type="button" onClick={() => onNavigate('pricing')}>
                {plan.cta}
              </button>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}