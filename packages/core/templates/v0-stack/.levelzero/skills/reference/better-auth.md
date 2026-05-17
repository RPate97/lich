---
name: better-auth
description: better-auth session and credential reference for the levelzero stack
applies-to: reference
---

# better-auth

better-auth handles sessions, credentials, and OAuth for the stack. The auth
server is mounted inside the Hono API at `apps/api/src/auth.ts` and exposes
`/api/auth/*` routes. The shared session schema lives in
`prisma/schema.prisma` (models `User`, `Session`, `Account`, `Verification`).

## Session model

- A session is a row in `Session` keyed by an opaque token stored in the
  `better-auth.session_token` cookie. Sessions are validated by middleware on
  every request, not by re-decoding a JWT.
- Read the current user inside a Hono handler with
  `const session = await auth.api.getSession({ headers: c.req.raw.headers })`.
  Returns `null` when unauthenticated — never assume a user is present.
- Pin protected routes behind a middleware that short-circuits with
  `c.json({ error: 'unauthorized' }, 401)` when the session is missing.

## Email + password

- The `emailAndPassword` plugin is enabled in `apps/api/src/auth.ts`. Signups
  hit `POST /api/auth/sign-up/email`, logins hit
  `POST /api/auth/sign-in/email`.
- Passwords are hashed with scrypt server-side. Never log or echo the raw
  password in any handler.
- Email verification is on by default; the verification token expires after
  24h. Override the mailer by setting `auth.options.emailVerification` in the
  same config file.

## Acting as a user (testing)

- `levelzero curl --as <user-email> <path>` issues an HTTP request against
  the running API with the given user's session cookie injected. Use this
  from agent loops to exercise protected endpoints without writing a login
  flow each time.
- For Vitest, call `auth.api.signInEmail({ body: { email, password } })`
  in a test fixture and reuse the returned cookie.

## Pitfalls

- The session cookie is `HttpOnly` and `SameSite=Lax`. Cross-origin web
  callers need `credentials: 'include'` on every `fetch`.
- Rotating the `BETTER_AUTH_SECRET` invalidates every active session — only
  do it during a planned logout window.
