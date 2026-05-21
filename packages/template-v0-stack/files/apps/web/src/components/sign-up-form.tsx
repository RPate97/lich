'use client';

/**
 * `<SignUpForm>` — email + password sign-up for `{{projectName}}` (LEV-196).
 *
 * Defaults the display `name` field to the local part of the email if the
 * user doesn't fill it in — Better Auth's `signUpEmail` requires `name`,
 * and most v0 flows don't care about a real display name yet.
 *
 * On success, pushes the browser to `/dashboard`. On failure, surfaces
 * Better Auth's error message verbatim into a `<p class="lz-error">`.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '../lib/auth-client';

export function SignUpForm(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const displayName = name.trim().length > 0 ? name.trim() : email.split('@')[0] || email;
    try {
      const result = await authClient.signUp.email({ email, password, name: displayName });
      if (result.error) {
        setError(result.error.message ?? 'sign-up failed');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-up failed');
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
        <label className="lz-label" htmlFor="name">Name <span className="lz-muted">(optional)</span></label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          className="lz-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="lz-field">
        <label className="lz-label" htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className="lz-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error ? <p className="lz-error">{error}</p> : null}
      <button type="submit" className="lz-button" disabled={busy}>
        {busy ? 'Creating account…' : 'Sign up'}
      </button>
    </form>
  );
}
