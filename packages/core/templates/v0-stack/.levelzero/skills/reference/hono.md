---
name: hono
description: Hono API framework reference for the levelzero stack
applies-to: reference
---

# Hono

The API lives at `apps/api`. The entrypoint is `apps/api/src/index.ts` and the
dev server is launched by `levelzero dev` (which boots the database, then
api, then web). Logs stream via `levelzero logs api`.

## Route patterns

- Mount feature routers with `app.route('/users', usersRouter)` so route trees
  stay flat and discoverable. One file per resource.
- Use `c.req.valid('json' | 'query' | 'param')` after a `zValidator(...)`
  middleware — never read `await c.req.json()` directly without validation.
- Return typed JSON with `c.json(data, status)`. Status codes are part of the
  type, so omitting them silently changes the response contract.

## Middleware

- `app.use('*', logger())` and `app.use('*', cors())` belong at the root.
  Auth middleware should be scoped to the subtree it protects, not global.
- Apply rate limiting at the route group, not per handler, so headers are
  consistent across endpoints.

## Type safety

- Compose `RouterType` exports and import them into `apps/web` for end-to-end
  types via `hc<typeof appRouter>(baseUrl)`. This means the web app gets
  request/response inference without a code generator.
- Run `levelzero types` to typecheck both apps after touching a route.

## Testing

- Use `app.request('/path', { method: 'POST', body: ... })` in Vitest tests —
  no port binding required.
- Stub the Prisma client with `vi.mock('@/db')` rather than spinning a real
  database, unless the test is explicitly integration-level.

## Pitfalls

- `c.env` is only populated in edge runtimes; in Node use `process.env`.
- Async middleware must `return await next()` or the handler short-circuits.
