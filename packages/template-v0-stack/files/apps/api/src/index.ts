import { Hono } from 'hono';

const app = new Hono();

app.get('/api/health', (c) => c.json({ status: 'ok' }));

// LEV-200 — bind to the host port `levelzero dev` allocated for this api
// service (passed in via `envInjection: { API_PORT: 'hono.port' }`). Default
// to 3001 (NOT 3000) so a bare `bun run dev` outside the levelzero harness
// still works without colliding with `next dev`'s default of 3000.
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3001);

export default {
  fetch: app.fetch,
  port,
};
