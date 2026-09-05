import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading, pending2FA } = useAuth();

  useEffect(() => {
    if (loading) return;

    if (!user || pending2FA) {
      window.location.hash = 'login';
    }
  }, [loading, pending2FA, user]);

  if (loading) {
    return <p className="auth-loading">Checking your account...</p>;
  }

  if (!user) {
    return <p className="auth-loading">Redirecting to login...</p>;
  }

  if (pending2FA) {
    return <p className="auth-loading">Complete two-factor verification to continue...</p>;
  }

  return <>{children}</>;
}
