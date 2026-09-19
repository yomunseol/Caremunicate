import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import ProtectedRoute from './components/ProtectedRoute';
import TwoFactorSetup from './components/TwoFactorSetup';
import PasswordAuth from './components/PasswordAuth';
import ChatWindow from './components/ChatWindow';
import ErrorBoundary from './components/ErrorBoundary';
import FloatingChatWidget from './components/FloatingChatWidget';
import CarePlaces from './components/CarePlaces';
import DashboardOverview from './components/DashboardOverview';
import CallPage from './components/CallPage';
import CallHub from './components/CallHub';
import RejoinBanner from './components/RejoinBanner';
import CalendarPage from './components/CalendarPage';
import VerificationCenter from './components/VerificationCenter';
import LanguageSwitcher from './components/LanguageSwitcher';
import PricingSection, {
  defaultPlanForFamily,
  getPlans,
  isPlanId,
  isProviderPlan,
  normalizePlanId,
  planFamilyOf,
  planForRole,
  type Plan,
  type PlanFamily,
  type PlanId,
} from './components/PricingSection';
import { useAuth } from './context/AuthContext';
import { isProvider, roleLabelKey } from './lib/roles';
import { useLang } from './i18n';

type RouteKey =
  | 'home'
  | 'signup'
  | 'login'
  | 'profile'
  | 'pricing'
  | 'chat'
  | 'call'
  | 'calendar'
  | 'verify';
type AuthMode = 'signup' | 'login';
type AuthRole = 'patient' | 'doctor' | 'department' | 'hospital';

// Feature cards are keyed so every visible string resolves through i18n.
const FEATURE_CARDS = [
  { title: 'home.f1.title', description: 'home.f1.desc', accent: 'home.f1.accent' },
  { title: 'home.f2.title', description: 'home.f2.desc', accent: 'home.f2.accent' },
  { title: 'home.f3.title', description: 'home.f3.desc', accent: 'home.f3.accent' },
  { title: 'home.f4.title', description: 'home.f4.desc', accent: 'home.f4.accent' },
  { title: 'home.f5.title', description: 'home.f5.desc', accent: 'home.f5.accent' },
  { title: 'home.f6.title', description: 'home.f6.desc', accent: 'home.f6.accent' },
];

type ParsedRoute = {
  route: RouteKey;
  conversationId: string | null;
  callCode: string | null;
  plan: string | null;
  /** Role the sign-up form should preselect (#signup?role=doctor|department|hospital). */
  role: string | null;
};

const AUTH_ROLES: AuthRole[] = ['patient', 'doctor', 'department', 'hospital'];

/** A role from the URL, or null when it is missing/unknown. */
const asAuthRole = (value: string | null): AuthRole | null =>
  value && (AUTH_ROLES as string[]).includes(value) ? (value as AuthRole) : null;

// Hash formats supported:
//   #home, #signup, #login, #profile, #pricing   (existing routes)
//   #signup?plan=care-plus                       (plan preselected from pricing)
//   #/chat/<conversationId>  (chat, set by the chat list and dashboard)
//   #call/<code> or #/call/<code>  (call room; a leading slash is stripped by clean)
const parseHash = (hash: string): ParsedRoute => {
  const clean = hash.replace(/^#\/?/, '');
  const [rawName, ...rest] = clean.split('/');
  const [name, query = ''] = rawName.split('?');
  const params = new URLSearchParams(query);

  if (name === 'chat') {
    const id = rest.join('/');
    return id
      ? { route: 'chat', conversationId: id, callCode: null, plan: null, role: null }
      : { route: 'home', conversationId: null, callCode: null, plan: null, role: null };
  }

  if (name === 'call') {
    // #call (no code) is the hub; #call/<words> is that one room.
    return {
      route: 'call',
      conversationId: null,
      callCode: rest.join('/') || null,
      plan: null,
      role: null,
    };
  }

  const validRoutes: RouteKey[] = ['home', 'signup', 'login', 'profile', 'pricing', 'calendar', 'verify'];
  return {
    route: validRoutes.includes(name as RouteKey) ? (name as RouteKey) : 'home',
    conversationId: null,
    callCode: null,
    plan: params.get('plan'),
    role: params.get('role'),
  };
};

/** `/call/<words>` — the path-style invite link. Codes are always words. */
const CALL_PATH = /^\/call\/([^/]+)\/?$/;
/** `/call` with no code — the hub. */
const CALL_HUB_PATH = /^\/call\/?$/;

const isCallHubPath = (): boolean =>
  typeof window !== 'undefined' && CALL_HUB_PATH.test(window.location.pathname);

const pathCallCode = (): string | null => {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(CALL_PATH);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const getInitialRoute = (): RouteKey => {
  if (typeof window === 'undefined') return 'home';
  if (pathCallCode() || isCallHubPath()) return 'call';
  return parseHash(window.location.hash).route;
};

/**
 * The path the router should build URLs on. A path-style call link leaves
 * `/call/<words>` as the pathname, which must NOT become the base for later
 * in-app navigation — otherwise going "home" would stay on the call URL.
 */
const routerBasePath = (): string => {
  if (typeof window === 'undefined') return '/';
  return /^\/call(\/|$)/.test(window.location.pathname) ? '/' : window.location.pathname;
};

const getInitialConversationId = (): string | null =>
  typeof window === 'undefined' ? null : parseHash(window.location.hash).conversationId;

const getInitialCallCode = (): string | null => {
  if (typeof window === 'undefined') return null;
  return pathCallCode() ?? parseHash(window.location.hash).callCode;
};

const getInitialPlan = (): PlanId | null => {
  if (typeof window === 'undefined') return null;
  const { plan } = parseHash(window.location.hash);
  return isPlanId(plan) ? plan : null;
};

type SignupFormValues = {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
  specialty: string;
  clinic: string;
  departmentName: string;
  parentHospital: string;
  hospitalName: string;
  addressRegion: string;
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
  const { t, tString } = useLang();
  const [route, setRoute] = useState<RouteKey>(getInitialRoute);
  const [conversationId, setConversationId] = useState<string | null>(getInitialConversationId);
  const [callCode, setCallCode] = useState<string | null>(getInitialCallCode);
  const [authMode, setAuthMode] = useState<AuthMode>('signup');
  const [authRole, setAuthRole] = useState<AuthRole>('patient');
  const [signupValues, setSignupValues] = useState<SignupFormValues>({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    specialty: '',
    clinic: '',
    departmentName: '',
    parentHospital: '',
    hospitalName: '',
    addressRegion: '',
    // Role comes from the tile grid; Patient is the default.
    role: 'patient',
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
  // Plan chosen on the pricing page. Persisted in the URL as
  // #signup?plan=<id> so it survives a refresh on the sign-up screen.
  const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(getInitialPlan);
  // The plan currently being written to the DB (drives the button's loading state).
  const [pendingPlan, setPendingPlan] = useState<PlanId | null>(null);
  // A plan change that also changes the ROLE, awaiting confirmation.
  const [conversion, setConversion] = useState<{ plan: PlanId; option: Plan } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  // Bumped after a successful plan write to re-read profiles without a reload.
  const [profileRefreshKey, setProfileRefreshKey] = useState(0);

  useEffect(() => {
    const syncRoute = () => {
      const parsed = parseHash(window.location.hash);
      setRoute(parsed.route);
      setConversationId(parsed.conversationId);
      setCallCode(parsed.callCode);
      setAuthMode(parsed.route === 'login' ? 'login' : 'signup');
      // Only overwrite the selection when the URL actually carries a valid
      // plan (deep link / browser back into #signup?plan=...). A plain #signup
      // keeps the plan the visitor already picked.
      if (isPlanId(parsed.plan)) {
        setSelectedPlan(parsed.plan);
      }
      // #signup?role=doctor|department|hospital preselects the role tile.
      const role = asAuthRole(parsed.role);
      if (role) {
        setAuthRole(role);
        setSignupValues((previous) => ({ ...previous, role }));
      }
    };

    syncRoute();
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

      // `.maybeSingle()` because a user may legitimately have no profiles row
      // yet — that is a normal state, not an error.
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', currentUser.id)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        console.error('Could not load profile:', error.message);
        setProfileData(null);
      } else {
        setProfileData(data);
      }
    };

    void fetchProfile();

    return () => {
      cancelled = true;
    };
  }, [currentUser, profileRefreshKey]);

  // Auto-dismiss the plan toast so it never lingers over the page.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const navigate = (nextRoute: RouteKey) => {
    if (
      (nextRoute === 'profile' ||
        nextRoute === 'chat' ||
        nextRoute === 'call' ||
        nextRoute === 'calendar' ||
        nextRoute === 'verify') &&
      (!currentUser || pending2FA)
    ) {
      nextRoute = 'login';
    }
    if (nextRoute === 'login' || nextRoute === 'signup') {
      setAuthMode(nextRoute);
    }
    setRoute(nextRoute);
    setConversationId(null);
    setCallCode(null);
    const hash = nextRoute === 'home' ? '' : `#${nextRoute}`;
    window.history.pushState({}, '', `${routerBasePath()}${hash}`);
  };

  const openAuth = (mode: AuthMode, role: AuthRole = 'patient') => {
    setAuthMode(mode);
    setAuthRole(role);
    setSignupValues((previous) => ({ ...previous, role }));
    setRoute(mode === 'login' ? 'login' : 'signup');
    setSignupErrors({});
    setTouchedFields({});
    setAuthMessage('');
    const hash = mode === 'signup' && selectedPlan ? `#signup?plan=${selectedPlan}` : mode === 'login' ? '#login' : '#signup';
    window.history.pushState({}, '', `${window.location.pathname}${hash}`);
  };

  const getEmailError = (value: string) => {
    if (!value.trim()) return t('auth.err.emailRequired');
    if (!emailPattern.test(value.trim())) return t('auth.err.emailInvalid');
    return '';
  };

  const getFullNameError = (value: string) => {
    if (!value.trim()) return t('auth.err.fullName');
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
    if (!value) return t('auth.err.passwordRequired');
    if (!passwordPattern.test(value)) {
      return t('auth.err.passwordRules');
    }
    return '';
  };

  const getConfirmPasswordError = (value: string) => {
    if (!value) return t('auth.err.confirmRequired');
    if (value !== signupValues.password) return t('auth.err.passwordMismatch');
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
      nextErrors.specialty = t('auth.err.specialty');
    }

    if (authRole === 'doctor' && !signupValues.clinic.trim()) {
      nextErrors.clinic = t('auth.err.clinic');
    }

    if (authRole === 'department' && !signupValues.departmentName.trim()) {
      nextErrors.departmentName = t('signup.required');
    }

    // Parent hospital is optional.

    if (authRole === 'hospital' && !signupValues.hospitalName.trim()) {
      nextErrors.hospitalName = t('signup.required');
    }

    if (authRole === 'hospital' && !signupValues.addressRegion.trim()) {
      nextErrors.addressRegion = t('signup.required');
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
      nextErrors.role = t('auth.err.role');
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
    (authRole !== 'department' || Boolean(signupValues.departmentName.trim())) &&
    (authRole !== 'hospital' || Boolean(signupValues.hospitalName.trim())) &&
    (authRole !== 'hospital' || Boolean(signupValues.addressRegion.trim())) &&
    !getPasswordError(signupValues.password) &&
    !getConfirmPasswordError(signupValues.confirmPassword);

  // Real-time checklist shown under the password field. Empty password shows
  // only neutral (unmet) rows.
  const passwordChecklist = [
    { label: t('auth.ruleLength'), met: passwordChecks.minLength(signupValues.password) },
    { label: t('auth.ruleUpper'), met: passwordChecks.hasUpper(signupValues.password) },
    { label: t('auth.ruleLower'), met: passwordChecks.hasLower(signupValues.password) },
    { label: t('auth.ruleNumber'), met: passwordChecks.hasNumber(signupValues.password) },
    { label: t('auth.ruleSpecial'), met: passwordChecks.hasSpecial(signupValues.password) },
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

    // Plan mirrors the role for providers; patients land on basic (or the
    // patient tier they picked on the pricing page).
    const signupPlan: PlanId = isProvider(authRole)
      ? planForRole(authRole)
      : selectedPlan && !isProviderPlan(selectedPlan)
        ? selectedPlan
        : 'basic';

    try {
      const { data, error } = await supabase.auth.signUp({
        email: signupValues.email.trim(),
        password: signupValues.password,
        options: {
          data: {
            fullName: signupValues.fullName.trim(),
            role: authRole,
            ...(authRole === 'doctor' ? {
              specialty: signupValues.specialty.trim(),
              clinic: signupValues.clinic.trim(),
            } : {}),
            ...(authRole === 'department' ? {
              departmentName: signupValues.departmentName.trim(),
              parentHospital: signupValues.parentHospital.trim(),
            } : {}),
            ...(authRole === 'hospital' ? {
              hospitalName: signupValues.hospitalName.trim(),
              addressRegion: signupValues.addressRegion.trim(),
            } : {}),
            plan: signupPlan,
          },
        },
      });

      if (error) throw error;

      if (!data.session) {
        // No session yet (email confirmation pending) so nothing can be written
        // under RLS; the role travels in the sign-up metadata until then.
        setAuthMessageType('success');
        setAuthMessage(t('auth.msg.createdConfirm'));
        return;
      }

      // Persist the selected role onto profiles now that we have a session.
      if (data.user) {
        const { error: profileError } = await supabase
          .from('profiles')
          .upsert(
            {
              user_id: data.user.id,
              role: authRole,
              plan: signupPlan,
              username: signupValues.fullName.trim(),
            },
            { onConflict: 'user_id' },
          );

        console.log('Sign-up profile write:', { role: authRole, error: profileError });
        if (profileError) console.error('SIGNUP PROFILE ERROR:', profileError);
      }

      setAuthMessageType('success');
      setAuthMessage(t('auth.msg.ready'));
      navigate('profile');
    } catch (error) {
      setAuthMessageType('error');
      setAuthMessage(error instanceof Error ? error.message : t('auth.msg.errorGeneric'));
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

  // Keeps the tile selection and the form value in lockstep.
  const selectRole = (next: AuthRole) => {
    setAuthRole(next);
    setSignupValues((previous) => ({ ...previous, role: next }));
    setSignupErrors((previous) => ({ ...previous, role: '' }));
  };

  // One inline renderer for the role-specific inputs, so doctor/department/
  // hospital fields share validation + error handling.
  const renderSignupField = (field: keyof SignupFormValues, labelKey: string, required = true) => (
    <div className="field-wrap">
      <input
        className="input"
        placeholder={t(labelKey)}
        aria-label={t(labelKey)}
        value={signupValues[field]}
        onBlur={() => setTouchedFields((previous) => ({ ...previous, [field]: true }))}
        onChange={(event) => {
          const { value } = event.target;
          setSignupValues((previous) => ({ ...previous, [field]: value }));
          if (signupErrors[field]) {
            setSignupErrors((previous) => ({ ...previous, [field]: '' }));
          }
        }}
        aria-invalid={showFieldError(field)}
        required={required}
      />
      {showFieldError(field) ? <span className="field-error">{signupErrors[field]}</span> : null}
    </div>
  );

  const profileDisplayName = String(profileData?.username ?? userProfile?.fullName ?? currentUser?.email ?? '');

  // Dashboard role. Prefer the persisted profiles.role, falling back to the
  // sign-up metadata.
  const profileRole = String(profileData?.role ?? userProfile?.role ?? '').toLowerCase();

  // Which plan family this role may display. Provider roles (doctor/department/
  // hospital) are the provider family; everyone else is the patient family.
  const roleFamily: PlanFamily = isProvider(profileRole) ? 'provider' : 'patient';

  // profiles.plan, read LIVE from the DB row — never cached in the session and
  // never inferred from the role. An unknown or wrong-family value falls back
  // to this family's default, and the disagreement is reported with both values.
  const storedPlan = typeof profileData?.plan === 'string' ? profileData.plan : null;
  const dbPlanId = normalizePlanId(storedPlan);
  const dbPlanFamily = dbPlanId ? planFamilyOf(dbPlanId) : null;
  const planMatchesRole = dbPlanId !== null && dbPlanFamily === roleFamily;

  if (storedPlan !== null && !planMatchesRole) {
    console.error(
      'PLAN MISMATCH: profiles.plan =',
      storedPlan,
      '| badge family =',
      dbPlanFamily ?? 'unknown',
      '| role family =',
      roleFamily,
      '| rendering =',
      defaultPlanForFamily(roleFamily),
    );
  }

  const currentPlanId: PlanId =
    dbPlanId !== null && dbPlanFamily === roleFamily ? dbPlanId : defaultPlanForFamily(roleFamily);
  const planOptions = getPlans(t);
  const currentPlanOption = planOptions.find((item) => item.id === currentPlanId) ?? planOptions[0];
  const selectedPlanOption = selectedPlan ? planOptions.find((item) => item.id === selectedPlan) ?? null : null;

  // Pricing CTAs.
  //  - Logged out: go to sign-up with the role tile (and the plan) preselected.
  //  - Logged in:  write ONLY through the set_own_plan RPC, then re-read the
  //                profile so the badge updates with no reload.
  //  - A plan whose role differs from the account's is an account conversion:
  //                role and plan change together, so confirm first.
  const applyPlan = async (plan: PlanId, option: Plan) => {
    setPendingPlan(plan);
    try {
      const { error } = await supabase.rpc('set_own_plan', { plan });

      console.log('set_own_plan result:', { plan, error });
      if (error) throw error;

      // Re-read profiles.plan — the badge is driven by that row.
      setProfileRefreshKey((key) => key + 1);
      setToast({ message: tString('auth.toast.planActivated', { name: option.name }), type: 'success' });
    } catch (error) {
      console.error('Plan update failed:', error);
      setToast({
        message: error instanceof Error ? error.message : t('auth.toast.planError'),
        type: 'error',
      });
    } finally {
      setPendingPlan(null);
    }
  };

  const selectPlan = (plan: PlanId) => {
    console.log('Plan selected:', plan);

    const option = planOptions.find((item) => item.id === plan);
    if (!option) return;

    if (!currentUser) {
      // Preselect both pieces: the plan and the role tile it belongs to.
      setSelectedPlan(plan);
      setAuthRole(option.signupRole);
      setSignupValues((previous) => ({ ...previous, role: option.signupRole }));
      setAuthMode('signup');
      setRoute('signup');
      setConversationId(null);
      setSignupErrors({});
      setTouchedFields({});
      setAuthMessage('');
      setProfileMenuOpen(false);
      window.history.pushState(
        {},
        '',
        `${window.location.pathname}#signup?plan=${plan}&role=${option.signupRole}`,
      );
      return;
    }

    const currentRoleKey = isProvider(profileRole) ? profileRole : 'patient';
    if (option.signupRole !== currentRoleKey) {
      setConversion({ plan, option });
      return;
    }

    void applyPlan(plan, option);
  };

  // Feature cards, translated for the active locale.
  const featureCards = FEATURE_CARDS.map((card) => ({
    title: t(card.title),
    description: t(card.description),
    accent: t(card.accent),
  }));

  // "What you unlock" list varies by mode and role.
  const authBenefitKeys =
    authMode === 'signup'
      ? isProvider(authRole)
        ? ['auth.doctorBenefit1', 'auth.doctorBenefit2', 'auth.doctorBenefit3']
        : ['auth.patientBenefit1', 'auth.patientBenefit2', 'auth.patientBenefit3']
      : ['auth.loginBenefit1', 'auth.loginBenefit2', 'auth.loginBenefit3'];

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
          <img src="/Caremunicate.png" alt={t('home.brandLogoAlt')} className="brand-logo" />
          <span>{t('common.appName')}</span>
        </button>

        <div className="nav-actions">
          <LanguageSwitcher />

          {currentUser ? (
            <>
              <button className="ghost-button" type="button" onClick={() => navigate('call')}>
                {t('call.callHub')}
              </button>
              <button className="ghost-button" type="button" onClick={() => navigate('calendar')}>
                {t('cal.calendar')}
              </button>
              <div className="profile-menu">
                <button
                  className="profile-trigger"
                  type="button"
                  aria-expanded={profileMenuOpen}
                  aria-haspopup="true"
                  onClick={() => setProfileMenuOpen((open) => !open)}
                >
                  <span className="profile-avatar" aria-hidden="true">{profileDisplayName.charAt(0).toUpperCase()}</span>
                  <span className="profile-trigger-copy">
                    <strong>{profileDisplayName}</strong>
                    <small>{currentPlanOption.name} {t('common.plan')}</small>
                  </span>
                  <span className="profile-chevron" aria-hidden="true">{profileMenuOpen ? '▲' : '▼'}</span>
                </button>

                {profileMenuOpen ? (
                  <div className="profile-popover" role="dialog" aria-label={t('header.profileMenu')}>
                    <div className="profile-popover-header">
                      <div>
                        <span className="profile-kicker">{t('header.account')}</span>
                        <h3>{profileDisplayName}</h3>
                        <p><bdi dir="ltr">{currentUser.email}</bdi></p>
                      </div>
                      <span className="plan-status">{currentPlanOption.name}</span>
                    </div>

                    <div className="plan-summary">
                      <div className="plan-summary-heading">
                        <span>{t('header.currentPlan')}</span>
                        <strong>{currentPlanOption.name} {t('common.plan')}</strong>
                      </div>
                      <p>{currentPlanOption.subtitle}</p>
                      <div className="plan-meter" aria-hidden="true"><span /></div>
                    </div>

                    <button
                      className="upgrade-button"
                      type="button"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        navigate('pricing');
                      }}
                    >
                      <span>{t('header.upgrade')}</span>
                      <span aria-hidden="true">→</span>
                    </button>

                    <button className="popover-profile-link" type="button" onClick={() => {
                      setProfileMenuOpen(false);
                      navigate('profile');
                    }}>
                      {t('header.viewProfile')}
                    </button>
                  </div>
                ) : null}
              </div>
              <button className="primary-button" type="button" onClick={handleLogout}>
                {t('common.logOut')}
              </button>
            </>
          ) : (
            <>
              <button className="ghost-button" type="button" onClick={() => navigate('login')}>
                {t('common.logIn')}
              </button>
              <button className="primary-button" type="button" onClick={() => navigate('signup')}>
                {t('common.signUp')}
              </button>
            </>
          )}
        </div>
      </header>

      {/* Offers to drop back into the room this tab was last in. */}
      <RejoinBanner />

      <main className="main-content">
        {route === 'home' && (
          <>
            <section className="section hero-section">
              <div className="hero-card">
                <div className="eyebrow">{t('home.heroEyebrow')}</div>
                <h1 className="hero-title">
                  {t('home.heroTitle')}
                </h1>
                <p className="hero-copy">
                  {t('home.heroCopy')}
                </p>

                <div className="pill-row" style={{ marginBottom: '1.5rem' }}>
                  <span className="pill">{t('home.heroPill1')}</span>
                  <span className="pill">{t('home.heroPill2')}</span>
                  <span className="pill">{t('home.heroPill3')}</span>
                </div>

                <div className="cta-row">
                  <button className="primary-button" type="button" onClick={() => navigate('signup')}>
                    {t('common.createAccount')}
                  </button>
                  <button className="secondary-button" type="button" onClick={() => navigate('pricing')}>
                    {t('common.viewPricing')}
                  </button>
                </div>
              </div>

              <div className="hero-visual">
                <img src="/Caremunicate_carousel_photo.jpg" alt={t('home.heroImageAlt')} />
              </div>
            </section>

            <section className="section">
              <div className="section-heading">
                <div className="eyebrow">{t('home.featuresEyebrow')}</div>
                <h2>{t('home.featuresTitle')}</h2>
                <p>
                  {t('home.featuresCopy')}
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
                <img src="/Caremunicate_Paragraph_photo.jpg" alt={t('home.careImageAlt')} className="care-image" />
                <div className="care-content">
                  <div className="eyebrow">{t('home.careEyebrow')}</div>
                  <h2>{t('home.careTitle')}</h2>
                  <p className="hero-copy">
                    {t('home.careCopy')}
                  </p>
                  <div className="stack-list">
                    <div className="stack-item">
                      <strong>{t('home.careEmergencyTitle')}</strong>
                      <span>{t('home.careEmergencyDesc')}</span>
                    </div>
                    <div className="stack-item">
                      <strong>{t('home.careHospitalTitle')}</strong>
                      <span>{t('home.careHospitalDesc')}</span>
                    </div>
                    <div className="stack-item">
                      <strong>{t('home.careAssignedTitle')}</strong>
                      <span>{t('home.careAssignedDesc')}</span>
                    </div>
                  </div>
                  <div className="pill-row" style={{ marginTop: '1.2rem' }}>
                    <span className="pill">{t('home.carePill1')}</span>
                    <span className="pill">{t('home.carePill2')}</span>
                    <span className="pill">{t('home.carePill3')}</span>
                  </div>
                </div>
              </div>
            </section>

            <PricingSection
              heading={t('pricing.homeHeading')}
              subheading={t('pricing.homeSubheading')}
              onSelectPlan={(plan) => void selectPlan(plan)}
              currentPlan={currentUser ? currentPlanId : null}
              busyPlan={pendingPlan}
            />

            <section className="section">
              <div className="cta-banner">
                <div className="cta-banner-copy">
                  <div className="eyebrow">{t('home.ctaEyebrow')}</div>
                  <h2>{t('home.ctaTitle')}</h2>
                </div>

                <div className="cta-row">
                  <button className="primary-button" type="button" onClick={() => openAuth('signup')}>
                    {t('common.createAccount')}
                  </button>
                  <button className="secondary-button" type="button" onClick={() => openAuth('signup', 'doctor')}>
                    {t('home.imADoctor')}
                  </button>
                </div>
              </div>
            </section>
          </>
        )}

        {(route === 'signup' || route === 'login') && (
          <section className="section form-grid auth-combined-layout">
            <div className="auth-side auth-visual-panel">
              <img src="/HealthcareTeamCollab.jpg" alt={t('home.authImageAlt')} />
            </div>

            <div className="auth-card auth-panel-shell">
              <div className="auth-mode-toggle" aria-label={t('auth.modeAria')}>
                <button
                  type="button"
                  className={authMode === 'signup' ? 'mode-button active' : 'mode-button'}
                  onClick={() => openAuth('signup', authRole)}
                >
                  {t('common.signUp')}
                </button>
                <button
                  type="button"
                  className={authMode === 'login' ? 'mode-button active' : 'mode-button'}
                  onClick={() => openAuth('login', authRole)}
                >
                  {t('common.logIn')}
                </button>
              </div>

              <div className="auth-form-shell" key={authMode}>
                <div className="eyebrow">{authMode === 'signup' ? t('auth.signupEyebrow') : t('auth.loginEyebrow')}</div>
                <h2>
                  {authMode === 'signup'
                    ? isProvider(authRole)
                      ? t('auth.titleDoctorSignup')
                      : t('auth.titleSignup')
                    : t('auth.titleLogin')}
                </h2>
                <p className="auth-copy">
                  {authMode === 'signup'
                    ? isProvider(authRole)
                      ? t('auth.copyDoctorSignup')
                      : t('auth.copySignup')
                    : t('auth.copyLogin')}
                </p>

                {authMode === 'signup' ? (
                  <>
                    {selectedPlanOption ? (
                      <div className="plan-selected-banner">
                        <div>
                          <span className="plan-selected-label">{t('auth.selectedPlan')}</span>
                          <strong>{selectedPlanOption.name}</strong>
                          <small>
                            {selectedPlanOption.price}
                            {selectedPlanOption.cadence} {t('auth.canChange')}
                          </small>
                        </div>
                        <button type="button" onClick={() => navigate('pricing')}>
                          {t('common.change')}
                        </button>
                      </div>
                    ) : null}

                  <form onSubmit={handleSubmit} noValidate>
                    {authMessage ? <p className={authMessageType === 'success' ? 'auth-success' : 'field-error'}>{authMessage}</p> : null}
                    <>
                      <div className="form-row">
                        <div className="field-wrap">
                          <input
                            className="input"
                            placeholder={t('auth.fullName')}
                            aria-label={t('auth.fullName')}
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
                            placeholder={t('auth.email')}
                            type="email"
                            aria-label={t('auth.email')}
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
                          {renderSignupField('specialty', 'auth.specialty')}
                          {renderSignupField('clinic', 'auth.clinic')}
                        </div>
                      ) : null}

                      {authRole === 'department' ? (
                        <div className="form-row">
                          {renderSignupField('departmentName', 'signup.departmentName')}
                          {renderSignupField('parentHospital', 'signup.hospitalOptional', false)}
                        </div>
                      ) : null}

                      {authRole === 'hospital' ? (
                        <div className="form-row">
                          {renderSignupField('hospitalName', 'signup.hospitalName')}
                          {renderSignupField('addressRegion', 'signup.addressRegion')}
                        </div>
                      ) : null}

                      <div className="field-wrap">
                        <input
                          className="input"
                          placeholder={t('auth.password')}
                          type="password"
                          aria-label={t('auth.password')}
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
                          <ul className="password-checklist" aria-label={t('auth.reqAria')}>
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
                          placeholder={t('auth.confirmPassword')}
                          type="password"
                          aria-label={t('auth.confirmPassword')}
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

                      {/* Role picker: 2x2 tiles, Patient preselected. */}
                      <div className="role-tiles" role="radiogroup" aria-label={t('auth.roleAria')}>
                        {(
                          [
                            { value: 'patient', icon: '🧑', labelKey: 'roles.patient' },
                            { value: 'doctor', icon: '🩺', labelKey: 'roles.doctor' },
                            { value: 'department', icon: '🏢', labelKey: 'roles.department' },
                            { value: 'hospital', icon: '🏥', labelKey: 'roles.hospital' },
                          ] as const
                        ).map((tile) => {
                          const active = authRole === tile.value;
                          return (
                            <button
                              key={tile.value}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              className={active ? 'role-tile active' : 'role-tile'}
                              onClick={() => selectRole(tile.value)}
                            >
                              <span className="role-tile-icon" aria-hidden="true">{tile.icon}</span>
                              {t(tile.labelKey)}
                            </button>
                          );
                        })}
                      </div>

                      <button className="primary-button" type="submit" disabled={isAuthLoading || !signupIsValid}>
                        {isAuthLoading ? t('auth.creating') : authRole === 'doctor' ? t('auth.createDoctor') : t('common.createAccount')}
                      </button>
                    </>
                  </form>
                  </>
                ) : (
                  <PasswordAuth onAuthenticated={() => navigate('profile')} />
                )}

                <div className="auth-benefits">
                  <div className="eyebrow">{authMode === 'signup' ? t('auth.benefitsSignup') : t('auth.benefitsLogin')}</div>
                  <ul className="thin-list">
                    {authBenefitKeys.map((key) => (
                      <li key={key}>{t(key)}</li>
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
            <DashboardOverview role={profileRole} planName={currentPlanOption?.name ?? ''} />

            <div className="profile-sidebar">
              <TwoFactorSetup />

              <div className="panel">
                <div className="eyebrow">{t('profile.updatesEyebrow')}</div>
                <h3>{t('profile.updatesTitle')}</h3>
                <p>{t('profile.updatesCopy')}</p>
              </div>

              <CarePlaces role={profileRole} />
            </div>
            </section>
          </ProtectedRoute>
        )}

        {route === 'chat' && (
          <ProtectedRoute>
            <section className="section">
              <ErrorBoundary key={conversationId ?? 'chat'}>
                {conversationId ? (
                  <ChatWindow conversationId={conversationId} />
                ) : (
                  <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
                    <p>{t('profile.chatInvalidLink')}</p>
                    <a href="#profile" style={{ color: 'var(--accent-strong, #2d7a5f)' }}>
                      ← {t('chat.backAria')}
                    </a>
                  </div>
                )}
              </ErrorBoundary>
            </section>
          </ProtectedRoute>
        )}

        {route === 'calendar' && (
          <ProtectedRoute>
            <CalendarPage />
          </ProtectedRoute>
        )}

        {route === 'verify' && (
          <ProtectedRoute>
            <VerificationCenter />
          </ProtectedRoute>
        )}

        {/* One hub at /call; /call/<words> is that single room's guard. */}
        {route === 'call' && (
          <ProtectedRoute>
            {callCode ? <CallPage code={callCode} /> : <CallHub />}
          </ProtectedRoute>
        )}

        {route === 'pricing' && (
          <PricingSection
            heading={t('pricing.pageHeading')}
            subheading={t('pricing.pageSubheading')}
            onSelectPlan={(plan) => void selectPlan(plan)}
            currentPlan={currentUser ? currentPlanId : null}
            busyPlan={pendingPlan}
          />
        )}
      </main>

      {/* Account conversion: role and plan change together, so confirm first. */}
      {conversion ? (
        <div className="cal-modal-backdrop" role="presentation" onClick={() => setConversion(null)}>
          <div
            className="cal-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('plans.convertTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="cal-modal-title">{t('plans.convertTitle')}</h3>
            <p className="cal-muted">
              {tString('plans.convertBody', {
                role: t(roleLabelKey(conversion.option.signupRole)),
                plan: conversion.option.name,
              })}
            </p>
            <div className="cal-modal-footer">
              <button type="button" className="ghost-button" onClick={() => setConversion(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={pendingPlan !== null}
                aria-busy={pendingPlan === conversion.plan}
                onClick={() => {
                  const target = conversion;
                  setConversion(null);
                  void applyPlan(target.plan, target.option);
                }}
              >
                {t('plans.confirmCta')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className={`plan-toast ${toast.type === 'error' ? 'is-error' : ''}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}

      <FloatingChatWidget />

      <footer className="footer">
        <p>{t('footer.tagline')}</p>
      </footer>
    </div>
  );
}

export default App;
