import { useState, type FormEvent } from 'react';
import { Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';

interface AdminLoginViewProps {
  configured: boolean;
  configurationLoaded: boolean;
  statusError: string | null;
  onAuthenticated: () => void;
}

export function AdminLoginView({
  configured,
  configurationLoaded,
  statusError,
  onAuthenticated,
}: AdminLoginViewProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Admin sign-in failed.');
        return;
      }
      setPassword('');
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-md mx-auto bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
      <div className="w-11 h-11 rounded-xl bg-sky-50 text-sky-700 flex items-center justify-center mb-5">
        <LockKeyhole className="w-5 h-5" />
      </div>
      <h2 className="text-lg font-semibold text-slate-900">
        Admin sign-in required
      </h2>
      <p className="text-sm text-slate-600 mt-1">
        Sign in to view and manage the Telegram bot configuration.
      </p>

      {!configurationLoaded ? (
        <p className="text-sm text-slate-600 mt-5" role="status">
          {statusError || 'Checking admin login configuration…'}
        </p>
      ) : !configured ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 mt-5">
          Admin login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD
          in your environment, then restart the server.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4 mt-6">
          <div>
            <label
              htmlFor="admin-username"
              className="block text-xs font-semibold text-slate-700 mb-1.5"
            >
              Admin username
            </label>
            <input
              id="admin-username"
              type="text"
              autoComplete="username"
              required
              maxLength={128}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-600/20 focus:border-sky-600"
            />
          </div>
          <div>
            <label
              htmlFor="admin-password"
              className="block text-xs font-semibold text-slate-700 mb-1.5"
            >
              Password
            </label>
            <input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-600/20 focus:border-sky-600"
            />
          </div>
          {error && (
            <p
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
              role="alert"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full h-10 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-lg inline-flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4" />
            )}
            <span>{busy ? 'Signing in…' : 'Sign in'}</span>
          </button>
        </form>
      )}
    </section>
  );
}
