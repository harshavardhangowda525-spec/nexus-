'use client';

import { useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';

interface Props {
  needsBootstrap: boolean;
  onAuthenticated: () => void;
}

export function AuthGate({ needsBootstrap, onAuthenticated }: Props) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('NEXUS Studio');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (needsBootstrap) {
        await api.bootstrap({ email, name, password, workspaceName });
      } else {
        await api.login({ email, password });
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card glass" onSubmit={submit}>
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <defs>
              <linearGradient id="lgAuth" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#2fd8ff" />
                <stop offset="1" stopColor="#9b8cff" />
              </linearGradient>
            </defs>
            <path d="M16 2.5 28 9.3v13.4L16 29.5 4 22.7V9.3Z" fill="none" stroke="url(#lgAuth)" strokeWidth="1.8" />
            <circle cx="16" cy="16" r="3.2" fill="url(#lgAuth)" />
          </svg>
          <span className="word">NEXUS</span>
        </div>

        <div>
          <h1>{needsBootstrap ? 'Create CEO workspace' : 'Sign in to NEXUS'}</h1>
          <p className="sub">
            {needsBootstrap
              ? 'First-time setup: create the owner account and workspace.'
              : 'Enter your credentials to enter the 3D office.'}
          </p>
        </div>

        {needsBootstrap && (
          <>
            <div className="field">
              <label htmlFor="auth-ws">Workspace name</label>
              <input
                id="auth-ws"
                className="input"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="auth-name">Your name</label>
              <input
                id="auth-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex Rivera"
                required
              />
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ceo@company.com"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="auth-pass">Password</label>
          <input
            id="auth-pass"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={needsBootstrap ? 'At least 10 characters' : '••••••••••'}
            minLength={needsBootstrap ? 10 : 1}
            required
          />
        </div>

        {error && <div className="err-box">{error}</div>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : needsBootstrap ? 'Create workspace & enter office' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
