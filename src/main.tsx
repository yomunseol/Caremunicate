import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { RoleProvider } from './context/RoleContext';
import { CallProvider } from './context/CallContext';
import { ToastProvider } from './context/ToastContext';
import { LangProvider } from './i18n';
import './styles/globals.css';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <LangProvider>
      <AuthProvider>
        <RoleProvider>
          <CallProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </CallProvider>
        </RoleProvider>
      </AuthProvider>
    </LangProvider>
  </React.StrictMode>
);
