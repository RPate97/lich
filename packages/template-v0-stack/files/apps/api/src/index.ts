/**
 * `{{projectName}}` api — Hono backend.
 *
 * Routes:
 *   - GET    /api/health              — liveness probe (no auth)
 *   - ALL    /api/auth/*              — Better Auth (sign-up / sign-in / sessions)
 *   - GET    /api/me                  — current user (or 401)
 *   - GET    /api/todos               — list current user's todos (401 if unauth)
 *   - POST   /api/todos               — create `{ text }`
 *   - PATCH  /api/todos/:id           — toggle done `{ done }`
 *   - DELETE /api/todos/:id           — delete
 *
 * The default export proxies both the Bun runtime contract (`{ fetch, port }`,
 * so `bun run --hot` binds to the allocated port — LEV-200) AND the lich
 * generator contract (a `routes` array, so `lich gen --only api-client`'s
 * route extraction sees the registered handlers). Stripping either field
 * breaks one of those flows silently.
 */
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { auth } from './auth';
import { prisma } from './prisma';

// Augment Hono's context Variables map so `c.set('userId', ...)` is typed
// and `c.get('userId')` is non-undefined when the session middleware ran.
type AppEnv = { Variables: { userId: string } };
const app = new Hono<AppEnv>();

// LEV-196 — the web app calls the api from a different origin
// (`localhost:WEB_PORT` → `localhost:API_PORT`). Cookies need
// `credentials: 'include'` on the client; the server has to opt-in via CORS
// or browsers strip the Set-Cookie response. `origin` mirrors the env we
// trust in `auth.ts`.
app.use(
  '/api/*',
  cors({
    origin: (origin) => origin ?? (process.env.WEB_URL ?? 'http://localhost:3000'),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Mount Better Auth. The handler is fetch-shaped, so we hand it the raw
// request via `c.req.raw` and return the response Better Auth produced.
// One handler covers every `/api/auth/**` subroute (sign-up, sign-in,
// sign-out, get-session, …).
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Current user. Returns 401 with a stable shape `{ error: '...' }` so the
// web app can short-circuit without parsing different error shapes per
// endpoint. Used by `apps/web/src/app/dashboard/page.tsx` as the session
// probe.
app.get('/api/me', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  return c.json({ user: session.user });
});

// Session guard for the todo CRUD surface. Stashes `userId` on the request
// context so handlers don't repeat the session lookup. Pattern matches the
// `.lich/skills/reference/better-auth.md` recommendation.
const requireSession = async (c: Context<AppEnv>, next: Next): Promise<Response | void> => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  c.set('userId', session.user.id);
  await next();
};
app.use('/api/todos', requireSession);
app.use('/api/todos/*', requireSession);

app.get('/api/todos', async (c) => {
  const userId = c.get('userId');
  const todos = await prisma.todo.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return c.json({ todos });
});

app.post('/api/todos', async (c) => {
  const userId = c.get('userId');
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) {
    return c.json({ error: 'text is required' }, 400);
  }
  const todo = await prisma.todo.create({ data: { userId, text } });
  return c.json({ todo }, 201);
});

app.patch('/api/todos/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { done?: unknown } | null;
  if (typeof body?.done !== 'boolean') {
    return c.json({ error: 'done must be a boolean' }, 400);
  }
  // Use updateMany so the where clause includes `userId` — prevents a logged-
  // in user from toggling someone else's todo by guessing its id.
  const result = await prisma.todo.updateMany({
    where: { id, userId },
    data: { done: body.done },
  });
  if (result.count === 0) return c.json({ error: 'not found' }, 404);
  const todo = await prisma.todo.findUnique({ where: { id } });
  return c.json({ todo });
});

app.delete('/api/todos/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const result = await prisma.todo.deleteMany({ where: { id, userId } });
  if (result.count === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// LEV-200 — bind to the host port `lich dev` allocated for this api
// service (passed in via `envInjection: { API_PORT: 'hono.port' }`). Default
// to 3001 (NOT 3000) so a bare `bun run dev` outside the lich harness
// still works without colliding with `next dev`'s default of 3000.
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3001);

// Default export shape: Bun's runtime reads `{ fetch, port }` and serves
// on the chosen port. `lich gen`'s hono route extractor reads `routes`
// from the same default export. Both are required — dropping either breaks
// a flow (Bun's port binding or the typed-client generator).
export default {
  fetch: app.fetch,
  port,
  routes: app.routes,
};
