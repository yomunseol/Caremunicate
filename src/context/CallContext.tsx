import { createContext, useContext, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useCall, type UseCallResult } from '../hooks/useCall';
import CallLayer from '../components/CallLayer';

// ---------------------------------------------------------------------------
// One call session for the whole app. This provider is the single owner of call
// state: any component may start/join a call, but CallLayer is the only thing
// that renders call UI, and it does so exactly once, above everything else.
// ---------------------------------------------------------------------------

const CallContext = createContext<UseCallResult | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const displayName = String(user?.user_metadata?.fullName ?? user?.email ?? '');
  const call = useCall(user?.id, displayName);

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
