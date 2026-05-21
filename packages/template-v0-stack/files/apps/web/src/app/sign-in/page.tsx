/**
 * `/sign-in` — email + password sign-in for `{{projectName}}` (LEV-196).
 *
 * Pure-client page (the form itself is `'use client'`); the wrapper here
 * exists to provide page-level metadata and the create-an-account link.
 */
import { SignInForm } from '../../components/sign-in-form';

export const metadata = {
  title: 'Sign in — {{projectName}}',
};

export default function SignInPage(): JSX.Element {
  return (
    <main className="lz-main">
      <header className="lz-header">
        <h1 className="lz-title">Sign in</h1>
        <p className="lz-subtitle">Welcome back to {'{{projectName}}'}.</p>
      </header>
      <section className="lz-card">
        <SignInForm />
      </section>
      <p className="lz-muted">
        New here? <a href="/sign-up">Create an account</a>.
      </p>
    </main>
  );
}
