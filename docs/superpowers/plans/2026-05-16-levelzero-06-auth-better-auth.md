# Plan 06 — Auth + Better Auth adapter

**Goal:** Define `AuthAdapter` interface and ship a Better Auth implementation. Library-level helpers only in plan 06: create-user, sign-session, inspect-session. The full `levelzero curl --as <user>` HTTP integration is deferred to plan 11 (it needs a running api).

**Architecture:**
- Better Auth is a library, not a service. The adapter wraps its primitives (user creation, session signing, session inspection) into a stable API the CLI and test harness can call.
- v0 plan-06 tests use Better Auth's recommended in-memory / SQLite adapter for fast unit tests; integration tests against a real Postgres land alongside plan 05 work.

**Files:**
```
tools/cli/src/
  adapters/
    auth/
      types.ts                  # AuthAdapter interface
      better-auth.ts            # Better Auth implementation
  auth/
    helpers.ts                  # createUser, signSession, inspectSession orchestration helpers
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 06.1 | AuthAdapter interface | 1 | `adapters/auth/types.ts` |
| 06.2 | Better Auth project setup (npm dep, config types, factory) | 1 | `adapters/auth/better-auth.ts` (skeleton) |
| 06.3 | `createUser` adapter method + Better Auth impl | 2 | `adapters/auth/better-auth.ts` (extend) |
| 06.4 | `signSession` + `inspectSession` adapter methods | 2 | `adapters/auth/better-auth.ts` (extend) |
| 06.5 | `auth/helpers.ts` (orchestration layer used by future commands) | 3 | `auth/helpers.ts` |

Wave 1 has 2 parallel agents. Wave 2 is sequential.

## New deps

- `better-auth` (latest)
- `better-sqlite3` (transitive for in-memory test adapter — Better Auth docs recommend it for tests)

## Out of scope for plan 06

- `levelzero curl --as <user>` command — deferred to plan 11.
- Real api integration — deferred to plan 11.
- OAuth providers, magic links, etc. — discovery follow-ons.

## Verification

- Unit tests: createUser produces a Better Auth record; signSession produces a verifiable token; inspectSession round-trips.
- Full suite green; tsc clean.
