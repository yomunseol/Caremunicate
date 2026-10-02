import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabase';
import { isProvider } from '../lib/roles';

// ---------------------------------------------------------------------------
// The single source of truth for the local user's role.
//
// profiles.role is the durable value; user_metadata.role can be stale (a
// confirmed-by-email signup writes the role to metadata only). While the profile
// row loads we fall back to metadata so nothing blocks, then profiles.role wins
// — so no two surfaces can disagree about what role the user has.
// ---------------------------------------------------------------------------

type RoleValue = {
  role: string;
  /** doctor | department | hospital. */
  provider: boolean;
  isAdmin: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
};

const RoleContext = createContext<RoleValue | undefined>(undefined);

export function RoleProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const metadataRole = String(user?.user_metadata?.role ?? '').toLowerCase();

  const [role, setRole] = useState(metadataRole);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user?.id) {
      setRole('');
      setIsAdmin(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('role, is_admin')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) console.error('ROLE ERROR:', error.message);

    const row = data as { role?: string; is_admin?: boolean } | null;
    setRole(String(row?.role ?? metadataRole ?? '').toLowerCase());
    setIsAdmin(Boolean(row?.is_admin));
    setLoading(false);
  }, [user?.id, metadataRole]);

  useEffect(() => {
    void load();
  }, [load]);

  const value: RoleValue = {
    role,
    provider: isProvider(role),
    isAdmin,
    loading,
    refresh: load,
  };

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleValue {
  const context = useContext(RoleContext);
  if (!context) {
    throw new Error('useRole must be used inside a RoleProvider');
  }
  return context;
}
