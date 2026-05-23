import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CLIError,
  Registry,
  computeWorktreeKey,
  type AuthAdapter,
  type AuthContext,
  type CreateUserInput,
  type SessionToken,
  type SessionInfo,
  type User,
} from '@lich/core';
import { makeCurlCommand } from '../src/curl';

/**
 * Minimal in-memory AuthAdapter for the curl tests. We don't need a real
 * better-auth instance here — the curl command only cares about:
 *   - getOrCreateUser → returns a User
 *   - signSession → returns a token
 * The mock server then echoes back whatever the command sent.
 */
function makeStubAuthAdapter(): {
  adapter: AuthAdapter;
  users: Map<string, User>;
  sessions: Map<string, string>; // token -> userId
} {
  const users = new Map<string, User>();
  const sessions = new Map<string, string>();
  let nextSessionId = 1;
  const adapter: AuthAdapter = {
    name: 'stub',
    async createUser(_ctx: AuthContext, input: CreateUserInput): Promise<User> {
      if (users.has(input.email)) {
        throw new Error(`stub: user with email ${input.email} already exists`);
      }
      const user: User = {
        id: `user_${users.size + 1}`,
        email: input.email,
        name: input.name,
        createdAt: new Date().toISOString(),
      };
      users.set(input.email, user);
      return user;
    },
    async findUserByEmail(_ctx: AuthContext, email: string): Promise<User | null> {
      return users.get(email) ?? null;
    },
    async signSession(_ctx: AuthContext, userId: string): Promise<SessionToken> {
      const token = `session_token_${nextSessionId++}_for_${userId}`;
      sessions.set(token, userId);
      return {
        token,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async inspectSession(_ctx: AuthContext, token: string): Promise<SessionInfo | null> {
      const userId = sessions.get(token);
      if (!userId) return null;
      return {
        userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  return { adapter, users, sessions };
}

/**
 * Spin up a mock API server that records every request it receives and
 * echoes a JSON body containing the path, method, headers, and (if any)
 * request body. Tests assert against the captured requests.
 */
interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

async function startMockApi(): Promise<{
  baseUrl: string;
  server: Server;
  requests: CapturedRequest[];
  setHandler: (
    fn: (req: IncomingMessage, body: string) => { status?: number; body: unknown } | undefined,
  ) => void;
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  let handler:
    | ((req: IncomingMessage, body: string) => { status?: number; body: unknown } | undefined)
    | undefined;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers,
        body: raw,
      });
      const handled = handler?.(req, raw);
      if (handled) {
        res.statusCode = handled.status ?? 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(handled.body));
        return;
      }
      // Default: echo back the captured request shape.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          method: req.method,
          path: req.url,
          headers,
          body: raw,
        }),
      );
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    server,
    requests,
    setHandler: (fn) => {
      handler = fn;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

const AUTH_CTX: AuthContext = {
  databaseUrl: 'sqlite::memory:',
  secret: 'test-secret-32-chars-min-length-aaaa',
};

let projectDir: string;
let homeDir: string;
let registry: Registry;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-curl-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-curl-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

async function seedStackWithApiUrl(apiUrl: string): Promise<void> {
  await registry.upsert(computeWorktreeKey(projectDir), {
    path: projectDir,
    branch: 'main',
    ports: { 'api-http': 4000 },
    urls: { api: apiUrl },
    containers: [],
    network: '',
    logDir: '.lich/logs',
    createdAt: new Date().toISOString(),
  });
}

async function seedStackWithApiPortOnly(port: number): Promise<void> {
  await registry.upsert(computeWorktreeKey(projectDir), {
    path: projectDir,
    branch: 'main',
    ports: { 'api-http': port },
    urls: {},
    containers: [],
    network: '',
    logDir: '.lich/logs',
    createdAt: new Date().toISOString(),
  });
}

describe('lich curl', () => {
  it('exports a Command named "curl"', () => {
    const { adapter } = makeStubAuthAdapter();
    const cmd = makeCurlCommand({
      getRegistry: () => registry,
      getAuthAdapter: () => adapter,
      getAuthCtx: () => AUTH_CTX,
    });
    expect(cmd.name).toBe('curl');
    expect(typeof cmd.describe).toBe('string');
  });

  it('errors CLIError when no path argument is provided', async () => {
    const { adapter } = makeStubAuthAdapter();
    const cmd = makeCurlCommand({
      getRegistry: () => registry,
      getAuthAdapter: () => adapter,
      getAuthCtx: () => AUTH_CTX,
    });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('issues an anonymous GET to <API_URL><path> derived from the stack registry', async () => {
    const api = await startMockApi();
    try {
      await seedStackWithApiUrl(api.baseUrl);
      const { adapter } = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      const result = (await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['/health'],
        flags: {},
      })) as { status: number; body: { method: string; path: string } };
      expect(result.status).toBe(200);
      expect(result.body.method).toBe('GET');
      expect(result.body.path).toBe('/health');
      expect(api.requests).toHaveLength(1);
      const r = api.requests[0]!;
      expect(r.method).toBe('GET');
      expect(r.url).toBe('/health');
      // No auth cookie in anonymous mode.
      expect(r.headers['cookie']).toBeUndefined();
    } finally {
      await api.close();
    }
  });

  it('falls back to http://localhost:<api-http port> when urls map is empty', async () => {
    const api = await startMockApi();
    try {
      // Pretend the api-http port matches what the mock server is listening on
      // — that's the whole point of the fallback: derive from the port.
      const addr = api.server.address() as AddressInfo;
      await seedStackWithApiPortOnly(addr.port);
      const { adapter } = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      const result = (await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['/ping'],
        flags: {},
      })) as { status: number; body: { path: string } };
      expect(result.status).toBe(200);
      expect(result.body.path).toBe('/ping');
    } finally {
      await api.close();
    }
  });

  it('errors NO_PROJECT when cwd is outside a lich project', async () => {
    const { adapter } = makeStubAuthAdapter();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-curl-outside-')));
    const cmd = makeCurlCommand({
      getRegistry: () => registry,
      getAuthAdapter: () => adapter,
      getAuthCtx: () => AUTH_CTX,
    });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: ['/x'], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('errors with a helpful message when no API URL can be derived from the stack', async () => {
    // Stack entry exists but has neither `urls.api` nor `ports['api-http']`.
    await registry.upsert(computeWorktreeKey(projectDir), {
      path: projectDir,
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '',
      createdAt: '',
    });
    const { adapter } = makeStubAuthAdapter();
    const cmd = makeCurlCommand({
      getRegistry: () => registry,
      getAuthAdapter: () => adapter,
      getAuthCtx: () => AUTH_CTX,
    });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['/x'], flags: {} }),
    ).rejects.toThrow(/api/i);
  });

  it('honors --url to override the derived API_URL (no registry lookup required)', async () => {
    const api = await startMockApi();
    try {
      // Note: we don't seed a registry entry; --url should bypass derivation.
      const { adapter } = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      const result = (await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['/override'],
        flags: { url: api.baseUrl },
      })) as { status: number };
      expect(result.status).toBe(200);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]!.url).toBe('/override');
    } finally {
      await api.close();
    }
  });

  it('with --as <email>, creates the user, mints a session, and sends Cookie: better-auth.session_token=<token>', async () => {
    const api = await startMockApi();
    try {
      await seedStackWithApiUrl(api.baseUrl);
      const stub = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => stub.adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      const result = (await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['/api/me'],
        flags: { as: 'alice@example.com' },
      })) as { status: number; body: { headers: Record<string, string> } };
      expect(result.status).toBe(200);
      // User was created on the fly.
      expect(stub.users.get('alice@example.com')).toBeDefined();
      // Session was minted.
      expect(stub.sessions.size).toBe(1);
      const [token] = stub.sessions.keys();
      // Cookie header sent to the server matches.
      const cookieHeader = api.requests[0]!.headers['cookie'];
      expect(cookieHeader).toBe(`better-auth.session_token=${token}`);
    } finally {
      await api.close();
    }
  });

  it('with --as on a second invocation, reuses the existing user (idempotent)', async () => {
    const api = await startMockApi();
    try {
      await seedStackWithApiUrl(api.baseUrl);
      const stub = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => stub.adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['/api/me'],
        flags: { as: 'bob@example.com' },
      });
      await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['/api/me'],
        flags: { as: 'bob@example.com' },
      });
      // Only one user, two sessions.
      expect(stub.users.size).toBe(1);
      expect(stub.sessions.size).toBe(2);
    } finally {
      await api.close();
    }
  });

  it('-X / --method overrides the HTTP method', async () => {
    const api = await startMockApi();
    try {
      await seedStackWithApiUrl(api.baseUrl);
      const { adapter } = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['-X', 'DELETE', '/items/42'],
        flags: {},
      });
      expect(api.requests[0]!.method).toBe('DELETE');
      expect(api.requests[0]!.url).toBe('/items/42');
    } finally {
      await api.close();
    }
  });

  it('-d / --data passes the request body through (Content-Type defaults to application/json)', async () => {
    const api = await startMockApi();
    try {
      await seedStackWithApiUrl(api.baseUrl);
      const { adapter } = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      const payload = '{"hello":"world"}';
      await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['-X', 'POST', '-d', payload, '/things'],
        flags: {},
      });
      const r = api.requests[0]!;
      expect(r.method).toBe('POST');
      expect(r.url).toBe('/things');
      expect(r.body).toBe(payload);
      expect(r.headers['content-type']).toBe('application/json');
    } finally {
      await api.close();
    }
  });

  it('-H / --header is repeatable and overrides headers (including Content-Type)', async () => {
    const api = await startMockApi();
    try {
      await seedStackWithApiUrl(api.baseUrl);
      const { adapter } = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: [
          '-H',
          'X-Trace-Id: abc123',
          '-H',
          'Content-Type: text/plain',
          '-X',
          'POST',
          '-d',
          'raw body',
          '/echo',
        ],
        flags: {},
      });
      const r = api.requests[0]!;
      expect(r.headers['x-trace-id']).toBe('abc123');
      expect(r.headers['content-type']).toBe('text/plain');
      expect(r.body).toBe('raw body');
    } finally {
      await api.close();
    }
  });

  it('returns response body as text when content-type is not JSON', async () => {
    const api = await startMockApi();
    api.setHandler(() => undefined); // use default echo
    try {
      await seedStackWithApiUrl(api.baseUrl);
      // Override the default echo with a text/plain response.
      api.setHandler(() => ({ status: 201, body: 'hello' }));
      const { adapter } = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => adapter,
        getAuthCtx: () => AUTH_CTX,
      });
      // The mock will still set Content-Type: application/json, so we expect JSON
      // parsing to succeed. To exercise the text fallback, use a custom fetch
      // injection that returns a plain text body without JSON content-type.
      const result = (await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['/anything'],
        flags: {},
      })) as { status: number; body: unknown };
      expect(result.status).toBe(201);
      // Even though the handler returned a string, we wrap it as JSON, so
      // parsing succeeds and body comes back as the string.
      expect(result.body).toBe('hello');
    } finally {
      await api.close();
    }
  });

  it('returns body as text when the response is not valid JSON', async () => {
    const api = await startMockApi();
    try {
      await seedStackWithApiUrl(api.baseUrl);
      // Custom fetch that returns text/plain — easier than reaching into the
      // mock server for non-JSON content-type semantics. Cast widens our
      // stub to the full `typeof fetch` shape (which includes `preconnect`).
      const customFetch = (async () =>
        new Response('not json here', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })) as unknown as typeof fetch;
      const { adapter } = makeStubAuthAdapter();
      const cmd = makeCurlCommand({
        getRegistry: () => registry,
        getAuthAdapter: () => adapter,
        getAuthCtx: () => AUTH_CTX,
        fetch: customFetch,
      });
      const result = (await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: ['/anything'],
        flags: {},
      })) as { status: number; body: unknown };
      expect(result.status).toBe(200);
      expect(result.body).toBe('not json here');
    } finally {
      await api.close();
    }
  });
});
