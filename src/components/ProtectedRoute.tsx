import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading, pending2FA } = useAuth();
  const { t } = useLang();

  useEffect(() => {
    if (loading) return;

    if (!user || pending2FA) {
      window.location.hash = 'login';
    }
  }, [loading, pending2FA, user]);

  if (loading) {
    return <p className="auth-loading">{t('errors.checkingAccount')}</p>;
  }

  if (!user) {
    return <p className="auth-loading">{t('errors.redirecting')}</p>;
  }

  if (pending2FA) {
    return <p className="auth-loading">{t('errors.complete2fa')}</p>;
  }

  return <>{children}</>;
}
