import { Component, type ErrorInfo, type ReactNode } from 'react';
import { describeError } from '../lib/errors';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Route error boundary.
//
// Every route is wrapped, so a render crash degrades to a centred mint card —
// never a blank page. The raw message is shown in small monospace so the cause
// is visible while debugging, and Reload restarts the app.
// ---------------------------------------------------------------------------

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

function ErrorFallback({ message }: { message: string }) {
  const { t } = useLang();

  return (
    <div className="error-fallback" role="alert">
      <div className="error-card">
        <h2 className="error-title">{t('errors.somethingWrong')}</h2>
        <p className="error-detail">{message}</p>
        <button type="button" className="primary-button" onClick={() => window.location.reload()}>
          {t('errors.reload')}
        </button>
      </div>
    </div>
  );
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, info);
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback message={describeError(this.state.error)} />;
    }
    return this.props.children;
  }
}
