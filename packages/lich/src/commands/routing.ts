/**
 * `lich routing` — print the daemon's in-memory routing table (LEV-480).
 *
 * Reads the daemon's `daemon.url` (the dashboard URL), fetches
 * `GET /api/routing`, and pretty-prints the result as a 2-column table:
 *
 *   $ lich routing
 *   host                                  → upstream
 *   api.dogfood-stack.lich.localhost      → http://127.0.0.1:9020
 *   postgres.dogfood-stack.lich.localhost → http://127.0.0.1:9023
 *   web.dogfood-stack.lich.localhost      → http://127.0.0.1:9028
 *
 * Why a debug command? The original LEV-480 bug took an agent ~hours
 * to diagnose because the proxy returns a useful 404 body but there's
 * no first-class way to see the *full* in-memory routing table. This
 * command surfaces it directly so future routing puzzles take minutes.
 *
 * Failure modes:
 *
 *   - Daemon not running (`daemon.url` missing) → exit 1 with a hint
 *     to run `lich up` first.
 *   - Daemon URL present but not reachable → exit 1 with the underlying
 *     transport error.
 *   - Daemon doesn't expose `/api/routing` (older build) → exit 1 with
 *     the 503 message.
 *   - Routing table empty → exit 0, print "no routes" so the user
 *     knows the daemon is healthy but has nothing to serve.
 *
 * `--json` switches to a JSON Array dump for scripting use.
 */

import { readDaemonUrl } from "../daemon/pid-file.js";

/**
 * Input to {@link runRouting}.
 */
export interface RunRoutingInput {
  /**
   * When true, emit JSON to stdout instead of the pretty table. Useful
   * for scripts (`lich routing --json | jq .`).
   */
  json?: boolean;
  /**
   * Output stream. Defaults to `process.stdout`. Tests pass a capture
   * stream.
   */
  out?: NodeJS.WritableStream;
  /**
   * Error stream. Defaults to `process.stderr`. Tests pass a capture
   * stream.
   */
  err?: NodeJS.WritableStream;
}

/**
 * Result returned to the router.
 */
export interface RunRoutingResult {
  exitCode: number;
}

/**
 * Wire-format shape of `/api/routing`. Matches what
 * `daemon/proxy/routing.ts`'s `RoutingTable.list()` returns.
 */
interface RoutingEntry {
  hostname: string;
  upstream_url: string;
}

/**
 * Run `lich routing`. See module JSDoc for the full surface.
 */
export async function runRouting(
  input: RunRoutingInput = {},
): Promise<RunRoutingResult> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  // ---- 1. Resolve the daemon URL ------------------------------------------
  // The daemon writes its dashboard URL to `<LICH_HOME>/daemon.url` once
  // `Bun.serve` has bound. If the file is missing, no daemon is alive for
  // this LICH_HOME — tell the user to run `lich up`.
  let dashboardUrl: string | null;
  try {
    dashboardUrl = await readDaemonUrl();
  } catch (e) {
    err.write(`lich routing: failed to read daemon URL: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }

  if (dashboardUrl === null) {
    err.write(
      `lich routing: no daemon is running for this LICH_HOME ` +
        `(run \`lich up\` to start one)\n`,
    );
    return { exitCode: 1 };
  }

  // ---- 2. Fetch /api/routing ----------------------------------------------
  const url = `${dashboardUrl.replace(/\/$/, "")}/api/routing`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    err.write(
      `lich routing: failed to reach daemon at ${url}: ${(e as Error).message}\n`,
    );
    return { exitCode: 1 };
  }

  if (res.status === 503) {
    // The daemon is alive but doesn't expose the routing endpoint —
    // possible if running an older daemon binary or a test fixture.
    const body = await res.text().catch(() => "");
    err.write(
      `lich routing: daemon does not expose /api/routing ` +
        `(rebuild the daemon binary?)\n` +
        (body ? `  detail: ${body}\n` : ""),
    );
    return { exitCode: 1 };
  }

  if (res.status !== 200) {
    const body = await res.text().catch(() => "");
    err.write(
      `lich routing: GET /api/routing returned ${res.status}\n` +
        (body ? `  body: ${body}\n` : ""),
    );
    return { exitCode: 1 };
  }

  let entries: RoutingEntry[];
  try {
    entries = (await res.json()) as RoutingEntry[];
  } catch (e) {
    err.write(
      `lich routing: failed to parse /api/routing response: ${(e as Error).message}\n`,
    );
    return { exitCode: 1 };
  }

  // ---- 3. Render -----------------------------------------------------------
  if (input.json) {
    out.write(JSON.stringify(entries, null, 2) + "\n");
    return { exitCode: 0 };
  }

  if (entries.length === 0) {
    out.write("no routes\n");
    out.write(
      "(the daemon is running but has no routing entries — run `lich up` in a worktree)\n",
    );
    return { exitCode: 0 };
  }

  // Pretty table: pad hostnames to the longest entry so the arrows line up.
  // We add ".lich.localhost" to the rendered hostname so the user sees the
  // full URL — internal routing keys omit the suffix because the proxy
  // strips it before lookup.
  const SUFFIX = ".lich.localhost";
  const rendered = entries.map((e) => ({
    full: `${e.hostname}${SUFFIX}`,
    upstream: e.upstream_url,
  }));
  const hostHeader = "host";
  const maxHostLen = Math.max(
    hostHeader.length,
    ...rendered.map((r) => r.full.length),
  );

  out.write(`${hostHeader.padEnd(maxHostLen)} → upstream\n`);
  for (const r of rendered) {
    out.write(`${r.full.padEnd(maxHostLen)} → ${r.upstream}\n`);
  }
  return { exitCode: 0 };
}
