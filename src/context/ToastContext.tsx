import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { describeError } from '../lib/errors';

// ---------------------------------------------------------------------------
// The ONE notification surface.
//
// Toasts render in a fixed container at the top-centre of the viewport, below
// the header, and are portaled to <body> so no page container can clip them or
// pull them into the layout. The stack is pointer-events-none and never sits in
// the page flow — a toast can never be centred over a card or overlap a button.
// Every notification (success, error, info) goes through notify().
// ---------------------------------------------------------------------------

export type ToastKind = 'success' | 'error' | 'info';

type Toast = { id: number; message: string; kind: ToastKind };

type ToastApi = {
  notify: (message: unknown, kind?: ToastKind) => void;
};

const ToastContext = createContext<ToastApi | undefined>(undefined);

/** Each toast auto-dismisses after 3s (the fade/slide itself is 150ms). */
const AUTO_DISMISS_MS = 3000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: unknown, kind: ToastKind = 'info') => {
      // Toasts carry a STRING only — never an object. Dev builds assert it.
      let text: string;
      if (typeof message === 'string') {
        text = message;
      } else {
        if (import.meta.env?.DEV) {
          console.error('TOAST ASSERTION: toast message must be a string; received', message);
        }
        text = describeError(message);
      }

      const id = nextId.current;
      nextId.current += 1;

      setToasts((previous) => [...previous, { id, message: text, kind }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ notify }), [notify]);

  const stack =
    typeof document === 'undefined'
      ? null
      : createPortal(
          <div className="toast-stack" role="region" aria-label="Notifications">
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={`toast toast--${toast.kind}`}
                role="status"
                aria-live="polite"
              >
                {toast.message}
              </div>
            ))}
          </div>,
          document.body,
        );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {stack}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside a ToastProvider');
  }
  return context;
}
