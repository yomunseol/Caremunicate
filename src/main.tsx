import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { CallProvider } from './context/CallContext';
import { LangProvider } from './i18n';
import './styles/globals.css';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <LangProvider>
      <AuthProvider>
        <CallProvider>
          <App />
        </CallProvider>
      </AuthProvider>
    </LangProvider>
  </React.StrictMode>
);
