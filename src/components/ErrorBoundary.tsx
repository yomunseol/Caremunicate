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
  stack: string | null;
};

function ErrorFallback({ message, stack }: { message: string; stack: string | null }) {
  const { t } = useLang();

  return (
    <div className="error-fallback" role="alert">
      <div className="error-card">
        <h2 className="error-title">{t('errors.somethingWrong')}</h2>
        <p className="error-detail">{message}</p>
        {/* Development only: the component stack names the failing source. */}
        {stack ? <pre className="error-stack">{stack}</pre> : null}
        <button type="button" className="primary-button" onClick={() => window.location.reload()}>
          {t('errors.reload')}
        </button>
      </div>
    </div>
  );
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, stack: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, info);
    this.setState({ stack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          message={describeError(this.state.error)}
          stack={import.meta.env?.DEV ? this.state.stack : null}
        />
      );
    }
    return this.props.children;
  }
}
