/**
 * `/sign-up` — email + password sign-up for `{{projectName}}` (LEV-196).
 *
 * The form is client-side; this wrapper provides page-level metadata and
 * the back-to-sign-in link.
 */
import { SignUpForm } from '../../components/sign-up-form';

export const metadata = {
  title: 'Sign up — {{projectName}}',
};

export default function SignUpPage(): JSX.Element {
  return (
    <main className="lz-main">
      <header className="lz-header">
        <h1 className="lz-title">Sign up</h1>
        <p className="lz-subtitle">Create your {'{{projectName}}'} account.</p>
      </header>
      <section className="lz-card">
        <SignUpForm />
      </section>
      <p className="lz-muted">
        Already have an account? <a href="/sign-in">Sign in</a>.
      </p>
    </main>
  );
}
