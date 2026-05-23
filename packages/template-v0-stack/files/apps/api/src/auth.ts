/**
 * Configured Better Auth instance for the `{{projectName}}` api (LEV-196).
 *
 * This is the single source of truth for "how authentication works in this
 * project": the Hono router (in `index.ts`) mounts `auth.handler` under
 * `/api/auth/*`, and the prisma seed (in `prisma/seed.ts`) imports the same
 * instance to create the demo user with a properly-hashed password. Sharing
 * one instance is what keeps the sign-up path the seed uses in lockstep with
 * the sign-in path the web app exercises.
 *
 * Configuration choices:
 *   - emailAndPassword.enabled = true  — sign-up + sign-in are the only
 *     credential surface this template ships. OAuth providers are explicitly
 *     out of scope for v0 (LEV-196 scope).
 *   - emailAndPassword.requireEmailVerification = false — Better Auth's
 *     default is to NOT require verification. We keep that default so the
 *     dogfood / quickstart flow doesn't depend on configuring a mailer.
 *   - secret — `LICH_AUTH_SECRET` from env, falling back to a literal
 *     dev secret so the template runs without configuration. The fallback
 *     is intentionally well-known so you notice it in `lich env list`
 *     and rotate it before production.
 *   - baseURL — `API_URL` from env (injected by `@lich/plugin-hono` via
 *     the template's `envInjection`), falling back to the same hardcoded
 *     `http://localhost:3001` the rest of the api defaults to.
 *
 * Database wiring: the prisma adapter binds Better Auth's `user`, `session`,
 * `account`, and `verification` table reads/writes to the shared prisma
 * client. The schema for those tables lives in `prisma/schema.prisma` —
 * keep the field names aligned with Better Auth's expectations there, or
 * authentication breaks silently (see `prisma/schema.prisma`'s comments
 * around `Session` / `Account` / `Verification`).
 */
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { prisma } from './prisma';

const API_URL_FALLBACK = 'http://localhost:3001';
// 32 chars minimum is Better Auth's requirement. Replace before deploying.
const DEV_SECRET_FALLBACK = 'lich-dev-secret-rotate-in-prod-aaaa';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  secret: process.env.LICH_AUTH_SECRET ?? DEV_SECRET_FALLBACK,
  baseURL: process.env.API_URL ?? API_URL_FALLBACK,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  // CORS / cross-site usage from the web app is handled at the Hono level
  // in `index.ts`. Better Auth's own `trustedOrigins` keeps the list of
  // allowed Origin headers in sync.
  trustedOrigins: [
    process.env.WEB_URL ?? 'http://localhost:3000',
  ],
});

export type Auth = typeof auth;
