import { useEffect, useState, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import ProtectedRoute from './components/ProtectedRoute';
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
  specialty: string;
  clinic: string;
  role: string;
};

type LoginFormValues = {
  email: string;
  password: string;
};

type UserProfile = {
  fullName: string;
  email: string;
  role: string;
  specialty?: string;
  clinic?: string;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

function App() {
  const { user: authUser } = useAuth();
  const [route, setRoute] = useState<RouteKey>(getInitialRoute);
  const [authMode, setAuthMode] = useState<AuthMode>('signup');
  const [authRole, setAuthRole] = useState<AuthRole>('patient');
  const [signupValues, setSignupValues] = useState<SignupFormValues>({
    fullName: '',
    email: '',
    password: '',
    specialty: '',
    clinic: '',
    role: '',
  });
  const [loginValues, setLoginValues] = useState<LoginFormValues>({
    email: '',
    password: '',
  });
  const [signupErrors, setSignupErrors] = useState<Record<string, string>>({});
  const [loginErrors, setLoginErrors] = useState<Record<string, string>>({});
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [authMessageType, setAuthMessageType] = useState<'success' | 'error'>('error');
  const [profileData, setProfileData] = useState<Record<string, unknown> | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileFormVisible, setProfileFormVisible] = useState(false);
  const [profileUsername, setProfileUsername] = useState('');
  const [profileBio, setProfileBio] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
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
    supabase.auth.getSession().then(({ data: { session } }) => {
      const user = session?.user ?? null;
      setCurrentUser(user);
      setUserProfile(user ? (user.user_metadata as UserProfile) : null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setCurrentUser(user);
      setUserProfile(user ? (user.user_metadata as UserProfile) : null);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchProfile = async () => {
      if (!authUser) {
        setProfileData(null);
        setProfileError('');
        setProfileFormVisible(false);
        setProfileLoading(false);
        return;
      }

      setProfileLoading(true);
      setProfileError('');

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', authUser.id)
        .single();

      if (cancelled) return;

      if (error?.code === 'PGRST116') {
        setProfileData(null);
        setProfileFormVisible(true);
      } else if (error) {
        setProfileData(null);
        setProfileError(error.message);
        setProfileFormVisible(false);
      } else {
        setProfileData(data);
        setProfileUsername(String(data.username ?? ''));
        setProfileBio(String(data.bio ?? ''));
        setProfileFormVisible(false);
      }

      setProfileLoading(false);
    };

    void fetchProfile();

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!authUser || !profileUsername.trim()) {
      setProfileError('Username is required.');
      return;
    }

    setProfileSaving(true);
    setProfileError('');

    const profileValues = {
      user_id: authUser.id,
      username: profileUsername.trim(),
      bio: profileBio.trim(),
    };

    const response = profileData
      ? await supabase
          .from('profiles')
          .update({ username: profileValues.username, bio: profileValues.bio })
          .eq('user_id', authUser.id)
          .select('*')
          .single()
      : await supabase.from('profiles').insert(profileValues).select('*').single();

    if (response.error) {
      setProfileError(response.error.message);
    } else {
      setProfileData(response.data);
      setProfileFormVisible(false);
    }

    setProfileSaving(false);
  };

  const navigate = (nextRoute: RouteKey) => {
    if (nextRoute === 'profile' && !currentUser) {
      nextRoute = 'login';
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
    setLoginErrors({});
    setAuthMessage('');
    const hash = mode === 'login' ? '#login' : '#signup';
    window.history.pushState({}, '', `${window.location.pathname}${hash}`);
  };

  const getEmailError = (value: string) => {
    if (!value.trim()) return 'Email is required.';
    if (!emailPattern.test(value.trim())) return 'Enter a valid email address.';
    return '';
  };

  const getPasswordError = (value: string) => {
    if (!value.trim()) return 'Password is required.';
    if (value.length < 8) return 'Password must be at least 8 characters long.';
    if (!passwordPattern.test(value)) return 'Use upper, lower, and a number in the password.';
    return '';
  };

  const validateSignupForm = () => {
    const nextErrors: Record<string, string> = {};

    if (!signupValues.fullName.trim()) {
      nextErrors.fullName = 'Full name is required.';
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

    if (!signupValues.role) {
      nextErrors.role = 'Please select a role.';
    }

    return nextErrors;
  };

  const validateLoginForm = () => {
    const nextErrors: Record<string, string> = {};

    const emailError = getEmailError(loginValues.email);
    if (emailError) {
      nextErrors.email = emailError;
    }

    const passwordError = getPasswordError(loginValues.password);
    if (passwordError) {
      nextErrors.password = passwordError;
    }

    return nextErrors;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (authMode === 'signup') {
      const nextErrors = validateSignupForm();
      setSignupErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;
    } else {
      const nextErrors = validateLoginForm();
      setLoginErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;
    }

    setIsAuthLoading(true);
    setAuthMessage('');

    try {
      let error;

      if (authMode === 'signup') {
        const { data, error: signupError } = await supabase.auth.signUp({
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
        error = signupError;

        if (!error && !data.session) {
          setAuthMessageType('success');
          setAuthMessage('Account created. Check your email to confirm your account before logging in.');
          return;
        }
      } else {
        const { error: loginError } = await supabase.auth.signInWithPassword({
          email: loginValues.email.trim(),
          password: loginValues.password,
        });
        error = loginError;
      }

      if (error) throw error;
      setAuthMessageType('success');
      setAuthMessage(authMode === 'signup' ? 'Your account is ready.' : 'You are now logged in.');
      navigate('profile');
    } catch (error) {
      setAuthMessageType('error');
      setAuthMessage(error instanceof Error ? error.message : 'Unable to authenticate. Please try again.');
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setProfileMenuOpen(false);
    navigate('home');
  };

  const profileDisplayName = String(profileData?.username ?? userProfile?.fullName ?? currentUser?.email ?? 'Your profile');

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

                <form onSubmit={handleSubmit}>
                  {authMessage ? <p className={authMessageType === 'success' ? 'auth-success' : 'field-error'}>{authMessage}</p> : null}
                  {authMode === 'signup' ? (
                    <>
                      <div className="form-row">
                        <div className="field-wrap">
                          <input
                            className="input"
                            placeholder="Full name"
                            aria-label="Full name"
                            value={signupValues.fullName}
                            onChange={(event) => {
                              setSignupValues((previous) => ({ ...previous, fullName: event.target.value }));
                              setSignupErrors((previous) => ({ ...previous, fullName: '' }));
                            }}
                            aria-invalid={Boolean(signupErrors.fullName)}
                          />
                          {signupErrors.fullName ? <span className="field-error">{signupErrors.fullName}</span> : null}
                        </div>
                        <div className="field-wrap">
                          <input
                            className="input"
                            placeholder="Email address"
                            aria-label="Email address"
                            value={signupValues.email}
                            onChange={(event) => {
                              setSignupValues((previous) => ({ ...previous, email: event.target.value }));
                              setSignupErrors((previous) => ({ ...previous, email: '' }));
                            }}
                            aria-invalid={Boolean(signupErrors.email)}
                          />
                          {signupErrors.email ? <span className="field-error">{signupErrors.email}</span> : null}
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
                              onChange={(event) => {
                                setSignupValues((previous) => ({ ...previous, specialty: event.target.value }));
                                setSignupErrors((previous) => ({ ...previous, specialty: '' }));
                              }}
                              aria-invalid={Boolean(signupErrors.specialty)}
                            />
                            {signupErrors.specialty ? <span className="field-error">{signupErrors.specialty}</span> : null}
                          </div>
                          <div className="field-wrap">
                            <input
                              className="input"
                              placeholder="License or clinic"
                              aria-label="License or clinic"
                              value={signupValues.clinic}
                              onChange={(event) => {
                                setSignupValues((previous) => ({ ...previous, clinic: event.target.value }));
                                setSignupErrors((previous) => ({ ...previous, clinic: '' }));
                              }}
                              aria-invalid={Boolean(signupErrors.clinic)}
                            />
                            {signupErrors.clinic ? <span className="field-error">{signupErrors.clinic}</span> : null}
                          </div>
                        </div>
                      ) : null}

                      <div className="field-wrap">
                        <input
                          className="input"
                          placeholder="Password"
                          type="password"
                          aria-label="Password"
                          value={signupValues.password}
                          onChange={(event) => {
                            setSignupValues((previous) => ({ ...previous, password: event.target.value }));
                            setSignupErrors((previous) => ({ ...previous, password: '' }));
                          }}
                          aria-invalid={Boolean(signupErrors.password)}
                        />
                        {signupErrors.password ? <span className="field-error">{signupErrors.password}</span> : null}
                      </div>

                      <div className="field-wrap">
                        <select
                          className="select"
                          value={signupValues.role}
                          aria-label="Select role"
                          onChange={(event) => {
                            setSignupValues((previous) => ({ ...previous, role: event.target.value }));
                            setSignupErrors((previous) => ({ ...previous, role: '' }));
                          }}
                          aria-invalid={Boolean(signupErrors.role)}
                        >
                          <option value="" disabled>
                            {authRole === 'doctor' ? 'Professional type' : 'Select your role'}
                          </option>
                          <option value="patient">Patient</option>
                          <option value="doctor">Doctor</option>
                          <option value="hospital">Hospital</option>
                        </select>
                        {signupErrors.role ? <span className="field-error">{signupErrors.role}</span> : null}
                      </div>

                      <button className="primary-button" type="submit" disabled={isAuthLoading}>
                        {isAuthLoading ? 'Creating account...' : authRole === 'doctor' ? 'Create doctor profile' : 'Create account'}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="field-wrap">
                        <input
                          className="input"
                          placeholder="Email address"
                          aria-label="Email address"
                          value={loginValues.email}
                          onChange={(event) => {
                            setLoginValues((previous) => ({ ...previous, email: event.target.value }));
                            setLoginErrors((previous) => ({ ...previous, email: '' }));
                          }}
                          aria-invalid={Boolean(loginErrors.email)}
                        />
                        {loginErrors.email ? <span className="field-error">{loginErrors.email}</span> : null}
                      </div>

                      <div className="field-wrap">
                        <input
                          className="input"
                          placeholder="Password"
                          type="password"
                          aria-label="Password"
                          value={loginValues.password}
                          onChange={(event) => {
                            setLoginValues((previous) => ({ ...previous, password: event.target.value }));
                            setLoginErrors((previous) => ({ ...previous, password: '' }));
                          }}
                          aria-invalid={Boolean(loginErrors.password)}
                        />
                        {loginErrors.password ? <span className="field-error">{loginErrors.password}</span> : null}
                      </div>

                      <button className="primary-button" type="submit" disabled={isAuthLoading}>
                        {isAuthLoading ? 'Logging in...' : 'Continue to dashboard'}
                      </button>
                    </>
                  )}
                </form>

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
                  <p>Dr. Mina Patel • Cardiology • Priority routing</p>
                  <ul className="mini-list">
                    <li>Handles your follow-up care</li>
                    <li>Prioritizes emergency calls</li>
                    <li>Supports your care history</li>
                  </ul>
                </div>

                <div className="panel">
                  <h3>Wishlist</h3>
                  <ul className="mini-list">
                    <li>Dr. Helena Flores</li>
                    <li>Dr. Omar Shah</li>
                    <li>Dr. Sarah Kim</li>
                  </ul>
                </div>

                <div className="panel">
                  <h3>Profile information</h3>
                  {profileLoading ? <p>Loading your profile...</p> : null}
                  {profileError ? <p className="field-error">{profileError}</p> : null}
                  {!profileLoading && profileData && !profileFormVisible ? (
                    <>
                      <p><strong>Username:</strong> {String(profileData.username ?? '')}</p>
                      <p><strong>Bio:</strong> {String(profileData.bio ?? 'No bio added yet.')}</p>
                      <button className="secondary-button" type="button" onClick={() => setProfileFormVisible(true)}>
                        Edit
                      </button>
                    </>
                  ) : null}
                  {!profileLoading && profileFormVisible ? (
                    <form onSubmit={saveProfile}>
                      <div className="field-wrap">
                        <input
                          className="input"
                          placeholder="Username"
                          aria-label="Username"
                          value={profileUsername}
                          onChange={(event) => setProfileUsername(event.target.value)}
                          required
                        />
                      </div>
                      <div className="field-wrap">
                        <textarea
                          className="input"
                          placeholder="Bio"
                          aria-label="Bio"
                          value={profileBio}
                          onChange={(event) => setProfileBio(event.target.value)}
                          rows={4}
                        />
                      </div>
                      <button className="primary-button" type="submit" disabled={profileSaving}>
                        {profileSaving ? 'Saving...' : profileData ? 'Update Profile' : 'Create Profile'}
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="profile-sidebar">
              <div className="panel">
                <div className="eyebrow">Emergency line</div>
                <h3>Need immediate support?</h3>
                <p>Access urgent medical support quickly from your dashboard with a single reassuring action.</p>
                <button className="primary-button" type="button" style={{ marginTop: '0.9rem' }}>
                  Call emergency line
                </button>
              </div>

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