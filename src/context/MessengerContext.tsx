import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// The one global handle on the built-in messenger panel.
//
// Chat creation/selection must NEVER navigate away or open a new tab: a
// component calls openMessenger({ conversationId }) and the floating widget
// (mounted once at the app root) opens in place. The URL is left untouched.
// The full-page #chat/<id> route is reachable only through the panel's expand
// affordance, which runs in the SAME tab.
// ---------------------------------------------------------------------------

export type MessengerTarget = {
  conversationId: string;
  peerName?: string;
  peerRole?: string;
};

type MessengerValue = {
  /** The panel is visible. */
  open: boolean;
  /** The conversation the panel should show (null = the inbox list). */
  target: MessengerTarget | null;
  openMessenger: (target: MessengerTarget) => void;
  closeMessenger: () => void;
  setOpen: (open: boolean) => void;
};

const MessengerContext = createContext<MessengerValue | undefined>(undefined);

export function MessengerProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [target, setTarget] = useState<MessengerTarget | null>(null);

  const openMessenger = useCallback((next: MessengerTarget) => {
    setTarget(next);
    setOpenState(true);
  }, []);

  const closeMessenger = useCallback(() => {
    setOpenState(false);
  }, []);

  const setOpen = useCallback((next: boolean) => setOpenState(next), []);

  const value = useMemo<MessengerValue>(
    () => ({ open, target, openMessenger, closeMessenger, setOpen }),
    [open, target, openMessenger, closeMessenger, setOpen],
  );

  return <MessengerContext.Provider value={value}>{children}</MessengerContext.Provider>;
}

export function useMessenger(): MessengerValue {
  const context = useContext(MessengerContext);
  if (!context) {
    throw new Error('useMessenger must be used inside a MessengerProvider');
  }
  return context;
}
