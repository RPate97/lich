import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../errors';
import { Registry, type StackEntry } from '../registry';
import { findWorktree } from '../worktree';
import { betterAuthAdapter } from '../adapters/auth/better-auth';
import { getOrCreateUser, loginAs } from '../auth/helpers';
import type { AuthAdapter, AuthContext } from '../adapters/auth/types';
import type { Command, CommandContext } from './types';

/**
 * Result shape returned by the curl command. Mirrors a (very small) subset of
 * `fetch` — enough for callers (humans and tests) to assert on status and body.
 *
 * `body` is the parsed JSON when the response advertises a JSON content-type
 * AND the body is parseable; otherwise it's the raw text. We never throw on
 * non-2xx — callers asked for the request, so they get the response.
 */
export interface CurlResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface MakeCurlCommandOptions {
  getRegistry: () => Registry;
  /** Auth adapter for `--as` mode. Defaults to `betterAuthAdapter`. */
  getAuthAdapter?: () => AuthAdapter;
  /**
   * Resolver for the AuthContext (databaseUrl/secret) when `--as` is used.
   * Defaults to an in-memory sqlite context — fine for tests, but production
   * usage will inject a context that points at the real auth database.
   */
  getAuthCtx?: () => AuthContext;
  /** Override `fetch` for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface ParsedRequest {
  method: string;
  path: string;
  body: string | undefined;
  headers: Record<string, string>;
  asEmail: string | undefined;
  urlOverride: string | undefined;
}

/**
 * Parse the command's args + flags into a coherent request. The CLI's
 * top-level argv parser only handles `--long` flags, so we walk `ctx.args`
 * ourselves to extract curl-style short flags (`-X`, `-d`, `-H`). The path
 * is the last positional left over.
 *
 * `-H` is repeatable; later occurrences override earlier ones by header name
 * (case-insensitive on the name). Long-form aliases (`--method`, `--data`,
 * `--header`) are honored via `ctx.flags` for callers that prefer them.
 */
function parseRequest(ctx: CommandContext): ParsedRequest {
  let method = 'GET';
  let body: string | undefined;
  const headerMap = new Map<string, { name: string; value: string }>(); // lower(name) -> entry
  const positional: string[] = [];

  // Pass 1: walk args for short flags.
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i]!;
    if (a === '-X' || a === '--method') {
      const next = ctx.args[i + 1];
      if (next === undefined) {
        throw new CLIError(
          'CONFIG_INVALID',
          `${a} requires a value`,
          'usage: levelzero curl [-X METHOD] [-d body] [-H "Header: value"] <path>',
        );
      }
      method = next.toUpperCase();
      i++;
    } else if (a === '-d' || a === '--data') {
      const next = ctx.args[i + 1];
      if (next === undefined) {
        throw new CLIError(
          'CONFIG_INVALID',
          `${a} requires a value`,
          'usage: levelzero curl [-d body] <path>',
        );
      }
      body = next;
      i++;
    } else if (a === '-H' || a === '--header') {
      const next = ctx.args[i + 1];
      if (next === undefined) {
        throw new CLIError(
          'CONFIG_INVALID',
          `${a} requires a value`,
          'usage: levelzero curl [-H "Header: value"] <path>',
        );
      }
      const colon = next.indexOf(':');
      if (colon < 0) {
        throw new CLIError(
          'CONFIG_INVALID',
          `invalid header (missing colon): ${JSON.stringify(next)}`,
          'use the form "Header-Name: value"',
        );
      }
      const name = next.slice(0, colon).trim();
      const value = next.slice(colon + 1).trim();
      if (name.length === 0) {
        throw new CLIError(
          'CONFIG_INVALID',
          `invalid header (empty name): ${JSON.stringify(next)}`,
          'use the form "Header-Name: value"',
        );
      }
      headerMap.set(name.toLowerCase(), { name, value });
      i++;
    } else {
      positional.push(a);
    }
  }

  // Pass 2: honor long flags from ctx.flags. The CLI parser collapses repeats,
  // so `--header` here is single-shot — primarily a convenience for callers
  // that already have a flag-map (tests, programmatic use).
  const flagMethod = ctx.flags['method'];
  if (typeof flagMethod === 'string') method = flagMethod.toUpperCase();
  const flagData = ctx.flags['data'];
  if (typeof flagData === 'string') body = flagData;
  const flagHeader = ctx.flags['header'];
  if (typeof flagHeader === 'string') {
    const colon = flagHeader.indexOf(':');
    if (colon > 0) {
      const name = flagHeader.slice(0, colon).trim();
      const value = flagHeader.slice(colon + 1).trim();
      if (name.length > 0) headerMap.set(name.toLowerCase(), { name, value });
    }
  }
  const flagAs = ctx.flags['as'];
  const asEmail = typeof flagAs === 'string' && flagAs.length > 0 ? flagAs : undefined;
  const flagUrl = ctx.flags['url'];
  const urlOverride = typeof flagUrl === 'string' && flagUrl.length > 0 ? flagUrl : undefined;

  if (positional.length === 0) {
    throw new CLIError(
      'CONFIG_INVALID',
      'curl requires a path argument',
      'usage: levelzero curl [--as <email>] [-X METHOD] [-d body] [-H "Header: value"] <path>',
    );
  }
  // If multiple positional args slipped through, the path is the last one —
  // matches curl's behavior and is forgiving when flag/value pairs land out of
  // order (e.g., `curl /foo -H "x: 1"` works the same as `-H "x: 1" /foo`).
  const path = positional[positional.length - 1]!;

  const headers: Record<string, string> = {};
  for (const { name, value } of headerMap.values()) {
    headers[name] = value;
  }

  return { method, path, body, headers, asEmail, urlOverride };
}

/**
 * Derive the api service's base URL for a stack entry. Mirrors
 * `apiService.envContributions` (services/builtins.ts) — keep these in lockstep.
 *
 * Order of preference:
 *   1. `entry.urls.api` — populated by `dev` after portless registration.
 *   2. `http://localhost:<entry.ports['api-http']>` — fallback for stacks that
 *      came up before portless or in environments where portless isn't
 *      available.
 */
function deriveApiUrl(entry: StackEntry): string | null {
  const portless = entry.urls['api'];
  if (typeof portless === 'string' && portless.length > 0) return portless;
  const port = entry.ports['api-http'];
  if (typeof port === 'number') return `http://localhost:${port}`;
  return null;
}

async function resolveBaseUrl(
  ctx: CommandContext,
  getRegistry: () => Registry,
  override: string | undefined,
): Promise<string> {
  if (override) return override.replace(/\/$/, '');
  const wt = await findWorktree(ctx.cwd);
  if (!wt) {
    throw new CLIError(
      'NO_PROJECT',
      'not inside a levelzero project',
      'run `levelzero init`, cd into a directory with levelzero.config.ts, or pass --url',
    );
  }
  const entry = await getRegistry().get(wt.key);
  if (!entry) {
    throw new CLIError(
      'NO_PROJECT',
      'no stack running for this worktree',
      'run `levelzero dev` first to bring the api service up, or pass --url',
    );
  }
  const apiUrl = deriveApiUrl(entry);
  if (!apiUrl) {
    throw new CLIError(
      'NO_PROJECT',
      'no api service URL could be derived from the current stack',
      'ensure the api service is part of the stack and `levelzero dev` has been run, or pass --url',
    );
  }
  return apiUrl.replace(/\/$/, '');
}

/**
 * Issue an HTTP request to `<API_URL><path>`, with optional authenticated
 * session when `--as <email>` is provided.
 *
 * Auth flow: getOrCreateUser → loginAs → fetch with
 * `Cookie: better-auth.session_token=<token>`. We never echo the session
 * token back to the caller — it's an internal detail of authenticated mode.
 */
export function makeCurlCommand(opts: MakeCurlCommandOptions): Command {
  const getRegistry = opts.getRegistry;
  const getAuthAdapter = opts.getAuthAdapter ?? (() => betterAuthAdapter);
  const getAuthCtx = opts.getAuthCtx ?? defaultAuthCtx;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    name: 'curl',
    describe: 'Issue an HTTP request to the api service, optionally as a user',
    async run(ctx) {
      const parsed = parseRequest(ctx);
      const baseUrl = await resolveBaseUrl(ctx, getRegistry, parsed.urlOverride);

      // Build headers, defaulting Content-Type to application/json when a
      // body is supplied and the caller hasn't already specified one.
      const headers: Record<string, string> = { ...parsed.headers };
      if (parsed.body !== undefined && !hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }

      // Authenticated mode: mint a session and attach it as a cookie.
      // Better Auth's default cookie name is `better-auth.session_token`;
      // any deviation here would silently break auth.
      if (parsed.asEmail) {
        const adapter = getAuthAdapter();
        const authCtx = getAuthCtx();
        // getOrCreateUser is also called by loginAs, but invoking it
        // explicitly first matches the documented behavior and surfaces
        // user-creation failures separately from session-signing ones.
        await getOrCreateUser({ adapter, ctx: authCtx, email: parsed.asEmail });
        const { sessionToken } = await loginAs({
          adapter,
          ctx: authCtx,
          email: parsed.asEmail,
        });
        headers['Cookie'] = `better-auth.session_token=${sessionToken}`;
      }

      const url = `${baseUrl}${parsed.path.startsWith('/') ? '' : '/'}${parsed.path}`;
      const init: RequestInit = {
        method: parsed.method,
        headers,
      };
      if (parsed.body !== undefined && parsed.method !== 'GET' && parsed.method !== 'HEAD') {
        init.body = parsed.body;
      }

      const response = await doFetch(url, init);
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      const rawText = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      let parsedBody: unknown = rawText;
      if (/json/i.test(contentType)) {
        try {
          parsedBody = JSON.parse(rawText);
        } catch {
          // Server claimed JSON but sent garbage — fall back to text rather
          // than throwing; the caller still gets the bytes.
          parsedBody = rawText;
        }
      } else if (rawText.length > 0) {
        // No JSON content-type: try parsing anyway in case the server forgot
        // to set it; on failure, leave as text.
        try {
          parsedBody = JSON.parse(rawText);
        } catch {
          parsedBody = rawText;
        }
      }

      const result: CurlResult = {
        status: response.status,
        headers: respHeaders,
        body: parsedBody,
      };
      return result;
    },
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return true;
  }
  return false;
}

function defaultRegistryPath(): string {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return join(home, '.levelzero', 'registry.json');
}

function defaultAuthCtx(): AuthContext {
  // In-memory SQLite is fine for ephemeral CLI sessions during plan 06/11.
  // A later plan will wire this to the running stack's auth database.
  return {
    databaseUrl: 'sqlite::memory:',
    secret: process.env['LEVELZERO_AUTH_SECRET'] ?? 'test-secret-32-chars-min-length-aaaa',
  };
}

/**
 * Default `curlCommand` instance that resolves the registry path from
 * `LEVELZERO_HOME` on each invocation. Exported alongside the factory so
 * imports that don't need DI get a working `Command` for free.
 */
export const curlCommand: Command = makeCurlCommand({
  getRegistry: () => new Registry(defaultRegistryPath()),
});
