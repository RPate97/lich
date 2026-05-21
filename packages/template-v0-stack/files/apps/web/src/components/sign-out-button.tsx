'use client';

/**
 * `<SignOutButton>` — calls `authClient.signOut()` then redirects to the
 * landing page (LEV-196).
 *
 * Accessible name "Sign out" matches what the e2e test drives.
 */
import { useRouter } from 'next/navigation';
import { authClient } from '../lib/auth-client';

export function SignOutButton(): JSX.Element {
  const router = useRouter();
  async function onClick(): Promise<void> {
    await authClient.signOut();
    router.push('/sign-in');
    router.refresh();
  }
  return (
    <button type="button" className="lz-button lz-button-secondary" onClick={onClick}>
      Sign out
    </button>
  );
}
