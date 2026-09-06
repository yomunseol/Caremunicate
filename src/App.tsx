import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import ProtectedRoute from './components/ProtectedRoute';
import TwoFactorSetup from './components/TwoFactorSetup';
import PasswordAuth from './components/PasswordAuth';
import { useAuth } from './context/AuthContext';

type RouteKey = 'home' | 'signup' | 'login' | 'profile' | 'pricing';
type AuthMode = 'signup' | 'login';
type AuthRole = 'patient' | 'doctor';

interface Plan {
  name: string;
  price: string;
  subtitle: string;
  description: string;
  bullets: string[];
  badge?: string;
  cta: string;
}

const featureCards = [
  {
    title: 'Emergency doctors in every region',
    description:
      'Access emergency doctors across every local region, helping patients move from urgent need to medical support without unnecessary delay.',
    accent: 'Local emergency access',
  },
  {
    title: 'Hospital-informed care',
    description:
      'Bring hospital-provided customer information and care updates into the conversation, giving providers the context needed to act faster.',
    accent: 'Connected information',
  },
  {
    title: 'Your choice of assigned doctor',
    description:
      'Choose an assigned doctor when you want ongoing care, familiar follow-ups, and a more personal route to medical support.',
    accent: 'Continuity of care',
  },
  {
    title: 'Direct online calls and sessions',
    description:
      'Use one independent platform to arrange direct calls and online meeting sessions between customers, doctors, and hospitals.',
    accent: 'Flexible connection',
  },
  {
    title: 'Save doctors for quick assistance',
    description:
      'Save trusted doctors to a personal wishlist for faster follow-ups, easier access, and quick assistance when time matters.',
    accent: 'Quick assistance',
  },
  {
    title: 'Plans, provider choice, and easy registration',
    description:
      'Choose monthly cloud plans for customers or hospitals, register with ease, and connect with certified or non-certified doctors.',
    accent: 'Accessible care network',
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

const getInitialRoute = (): RouteKey => {
  if (typeof window === 'undefined') return 'home';
  const hash = window.location.hash.replace('#', '');
  const validRoutes: RouteKey[] = ['home', 'signup', 'login', 'profile', 'pricing'];
  return validRoutes.includes(hash as RouteKey) ? (hash as RouteKey) : 'home';
};

type SignupFormValues = {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
  specialty: string;
  clinic: string;
  role: string;
};

type UserProfile = {
  fullName: string;
  email: string;
  role: string;
  specialty?: string;
  clinic?: string;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
// Individual rules shown live in the password checklist (real-time).
const passwordRuleMinLength = 8;
const passwordRuleUpper = /[A-Z]/;
const passwordRuleLower = /[a-z]/;
const passwordRuleNumber = /\d/;
const passwordRuleSpecial = /[!@#$%^&*]/;
// Aggregate requirement for submit-time validation (all rules above).
const passwordPattern =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/;

function App() {
  const { user: authUser, pending2FA, signOut } = useAuth();
  const [route, setRoute] = useState<RouteKey>(getInitialRoute);
  const [authMode, setAuthMode] = useState<AuthMode>('signup');
  const [authRole, setAuthRole] = useState<AuthRole>('patient');
  const [signupValues, setSignupValues] = useState<SignupFormValues>({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    specialty: '',
    clinic: '',
    role: '',
  });
  const [signupErrors, setSignupErrors] = useState<Record<string, string>>({});
  // Fields the user has blurred/edited — only show inline errors for these so
  // the form doesn't scream at a brand-new visitor.
  const [touchedFields, setTouchedFields] = useState<Record<string, boolean>>({});
  // Set to true right after a submit (success or failure) so the password and
  // confirm fields are cleared and are not immediately re-flagged as invalid.
  const passwordsCleared = useRef(false);
  // The user visible to the header/route logic. It is derived from the gated
  // AuthContext value, so while 2FA is pending the user is treated as logged
  // out even if a transient token exists in storage.
  const currentUser = pending2FA ? null : authUser;

  // Derive userProfile from the gated currentUser (metadata read live each
  // render from the session user object).
  const userProfile = currentUser ? (currentUser.user_metadata as UserProfile) : null;
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [authMessageType, setAuthMessageType] = useState<'success' | 'error'>('error');
  const [profileData, setProfileData] = useState<Record<string, unknown> | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState('');

  useEffect(() => {
    const syncRoute = () => {
      const nextRoute = getInitialRoute();
      setRoute(nextRoute);
      setAuthMode(nextRoute === 'login' ? 'login' : 'signup');
    };

    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchProfile = async () => {
      // Only load profile data once 2FA is complete and the user is actually
      // authenticated (gated view of the session).
      if (!currentUser) {
        setProfileData(null);
        return;
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', currentUser.id)
        .single();

      if (cancelled) return;

      if (error?.code === 'PGRST116') {
        setProfileData(null);
      } else if (error) {
        setProfileData(null);
      } else {
        setProfileData(data);
      }
    };

    void fetchProfile();

    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  const navigate = (nextRoute: RouteKey) => {
    if (nextRoute === 'profile' && (!currentUser || pending2FA)) {
      nextRoute = 'login';
    }
    if (nextRoute === 'login' || nextRoute === 'signup') {
      setAuthMode(nextRoute);
    }
    setRoute(nextRoute);
    const hash = nextRoute === 'home' ? '' : `#${nextRoute}`;
    window.history.pushState({}, '', `${window.location.pathname}${hash}`);
  };

  const openAuth = (mode: AuthMode, role: AuthRole = 'patient') => {
    setAuthMode(mode);
    setAuthRole(role);
    setRoute(mode === 'login' ? 'login' : 'signup');
    setSignupErrors({});
    setTouchedFields({});
    setAuthMessage('');
    const hash = mode === 'login' ? '#login' : '#signup';
    window.history.pushState({}, '', `${window.location.pathname}${hash}`);
  };

  const getEmailError = (value: string) => {
    if (!value.trim()) return 'Email is required.';
    if (!emailPattern.test(value.trim())) return 'Enter a valid email address.';
    return '';
  };

  const getFullNameError = (value: string) => {
    if (!value.trim()) return 'Full name is required.';
    return '';
  };

  // Individual live checks shown in the real-time checklist.
  const passwordChecks = {
    minLength: (value: string) => value.length >= passwordRuleMinLength,
    hasUpper: (value: string) => passwordRuleUpper.test(value),
    hasLower: (value: string) => passwordRuleLower.test(value),
    hasNumber: (value: string) => passwordRuleNumber.test(value),
    hasSpecial: (value: string) => passwordRuleSpecial.test(value),
  };

  const getPasswordError = (value: string) => {
    if (!value) return 'Password is required.';
    if (!passwordPattern.test(value)) {
      return 'Password must be 8+ characters with upper, lower, number, and special character (!@#$%^&*).';
    }
    return '';
  };

  const getConfirmPasswordError = (value: string) => {
    if (!value) return 'Please confirm your password.';
    if (value !== signupValues.password) return 'Passwords do not match.';
    return '';
  };

  const validateSignupForm = () => {
    const nextErrors: Record<string, string> = {};

    const fullNameError = getFullNameError(signupValues.fullName);
    if (fullNameError) {
      nextErrors.fullName = fullNameError;
    }

    const emailError = getEmailError(signupValues.email);
    if (emailError) {
      nextErrors.email = emailError;
    }

    if (authRole === 'doctor' && !signupValues.specialty.trim()) {
      nextErrors.specialty = 'Medical specialty is required.';
    }

    if (authRole === 'doctor' && !signupValues.clinic.trim()) {
      nextErrors.clinic = 'Clinic or license is required.';
    }

    const passwordError = getPasswordError(signupValues.password);
    if (passwordError) {
      nextErrors.password = passwordError;
    }

    const confirmError = getConfirmPasswordError(signupValues.confirmPassword);
    if (confirmError) {
      nextErrors.confirmPassword = confirmError;
    }

    if (!signupValues.role) {
      nextErrors.role = 'Please select a role.';
    }

    return nextErrors;
  };

  // The submit button is disabled until every rule passes. Re-evaluated on
  // every render (cheap string checks) with no memoization needed — avoids a
  // stale closure over signupValues that a useMemo dep array could introduce.
  const signupIsValid =
    !getFullNameError(signupValues.fullName) &&
    !getEmailError(signupValues.email) &&
    (authRole !== 'doctor' || Boolean(signupValues.specialty.trim())) &&
    (authRole !== 'doctor' || Boolean(signupValues.clinic.trim())) &&
    !getPasswordError(signupValues.password) &&
    !getConfirmPasswordError(signupValues.confirmPassword) &&
    Boolean(signupValues.role);

  // Real-time checklist shown under the password field. Empty password shows
  // only neutral (unmet) rows.
  const passwordChecklist = [
    { label: 'At least 8 characters', met: passwordChecks.minLength(signupValues.password) },
    { label: 'One uppercase letter', met: passwordChecks.hasUpper(signupValues.password) },
    { label: 'One lowercase letter', met: passwordChecks.hasLower(signupValues.password) },
    { label: 'One number', met: passwordChecks.hasNumber(signupValues.password) },
    { label: 'One special character (!@#$%^&*)', met: passwordChecks.hasSpecial(signupValues.password) },
  ];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextErrors = validateSignupForm();
    setSignupErrors(nextErrors);

    // Only flag the fields the user actually reached, then keep inline errors
    // off until the visitor blurs each invalid field.
    const nextTouched = { ...touchedFields };
    for (const key of Object.keys(nextErrors)) {
      nextTouched[key] = true;
    }
    setTouchedFields(nextTouched);

    if (Object.keys(nextErrors).length > 0) {
      console.log('Validation failed:', nextErrors);
      return;
    }

    console.log('Sign-up submitted with valid data');
    setIsAuthLoading(true);
    setAuthMessage('');

    try {
      const { data, error } = await supabase.auth.signUp({
        email: signupValues.email.trim(),
        password: signupValues.password,
        options: {
          data: {
            fullName: signupValues.fullName.trim(),
            role: signupValues.role,
            ...(authRole === 'doctor' ? {
              specialty: signupValues.specialty.trim(),
              clinic: signupValues.clinic.trim(),
            } : {}),
          },
        },
      });

      if (error) throw error;

      if (!data.session) {
        setAuthMessageType('success');
        setAuthMessage('Account created. Check your email to confirm your account before logging in.');
        return;
      }

      setAuthMessageType('success');
      setAuthMessage('Your account is ready.');
      navigate('profile');
    } catch (error) {
      setAuthMessageType('error');
      setAuthMessage(error instanceof Error ? error.message : 'Unable to authenticate. Please try again.');
    } finally {
      setIsAuthLoading(false);
      // Do not keep the plaintext password in component state any longer than
      // the request needs. Clear both password fields on success or error.
      setSignupValues((previous) => ({ ...previous, password: '', confirmPassword: '' }));
      passwordsCleared.current = true;
    }
  };

  const handleLogout = async () => {
    await signOut();
    setProfileMenuOpen(false);
    navigate('home');
  };

  const profileDisplayName = String(profileData?.username ?? userProfile?.fullName ?? currentUser?.email ?? 'Your profile');

  // Inline errors only appear once the visitor has interacted with a field
  // (blurred it or submitted the form). This keeps a fresh form calm.
  // After a submit clears the password fields, password/confirm are held back
  // from error display until the visitor types again.
  const showFieldError = (field: string) => {
    if ((field === 'password' || field === 'confirmPassword') && passwordsCleared.current) return false;
    return touchedFields[field] === true && Boolean(signupErrors[field]);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => navigate('home')}>
          <img src="/Caremunicate.png" alt="Caremunicate logo" className="brand-logo" />
          <span>Caremunicate</span>
        </button>

        <div className="nav-actions">
          {currentUser ? (
            <>
              <div className="profile-menu">
                <button
                  className="profile-trigger"
                  type="button"
                  aria-expanded={profileMenuOpen}
                  aria-haspopup="true"
                  onClick={() => {
                    setProfileMenuOpen((open) => !open);
                    setUpgradeMessage('');
                  }}
                >
                  <span className="profile-avatar" aria-hidden="true">{profileDisplayName.charAt(0).toUpperCase()}</span>
                  <span className="profile-trigger-copy">
                    <strong>{profileDisplayName}</strong>
                    <small>Free plan</small>
                  </span>
                  <span className="profile-chevron" aria-hidden="true">{profileMenuOpen ? '▲' : '▼'}</span>
                </button>

                {profileMenuOpen ? (
                  <div className="profile-popover" role="dialog" aria-label="Profile menu">
                    <div className="profile-popover-header">
                      <div>
                        <span className="profile-kicker">Caremunicate account</span>
                        <h3>{profileDisplayName}</h3>
                        <p>{currentUser.email}</p>
                      </div>
                      <span className="plan-status">Free</span>
                    </div>

                    <div className="plan-summary">
                      <div className="plan-summary-heading">
                        <span>Current plan</span>
                        <strong>Free plan</strong>
                      </div>
                      <p>Essential access to your profile and Caremunicate care network.</p>
                      <div className="plan-meter" aria-hidden="true"><span /></div>
                    </div>

                    <button
                      className="upgrade-button"
                      type="button"
                      onClick={() => setUpgradeMessage('Payment service currently unavailable')}
                    >
                      <span>Upgrade to other plans</span>
                      <span aria-hidden="true">→</span>
                    </button>
                    {upgradeMessage ? <p className="upgrade-message">{upgradeMessage}</p> : null}

                    <button className="popover-profile-link" type="button" onClick={() => {
                      setProfileMenuOpen(false);
                      navigate('profile');
                    }}>
                      View full profile
                    </button>
                  </div>
                ) : null}
              </div>
              <button className="primary-button" type="button" onClick={handleLogout}>
                Log out
              </button>
            </>
          ) : (
            <>
              <button className="ghost-button" type="button" onClick={() => navigate('login')}>
                Log in
              </button>
              <button className="primary-button" type="button" onClick={() => navigate('signup')}>
                Sign up
              </button>
            </>
          )}
        </div>
      </header>

      <main className="main-content">
        {route === 'home' && (
          <>
            <section className="section hero-section">
              <div className="hero-card">
                <div className="eyebrow">Medical communication • modern care</div>
                <h1 className="hero-title">
                  Direct access to care, exactly when it matters.
                </h1>
                <p className="hero-copy">
                  Caremunicate helps people facing medical-access barriers connect directly with hospitals and doctors through
                  online calls and meeting sessions. Get regional emergency support, hospital-informed care conversations,
                  an optional assigned doctor, and an emergency calling system from one accessible platform.
                </p>

                <div className="pill-row" style={{ marginBottom: '1.5rem' }}>
                  <span className="pill">Emergency calls, regional support</span>
                  <span className="pill">Monthly customer & hospital plans</span>
                  <span className="pill">Certified & non-certified doctors</span>
                </div>

                <div className="cta-row">
                  <button className="primary-button" type="button" onClick={() => navigate('signup')}>
                    Create account
                  </button>
                  <button className="secondary-button" type="button" onClick={() => navigate('pricing')}>
                    View pricing
                  </button>
                </div>
              </div>

              <div className="hero-visual">
                <img src="/Caremunicate_carousel_photo.jpg" alt="Caremunicate medical communication dashboard" />
              </div>
            </section>

            <section className="section">
              <div className="section-heading">
                <div className="eyebrow">Core features</div>
                <h2>One clear path from urgent need to connected care.</h2>
                <p>
                  Accessible registration and direct communication give customers, doctors, and hospitals the tools to respond
                  faster and keep care moving forward.
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

            <section className="section">
              <div className="section-heading">
                <div className="eyebrow">Pricing</div>
                <h2>Fair monthly plans for patients, doctors, and hospitals.</h2>
                <p>No per-call surcharges and no hidden costs.</p>
              </div>

              <div className="pricing-grid">
                {plans.map((plan) => (
                  <article className={`plan-card ${plan.badge ? 'featured' : ''}`} key={plan.name}>
                    {plan.badge ? <span className="plan-badge">{plan.badge}</span> : null}
                    <h3 className="plan-name">{plan.name}</h3>
                    <div className="plan-price">{plan.price}</div>
                    <p className="plan-subtitle">{plan.subtitle}</p>
                    <p className="plan-description">{plan.description}</p>
                    <ul>
                      {plan.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                    <button className="primary-button cta-button" type="button" onClick={() => navigate('pricing')}>
                      {plan.cta}
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section className="section">
              <div className="cta-banner">
                <div className="cta-banner-copy">
                  <div className="eyebrow">Ready when you are</div>
                  <h2>Bring calmer care communication to patients, teams, and hospitals.</h2>
                </div>

                <div className="cta-row">
                  <button className="primary-button" type="button" onClick={() => openAuth('signup')}>
                    Create account
                  </button>
                  <button className="secondary-button" type="button" onClick={() => openAuth('signup', 'doctor')}>
                    I&apos;m a doctor
                  </button>
                </div>
              </div>
            </section>
          </>
        )}

        {(route === 'signup' || route === 'login') && (
          <section className="section form-grid auth-combined-layout">
            <div className="auth-side auth-visual-panel">
              <img src="/HealthcareTeamCollab.jpg" alt="Healthcare team collaboration" />
            </div>

            <div className="auth-card auth-panel-shell">
              <div className="auth-mode-toggle" aria-label="Authentication mode selector">
                <button
                  type="button"
                  className={authMode === 'signup' ? 'mode-button active' : 'mode-button'}
                  onClick={() => openAuth('signup', authRole)}
                >
                  Sign up
                </button>
                <button
                  type="button"
                  className={authMode === 'login' ? 'mode-button active' : 'mode-button'}
                  onClick={() => openAuth('login', authRole)}
                >
                  Log in
                </button>
              </div>

              <div className="auth-form-shell" key={authMode}>
                <div className="eyebrow">{authMode === 'signup' ? 'Accessible registration' : 'Secure access'}</div>
                <h2>
                  {authMode === 'signup'
                    ? authRole === 'doctor'
                      ? 'Create your doctor profile'
                      : 'Create your Caremunicate account'
                    : 'Welcome back to Caremunicate'}
                </h2>
                <p className="auth-copy">
                  {authMode === 'signup'
                    ? authRole === 'doctor'
                      ? 'Join Caremunicate as a physician, manage your availability, and welcome patients with a calmer, clearer care experience.'
                      : 'Join as a patient, doctor, or care team member and bring clearer communication into everyday healthcare.'
                    : 'Access your dashboard, hospital updates, planned consultations, and saved doctor preferences in one secure place.'}
                </p>

                <div className="role-toggle" aria-label="Account type selector">
                  <button
                    type="button"
                    className={authRole === 'patient' ? 'role-button active' : 'role-button'}
                    onClick={() => setAuthRole('patient')}
                  >
                    Patient
                  </button>
                  <button
                    type="button"
                    className={authRole === 'doctor' ? 'role-button active' : 'role-button'}
                    onClick={() => setAuthRole('doctor')}
                  >
                    Doctor
                  </button>
                </div>

                {authMode === 'signup' ? (
                  <form onSubmit={handleSubmit} noValidate>
                    {authMessage ? <p className={authMessageType === 'success' ? 'auth-success' : 'field-error'}>{authMessage}</p> : null}
                    <>
                      <div className="form-row">
                        <div className="field-wrap">
                          <input
                            className="input"
                            placeholder="Full name"
                            aria-label="Full name"
                            value={signupValues.fullName}
                            onBlur={() => setTouchedFields((previous) => ({ ...previous, fullName: true }))}
                            onChange={(event) => {
                              setSignupValues((previous) => ({ ...previous, fullName: event.target.value }));
                              if (signupErrors.fullName) {
                                setSignupErrors((previous) => ({ ...previous, fullName: '' }));
                              }
                            }}
                            aria-invalid={showFieldError('fullName')}
                          />
                          {showFieldError('fullName') ? <span className="field-error">{signupErrors.fullName}</span> : null}
                        </div>
                        <div className="field-wrap">
                          <input
                            className="input"
                            placeholder="Email address"
                            type="email"
                            aria-label="Email address"
                            value={signupValues.email}
                            onBlur={() => setTouchedFields((previous) => ({ ...previous, email: true }))}
                            onChange={(event) => {
                              setSignupValues((previous) => ({ ...previous, email: event.target.value }));
                              if (signupErrors.email) {
                                setSignupErrors((previous) => ({ ...previous, email: '' }));
                              }
                            }}
                            aria-invalid={showFieldError('email')}
                          />
                          {showFieldError('email') ? <span className="field-error">{signupErrors.email}</span> : null}
                        </div>
                      </div>

                      {authRole === 'doctor' ? (
                        <div className="form-row">
                          <div className="field-wrap">
                            <input
                              className="input"
                              placeholder="Medical specialty"
                              aria-label="Medical specialty"
                              value={signupValues.specialty}
                              onBlur={() => setTouchedFields((previous) => ({ ...previous, specialty: true }))}
                              onChange={(event) => {
                                setSignupValues((previous) => ({ ...previous, specialty: event.target.value }));
                                if (signupErrors.specialty) {
                                  setSignupErrors((previous) => ({ ...previous, specialty: '' }));
                                }
                              }}
                              aria-invalid={showFieldError('specialty')}
                            />
                            {showFieldError('specialty') ? <span className="field-error">{signupErrors.specialty}</span> : null}
                          </div>
                          <div className="field-wrap">
                            <input
                              className="input"
                              placeholder="License or clinic"
                              aria-label="License or clinic"
                              value={signupValues.clinic}
                              onBlur={() => setTouchedFields((previous) => ({ ...previous, clinic: true }))}
                              onChange={(event) => {
                                setSignupValues((previous) => ({ ...previous, clinic: event.target.value }));
                                if (signupErrors.clinic) {
                                  setSignupErrors((previous) => ({ ...previous, clinic: '' }));
                                }
                              }}
                              aria-invalid={showFieldError('clinic')}
                            />
                            {showFieldError('clinic') ? <span className="field-error">{signupErrors.clinic}</span> : null}
                          </div>
                        </div>
                      ) : null}

                      <div className="field-wrap">
                        <input
                          className="input"
                          placeholder="Password"
                          type="password"
                          aria-label="Password"
                          autoComplete="new-password"
                          value={signupValues.password}
                          onBlur={() => setTouchedFields((previous) => ({ ...previous, password: true }))}
                          onChange={(event) => {
                            const nextPassword = event.target.value;
                            setSignupValues((previous) => ({ ...previous, password: nextPassword }));
                            passwordsCleared.current = false;
                            if (signupErrors.password || signupErrors.confirmPassword) {
                              setSignupErrors((previous) => ({
                                ...previous,
                                password: '',
                                confirmPassword: '',
                              }));
                            }
                          }}
                          aria-invalid={showFieldError('password')}
                        />
                        {showFieldError('password') ? <span className="field-error">{signupErrors.password}</span> : null}

                        {/* Real-time password requirements checklist. Hidden until
                            the user starts typing, then updates live. */}
                        {signupValues.password.length > 0 ? (
                          <ul className="password-checklist" aria-label="Password requirements">
                            {passwordChecklist.map((item) => (
                              <li key={item.label} className={item.met ? 'password-rule met' : 'password-rule'}>
                                <span aria-hidden="true">{item.met ? '✅' : '❌'}</span> {item.label}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>

                      <div className="field-wrap">
                        <input
                          className="input"
                          placeholder="Confirm password"
                          type="password"
                          aria-label="Confirm password"
                          autoComplete="new-password"
                          value={signupValues.confirmPassword}
                          onBlur={() => setTouchedFields((previous) => ({ ...previous, confirmPassword: true }))}
                          onChange={(event) => {
                            setSignupValues((previous) => ({ ...previous, confirmPassword: event.target.value }));
                            if (signupErrors.confirmPassword) {
                              setSignupErrors((previous) => ({ ...previous, confirmPassword: '' }));
                            }
                          }}
                          aria-invalid={showFieldError('confirmPassword')}
                        />
                        {showFieldError('confirmPassword') ? (
                          <span className="field-error">{signupErrors.confirmPassword}</span>
                        ) : null}
                      </div>

                      <div className="field-wrap">
                        <select
                          className="select"
                          value={signupValues.role}
                          aria-label="Select role"
                          onBlur={() => setTouchedFields((previous) => ({ ...previous, role: true }))}
                          onChange={(event) => {
                            setSignupValues((previous) => ({ ...previous, role: event.target.value }));
                            if (signupErrors.role) {
                              setSignupErrors((previous) => ({ ...previous, role: '' }));
                            }
                          }}
                          aria-invalid={showFieldError('role')}
                        >
                          <option value="" disabled>
                            {authRole === 'doctor' ? 'Professional type' : 'Select your role'}
                          </option>
                          <option value="patient">Patient</option>
                          <option value="doctor">Doctor</option>
                          <option value="hospital">Hospital</option>
                        </select>
                        {showFieldError('role') ? <span className="field-error">{signupErrors.role}</span> : null}
                      </div>

                      <button className="primary-button" type="submit" disabled={isAuthLoading || !signupIsValid}>
                        {isAuthLoading ? 'Creating account...' : authRole === 'doctor' ? 'Create doctor profile' : 'Create account'}
                      </button>
                    </>
                  </form>
                ) : (
                  <PasswordAuth onAuthenticated={() => navigate('profile')} />
                )}

                <div className="auth-benefits">
                  <div className="eyebrow">{authMode === 'signup' ? 'What you unlock' : 'Helpful recovery tools'}</div>
                  <ul className="thin-list">
                    {(authMode === 'signup'
                      ? authRole === 'doctor'
                        ? [
                            'Professional profile and availability setup',
                            'Patient routing and care follow-up tools',
                            'Hospital and department collaboration workflows',
                          ]
                        : [
                            'Emergency routing and communication support',
                            'Doctor wishlist and assigned care tools',
                            'Hospital updates and monthly plan access',
                          ]
                      : [
                          'Fast profile access',
                          'Saved doctors for quick follow-up',
                          'Emergency support and dashboard tools',
                        ])
                      .map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                  </ul>
                </div>
              </div>
            </div>
          </section>
        )}

        {route === 'profile' && (
          <ProtectedRoute>
            <section className="section profile-grid">
            <div className="profile-card">
              <div className="eyebrow">Your care dashboard</div>
              <h2>Welcome back, {userProfile?.fullName ?? currentUser?.email ?? 'there'}</h2>
              <p className="hero-copy">
                Your {userProfile?.role ?? 'care'} profile is connected to hospital updates, your wishlist, and your
                ongoing care preferences.
              </p>

              <div className="pill-row">
                <span className="pill">Assigned doctor enabled</span>
                <span className="pill">Emergency line active</span>
                <span className="pill">Hospital sync ready</span>
              </div>

              <div className="profile-grid">
                <div className="panel">
                  <h3>Assigned doctor</h3>
                  <p>No assigned doctors yet. Choose an assigned doctor when you are ready for ongoing care and follow-up support.</p>
                </div>

                <div className="panel">
                  <h3>Wishlist</h3>
                  <p>No doctors saved yet. Add trusted doctors to your wishlist for quick access later.</p>
                </div>
              </div>
            </div>

            <div className="profile-sidebar">
              <div className="panel">
                <div className="eyebrow">Emergency line</div>
                <h3>Emergency service unavailable</h3>
                <p>The emergency calling service is not available right now. Please check back later for updates.</p>
                <button className="primary-button" type="button" style={{ marginTop: '0.9rem' }} disabled>
                  Service unavailable
                </button>
              </div>

              <TwoFactorSetup />

              <div className="panel">
                <div className="eyebrow">Hospital updates</div>
                <h3>Latest care notes</h3>
                <p>Fresh hospital information, case notes, and follow-up updates are ready for review whenever you need them.</p>
              </div>
            </div>
            </section>
          </ProtectedRoute>
        )}

        {route === 'pricing' && (
          <section className="section">
            <div className="section-heading">
              <div className="eyebrow">Pricing</div>
              <h2>Fair fees for patients, doctors, and hospitals.</h2>
              <p>Simple monthly plans. No per-call surcharges, no hidden costs.</p>
            </div>

            <div className="pricing-grid">
              {plans.map((plan) => (
                <article className={`plan-card ${plan.badge ? 'featured' : ''}`} key={plan.name}>
                  {plan.badge ? <span className="plan-badge">{plan.badge}</span> : null}
                  <h3 className="plan-name">{plan.name}</h3>
                  <div className="plan-price">{plan.price}</div>
                  <p className="plan-subtitle">{plan.subtitle}</p>
                  <p className="plan-description">{plan.description}</p>
                  <ul>
                    {plan.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                  <button className="primary-button" type="button">
                    {plan.cta}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <p>Caremunicate • A calm, postmodern medical communication experience.</p>
      </footer>
    </div>
  );
}

export default App;