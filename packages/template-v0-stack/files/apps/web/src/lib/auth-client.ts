/**
 * Browser-side Better Auth client for `{{projectName}}` (LEV-196).
 *
 * Used by `<SignInForm>` / `<SignUpForm>` / sign-out buttons. The base URL is
 * the api origin (`NEXT_PUBLIC_API_URL`, exposed in `next.config.js` from the
 * server-side `API_URL` env that `@levelzero/plugin-hono` publishes). It
 * defaults to `http://localhost:3001` so the app still works when run with
 * a bare `bun run dev` outside the levelzero harness.
 *
 * NOTE: every method on `authClient` performs a fetch with
 * `credentials: 'include'` so the session cookie set by the api round-trips.
 * The api enables this via Hono's `cors({ credentials: true })` middleware.
 */
import { createAuthClient } from 'better-auth/client';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const authClient = createAuthClient({
  baseURL: API_URL,
});
