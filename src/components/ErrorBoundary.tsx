import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLang } from '../i18n';

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

// A class cannot call hooks, so the fallback is a small function component that
// can read the translation context.
function ErrorFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useLang();

  return (
    <div role="alert" style={styles.wrapper}>
      <p style={styles.title}>{t('errors.conversationTitle')}</p>
      <p style={styles.detail}>{message}</p>
      <button type="button" style={styles.button} onClick={onRetry}>
        {t('common.tryAgain')}
      </button>
    </div>
  );
}

// Minimal error boundary so an unexpected render crash inside a chat view
// degrades to an inline message instead of unmounting the whole app.
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
      return (
        <ErrorFallback
          message={this.state.error.message}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }

    return this.props.children;
  }
}

const styles = {
  wrapper: {
    textAlign: 'center' as const,
    padding: '3rem 1rem',
  },
  title: {
    margin: 0,
    fontWeight: 600,
    fontSize: 16,
  },
  detail: {
    margin: '0.5rem 0 1rem',
    fontSize: 14,
    color: '#c0392b',
  },
  button: {
    padding: '8px 16px',
    borderRadius: 999,
    border: 'none',
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
};
