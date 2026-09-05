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

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [pending2FA, setPending2FAState] = useState(() => sessionStorage.getItem('caremunicate:pending2fa') === 'true');
  const [loading, setLoading] = useState(true);

  const setPending2FA = (pending: boolean) => {
    setPending2FAState(pending);

    if (pending) {
      sessionStorage.setItem('caremunicate:pending2fa', 'true');
    } else {
      sessionStorage.removeItem('caremunicate:pending2fa');
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

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
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

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
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
