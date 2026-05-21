/**
 * LEV-213 — Real api ↔ db roundtrip end-to-end.
 *
 * The dogfood suite's phase-3 `GET /api/health` proves the api is reachable on
 * its allocated port. It does NOT prove the api can talk to postgres — a
 * `DATABASE_URL` malformed by a regression in env injection (wrong host, wrong
 * scheme, missing port) silently passes that test and only blows up when a
 * user's app actually tries `prisma.user.create({...})` and sees ECONNREFUSED.
 *
 * This file exercises the LEV-196 template's authoritative HTTP surface:
 *
 *   - `POST /api/auth/sign-up/email`      — Better Auth writes a `User` row
 *                                            via the prisma adapter; proves
 *                                            sign-up + DB write path works
 *   - `GET  /api/me`                      — session-cookie roundtrip; proves
 *                                            Better Auth's session table read
 *                                            path works
 *   - `POST /api/todos`                   — authenticated write of an
 *                                            application-domain row
 *   - `GET  /api/todos`                   — authenticated read of the just-
 *                                            written row
 *   - `PATCH /api/todos/:id`              — authenticated update + re-read
 *   - `DELETE /api/todos/:id`             — authenticated delete + re-read
 *   - `GET  /api/todos` without cookie    — auth guard returns 401 (proves
 *                                            requireSession middleware works)
 *
 * What this CATCHES that phase 3 of the dogfood suite does NOT:
 *
 *   - DATABASE_URL injected with the wrong host (`postgres` compose-DNS in
 *     a host-context-resolved owned service) → sign-up returns 500 with a
 *     postgres ECONNREFUSED, not a silent pass.
 *   - DATABASE_URL injected without the allocated host port → same.
 *   - Better Auth routes mounted at the wrong prefix → sign-up returns 404,
 *     test fails loudly.
 *   - Session cookie not set on sign-up → /api/me roundtrip fails.
 *   - Todo CRUD broken (FK constraint missing, userId not propagated through
 *     session) → roundtrip assertions fail.
 *   - Auth guard regressed (todos accessible without a session) → 401 test
 *     fails.
 *
 * We deliberately exercise the api's HTTP surface rather than probing
 * postgres directly (e.g., `psql` against the allocated port). That keeps
 * the env-injection chain (`postgres.url` → `DATABASE_URL` → `process.env`
 * in api child process → `PrismaPg` adapter) in the test path, which is the
 * whole point of LEV-213.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  setupScaffoldedProject,
  sweepStaleTmpdirs,
  teardownScaffoldedProject,
  type E2EProjectHandle,
} from './_helpers/setup';
import { runCli, runCliJson } from './_helpers/cli';
import { dockerAvailable } from './_helpers/docker';

const DOCKER = dockerAvailable();

let handle: E2EProjectHandle;
let apiUrl: string;

// Shared cross-test state: the sign-up test populates these and every
// subsequent test reads them. Vitest's default sequential mode within a file
// makes this safe.
let sessionCookie = '';
let userId = '';
let createdTodoId = '';

describe.skipIf(!DOCKER)('LEV-213 api ↔ db roundtrip', () => {
  beforeAll(async () => {
    sweepStaleTmpdirs('lz-e2e-roundtrip-');
    handle = await setupScaffoldedProject({ tmpdirPrefix: 'lz-e2e-roundtrip-' });

    // Bring the stack up — postgres in compose, api + web as owned host
    // processes. The owned-services runner uses host-context env
    // resolution, so the api sees a `DATABASE_URL` pointing at
    // `localhost:<allocated-port>` (the host-side forward of the postgres
    // container).
    const dev = runCliJson<{
      ports: Record<string, number>;
      compose: { projectName: string };
    }>(handle.projectDir, ['dev', '--json'], { timeoutMs: 180_000 });
    handle.setComposeProjectName(dev.json.compose.projectName);
    apiUrl = `http://localhost:${dev.json.ports['api-http']}`;

    // Push the schema directly to postgres via `prisma db push`. Why not
    // `levelzero db migrate`? Two reasons:
    //
    //   1. The template ships with NO `prisma/migrations` directory
    //      (LEV-215 territory), so `db migrate` (which runs `prisma migrate
    //      deploy`) is a no-op against the empty migrations folder — the
    //      auth/Todo tables never get created and sign-up fails with
    //      `relation "User" does not exist`.
    //   2. `db migration new` (which would scaffold an initial migration
    //      from the schema diff) is currently broken on Prisma 7 — it
    //      passes the now-unsupported `--skip-generate` flag to
    //      `prisma migrate dev --create-only`, which exits non-zero with
    //      "unknown or unexpected option". See `plugin-prisma/src/adapter.
    //      ts:301`. This is a real bug surfaced by LEV-213 work but it
    //      lives outside this ticket's scope.
    //
    // `prisma db push` sidesteps both: it diffs schema → live DB and
    // applies the changes in place, no migration files needed. This is
    // the right shape for the test — we want to prove the env-injection
    // chain works end-to-end, NOT exercise the migrations subsystem
    // (which has dedicated coverage in db.e2e.test.ts).
    const { json: apiEnv } = runCliJson<{
      env: Record<string, string>;
    }>(handle.projectDir, [
      'env',
      'resolve',
      'api',
      '--context',
      'host',
      '--json',
    ]);
    const databaseUrl = apiEnv.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error('env resolve api did not produce DATABASE_URL');
    }
    // Note: Prisma 7 dropped the `--skip-generate` flag for `db push`
    // (it's silently always-on now, per the Prisma 7 CLI help). We
    // explicitly use `--accept-data-loss` because the schema diff
    // against an empty database technically counts as "data loss" to
    // prisma's safety checks — a no-op on a fresh stack but defensive
    // against rerun-into-existing-data scenarios.
    const push = spawnSync(
      'bunx',
      [
        'prisma',
        'db',
        'push',
        '--accept-data-loss',
        '--schema',
        'prisma/schema.prisma',
      ],
      {
        cwd: handle.projectDir,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 120_000,
      },
    );
    if (push.status !== 0) {
      throw new Error(
        `prisma db push failed (exit ${push.status}):\nstdout:\n${push.stdout}\nstderr:\n${push.stderr}`,
      );
    }

    // Give the api a beat to bind + finish hot-reload after migrations
    // touch the prisma client. 3s is empirically enough on the slowest
    // CI machines we've tested against; LEV-200's port-forward is already
    // up by this point.
    await new Promise((r) => setTimeout(r, 3000));
  }, 360_000);

  afterAll(async () => {
    await teardownScaffoldedProject(handle);
  }, 90_000);

  // -------------------------------------------------------------------------
  // env-injection sanity
  //
  // The api is an owned host process (LEV-196 / LEV-200), so the runner
  // resolves its env in HOST context — meaning DATABASE_URL points at
  // localhost (the host-side forward of the postgres container), NOT at
  // the compose-DNS hostname `postgres`. We verify the shape of the URL
  // the api actually sees so a regression in env-injection wiring fails
  // here BEFORE the HTTP roundtrip tests fail with a confusing
  // ECONNREFUSED.
  // -------------------------------------------------------------------------
  it('DATABASE_URL injected into api (host context) is a valid postgres URL', () => {
    const { json } = runCliJson<{
      service: string;
      context: 'host' | 'container';
      env: Record<string, string>;
    }>(handle.projectDir, [
      'env',
      'resolve',
      'api',
      '--context',
      'host',
      '--json',
    ]);
    expect(json.env['DATABASE_URL']).toBeDefined();
    // Must be a postgres URL with a host + port. We don't assert localhost
    // explicitly because the runner may resolve to 127.0.0.1 on some
    // platforms (or a docker-machine VM ip in the future) — the structural
    // shape is what matters.
    expect(json.env['DATABASE_URL']).toMatch(
      /^postgres(ql)?:\/\/[^@]+@[^:]+:\d+\/.+/,
    );
    // And it MUST NOT point at the compose-DNS hostname (a regression that
    // would make the host-spawned api unable to reach postgres). The
    // compose service name is `postgres`; matching `@postgres:` would catch
    // that regression while still allowing `@postgres-something@`-style
    // hostnames if they ever showed up.
    expect(json.env['DATABASE_URL']).not.toMatch(/@postgres:/);
  });

  // -------------------------------------------------------------------------
  // Better Auth sign-up — first proof the api can WRITE to postgres
  // -------------------------------------------------------------------------
  it('POST /api/auth/sign-up/email creates a user (writes auth.user row)', async () => {
    const email = `lev213-${Date.now()}@example.com`;
    const res = await fetch(`${apiUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'lev213test', name: 'lev213' }),
    });
    // Better Auth returns 200 on success. Anything in the 4xx range here
    // means either the route isn't mounted (404), the password was rejected
    // (422), or the prisma write failed (500 with a postgres error in the
    // body) — all of which we want to fail loudly on.
    expect(res.status, `sign-up failed: ${await res.clone().text()}`).toBeLessThan(400);

    // Capture the session cookie Better Auth sets on successful sign-up.
    // `res.headers.get('set-cookie')` returns the joined header value
    // (which may contain multiple cookies). Grab just the first name=value
    // pair — that's the session cookie Better Auth needs for subsequent
    // authenticated requests.
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie, 'sign-up did not return a Set-Cookie header').toBeTruthy();
    sessionCookie = setCookie!.split(';')[0]!.trim();

    const body = (await res.json()) as {
      user?: { id?: string };
      id?: string;
      token?: string;
    };
    // Better Auth's sign-up response shape: `{ token, user: { id, ... } }`.
    // We tolerate either nested or flat for resilience to minor library
    // upgrades.
    userId = body.user?.id ?? body.id ?? '';
    expect(userId, `sign-up response missing user id: ${JSON.stringify(body)}`).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Session-protected GET — proves the session cookie + db read both work
  // -------------------------------------------------------------------------
  it('GET /api/me returns the signed-up user (session cookie + db read)', async () => {
    // Skip cleanly if sign-up failed (saves a confusing cascade of failures).
    if (!sessionCookie || !userId) {
      throw new Error(
        'sign-up did not populate sessionCookie/userId — skipping dependent assertions',
      );
    }
    const res = await fetch(`${apiUrl}/api/me`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status, `me failed: ${await res.clone().text()}`).toBe(200);
    const body = (await res.json()) as { user?: { id?: string } };
    // The api wraps the user under `{ user }` (see `apps/api/src/index.ts`'s
    // `/api/me` handler). Assert the nested shape directly — a flat-shape
    // response here would mean the handler regressed.
    expect(body.user?.id).toBe(userId);
  });

  // -------------------------------------------------------------------------
  // Todo CRUD roundtrip — the core LEV-213 proof
  // -------------------------------------------------------------------------
  it('POST /api/todos creates a Todo row in postgres', async () => {
    if (!sessionCookie) throw new Error('no sessionCookie — sign-up failed');
    const res = await fetch(`${apiUrl}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ text: 'lev213 roundtrip probe' }),
    });
    expect(res.status, `create todo failed: ${await res.clone().text()}`).toBeLessThan(300);
    const body = (await res.json()) as { todo?: { id?: string; text?: string } };
    // The api returns `{ todo: { id, ... } }` (see `app.post('/api/todos'...)`).
    expect(body.todo?.id, `create response missing todo id: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.todo?.text).toBe('lev213 roundtrip probe');
    createdTodoId = body.todo!.id!;
  });

  it('GET /api/todos retrieves the row we just wrote', async () => {
    if (!sessionCookie || !createdTodoId) {
      throw new Error('prior CRUD step failed — skipping dependent assertion');
    }
    const res = await fetch(`${apiUrl}/api/todos`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todos?: Array<{ id: string; text: string }> };
    // The handler returns `{ todos: [...] }` (see `app.get('/api/todos'...)`).
    expect(Array.isArray(body.todos)).toBe(true);
    const found = body.todos!.find((t) => t.id === createdTodoId);
    expect(found, `created todo ${createdTodoId} not found in list`).toBeDefined();
    expect(found!.text).toBe('lev213 roundtrip probe');
  });

  it('PATCH /api/todos/:id updates the row in postgres', async () => {
    if (!sessionCookie || !createdTodoId) {
      throw new Error('prior CRUD step failed — skipping dependent assertion');
    }
    const res = await fetch(`${apiUrl}/api/todos/${createdTodoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status, `patch failed: ${await res.clone().text()}`).toBeLessThan(300);

    // Re-read to confirm the write landed. Going through GET (vs. trusting
    // the PATCH response body) keeps both code paths in the assertion
    // chain — a regression that breaks GET while leaving PATCH's response
    // intact would still fail here.
    const get = await fetch(`${apiUrl}/api/todos`, {
      headers: { Cookie: sessionCookie },
    });
    const body = (await get.json()) as { todos?: Array<{ id: string; done: boolean }> };
    const found = body.todos!.find((t) => t.id === createdTodoId);
    expect(found?.done).toBe(true);
  });

  it('DELETE /api/todos/:id removes the row', async () => {
    if (!sessionCookie || !createdTodoId) {
      throw new Error('prior CRUD step failed — skipping dependent assertion');
    }
    const res = await fetch(`${apiUrl}/api/todos/${createdTodoId}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    expect(res.status, `delete failed: ${await res.clone().text()}`).toBeLessThan(300);

    const get = await fetch(`${apiUrl}/api/todos`, {
      headers: { Cookie: sessionCookie },
    });
    const body = (await get.json()) as { todos?: Array<{ id: string }> };
    const found = body.todos!.find((t) => t.id === createdTodoId);
    expect(found, `deleted todo ${createdTodoId} still present in list`).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Auth guard — proves requireSession middleware actually rejects
  // unauthenticated traffic. Without this assertion, a regression that
  // disabled the middleware would silently pass every other test in this
  // file (they all send a session cookie).
  // -------------------------------------------------------------------------
  it('GET /api/todos without session returns 401', async () => {
    const res = await fetch(`${apiUrl}/api/todos`);
    expect(res.status).toBe(401);
  });
});
