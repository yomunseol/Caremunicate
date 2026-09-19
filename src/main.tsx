import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { CallProvider } from './context/CallContext';
import { ToastProvider } from './context/ToastContext';
import { LangProvider } from './i18n';
import './styles/globals.css';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <LangProvider>
      <AuthProvider>
        <CallProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </CallProvider>
      </AuthProvider>
    </LangProvider>
  </React.StrictMode>
);
