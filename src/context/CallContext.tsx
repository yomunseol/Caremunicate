import { createContext, useContext, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useCall, type UseCallResult } from '../hooks/useCall';
import CallRoom from '../components/CallRoom';

// ---------------------------------------------------------------------------
// One call session for the whole app: any component can start/join a call and
// CallRoom renders the UI exactly once, above everything else.
// ---------------------------------------------------------------------------

const CallContext = createContext<UseCallResult | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const displayName = String(user?.user_metadata?.fullName ?? user?.email ?? '');
  const call = useCall(user?.id, displayName);

  return (
    <CallContext.Provider value={call}>
      {children}
      <CallRoom />
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
