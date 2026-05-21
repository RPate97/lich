'use client';

/**
 * `<SignInForm>` — email + password sign-in for `{{projectName}}` (LEV-196).
 *
 * Form names match what the e2e test (`e2e/auth-flow.spec.ts`) drives:
 *   - `[name=email]`, `[name=password]`
 *   - `<button type="submit">`
 *
 * Uses the Better Auth client (`authClient.signIn.email`). On success,
 * pushes the browser to `/dashboard`. On failure, surfaces Better Auth's
 * error message verbatim into a `<p class="lz-error">` so the user sees
 * something actionable instead of a silent reset.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '../lib/auth-client';

export function SignInForm(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? 'sign-in failed');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="lz-form" onSubmit={onSubmit}>
      <div className="lz-field">
        <label className="lz-label" htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="lz-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="lz-field">
        <label className="lz-label" htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          className="lz-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error ? <p className="lz-error">{error}</p> : null}
      <button type="submit" className="lz-button" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
