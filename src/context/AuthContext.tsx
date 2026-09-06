import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  pending2FA: boolean;
  setPending2FA: (pending: boolean) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

type AuthProviderProps = {
  children: ReactNode;
};

const PENDING_2FA_KEY = 'caremunicate:pending2fa';

// Session Trap gate: while 2FA is pending, the global auth state reports no
// user/session even if a transient token exists in storage. The user only
// becomes "logged in" once the 2FA step completes and the real persistent
// session is installed.
export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [pending2FA, setPending2FAState] = useState(() => sessionStorage.getItem(PENDING_2FA_KEY) === 'true');
  const [loading, setLoading] = useState(true);

  const setPending2FA = (pending: boolean) => {
    setPending2FAState(pending);

    if (pending) {
      sessionStorage.setItem(PENDING_2FA_KEY, 'true');
    } else {
      sessionStorage.removeItem(PENDING_2FA_KEY);
    }
  };

  useEffect(() => {
    let mounted = true;

    const restoreSession = async () => {
      const { data, error } = await supabase.auth.getSession();

      if (!mounted) return;

      if (!error) {
        setSession(data.session);
      }

      setLoading(false);
    };

    void restoreSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;

      // If the user completed 2FA (real persistent session installed), clear
      // the pending flag so the gated state below reports them as logged in.
      if (event === 'SIGNED_IN' || event === 'MFA_CHALLENGE_VERIFIED' || event === 'TOKEN_REFRESHED') {
        if (nextSession) {
          setPending2FAState(false);
          sessionStorage.removeItem(PENDING_2FA_KEY);
        }
      }

      if (event === 'SIGNED_OUT') {
        setPending2FAState(false);
        sessionStorage.removeItem(PENDING_2FA_KEY);
      }

      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    setPending2FA(false);
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  // The Session Trap gate itself: while 2FA is pending the app must not treat
  // the user as authenticated, no matter what tokens exist in storage.
  const effectiveSession = pending2FA ? null : session;

  const value: AuthContextValue = {
    session: effectiveSession,
    user: effectiveSession?.user ?? null,
    loading,
    pending2FA,
    setPending2FA,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }

  return context;
}
