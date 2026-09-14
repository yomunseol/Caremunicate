import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabase';
import { useCall, type CallIdentity, type UseCallResult } from '../hooks/useCall';
import CallLayer from '../components/CallLayer';

// ---------------------------------------------------------------------------
// One call session for the whole app. This provider is the single owner of call
// state: any component may start/join a call, but CallLayer is the only thing
// that renders call UI, and it does so exactly once, above everything else.
//
// It also resolves the local identity (profiles.role + verification_status) so
// our own tile can carry a role badge and the certified badge, and so that
// identity can be broadcast to peers.
// ---------------------------------------------------------------------------

const CallContext = createContext<UseCallResult | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const displayName = String(user?.user_metadata?.fullName ?? user?.email ?? '');
  const [identity, setIdentity] = useState<CallIdentity>({});

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!user?.id) {
        setIdentity({});
        return;
      }

      const { data } = await supabase
        .from('profiles')
        .select('role, verification_status')
        .eq('user_id', user.id)
        .maybeSingle();

      if (cancelled) return;

      const row = data as { role?: string; verification_status?: string } | null;
      setIdentity({
        role: String(row?.role ?? user.user_metadata?.role ?? ''),
        // Only a literal 'verified' status lights the badge.
        verified: row?.verification_status === 'verified',
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.user_metadata?.role]);

  const call = useCall(user?.id, displayName, identity);

  return (
    <CallContext.Provider value={call}>
      {children}
      <CallLayer />
    </CallContext.Provider>
  );
}

export function useCallContext(): UseCallResult {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCallContext must be used inside a CallProvider');
  }
  return context;
}
