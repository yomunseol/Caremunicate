import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      window.location.hash = 'login';
    }
  }, [loading, user]);

  if (loading) {
    return <p className="auth-loading">Checking your account...</p>;
  }

  if (!user) {
    return <p className="auth-loading">Redirecting to login...</p>;
  }

  return <>{children}</>;
}
