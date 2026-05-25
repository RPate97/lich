/**
 * `lich urls` — print URLs for the current worktree's stack.
 *
 * Two output modes:
 *
 *   Default (Plan 5+): friendly URLs that route through the per-machine
 *     reverse proxy daemon. One line per `routing` entry in the snapshot,
 *     formatted as `<service>[ (<key>)]: http://<hostname>.lich.localhost:<proxy-port>/`.
 *     This is what humans want — stable, memorable, works across worktrees
 *     without port-juggling.
 *
 *   `--raw` (Plan 1 behavior, kept as the escape hatch): direct upstream
 *     URLs of the form `<service>[.<key>]: http://127.0.0.1:<port>`. For
 *     users who can't or don't want to use `*.lich.localhost` (e.g. they
 *     have a corporate DNS or VPN that shadows it, or they need to point a
 *     tool at the raw port like a debugger or non-HTTP client).
 *
 * Both modes:
 *   - Read the per-worktree state snapshot.
 *   - If no stack exists for this worktree, emit a clear stderr error and
 *     exit 1.
 *
 * Empty-routing handling:
 *   - Default mode: if the snapshot has no routing entries (legacy
 *     pre-Plan-5 snapshot OR no services declared ports), print a helpful
 *     hint pointing the user at `lich up`.
 *   - `--raw` mode: if no service has allocated ports, print
 *     `(no ports allocated)` (the Plan 1 behavior) — keeping `--raw` a
 *     direct, drop-in replacement for what scripts may already depend on.
 *
 * This command intentionally does NOT verify the URLs are reachable — it
 * only reflects what's recorded in `state.json`. The e2e suite verifies
 * reachability by curling the printed URLs.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { detectWorktree } from "../worktree/detect.js";
import {
  readSnapshot,
  type RoutingEntry,
  type ServiceSnapshot,
} from "../state/snapshot.js";
import { parseConfig } from "../config/parse.js";

export interface RunUrlsInput {
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Defaults to `process.stdout`. */
  out?: NodeJS.WritableStream;
  /** Defaults to `process.stderr`. */
  err?: NodeJS.WritableStream;
  /**
   * When true, print direct upstream URLs (`http://127.0.0.1:<port>`)
   * instead of the friendly proxied URLs. The Plan 1 default behavior is
   * kept under this flag as an escape hatch for users who can't use
   * `*.lich.localhost`. See module-level JSDoc.
   */
  raw?: boolean;
}

export interface RunUrlsResult {
  exitCode: number;
}

/**
 * Default proxy port for friendly URLs. The lich daemon binds 3300 by
 * default (see `daemon/daemon.ts`). When the user's `lich.yaml` declares
 * `runtime.proxy_port`, that value wins; otherwise we fall back to this
 * constant. Task 30 may centralize this in a shared config helper — for
 * now the constant is fine, and the only readers are this command and
 * the daemon itself.
 */
const DEFAULT_PROXY_PORT = 3300;

/**
 * Print URL lines for the current worktree's stack. Default emits
 * friendly proxied URLs; `--raw` falls back to direct upstream URLs.
 */
export async function runUrls(input: RunUrlsInput = {}): Promise<RunUrlsResult> {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const raw = Boolean(input.raw);

  // ---- locate the worktree's stack ---------------------------------------
  // detectWorktree throws if there's no lich.yaml above cwd. That's a
  // distinct failure mode from "lich.yaml exists but no stack is running"
  // — both should land the user in the same "run lich up first" mental
  // model, so we collapse them into the same exit-1 message.
  let stackId: string;
  let worktreePath: string;
  try {
    const wt = detectWorktree(cwd);
    stackId = wt.stack_id;
    worktreePath = wt.path;
  } catch {
    err.write("no stack found for this worktree (run lich up first)\n");
    return { exitCode: 1 };
  }

  const snapshot = await readSnapshot(stackId);
  if (!snapshot) {
    err.write("no stack found for this worktree (run lich up first)\n");
    return { exitCode: 1 };
  }

  // ---- --raw: emit direct upstream URLs (Plan 1 behavior) ----------------
  if (raw) {
    const lines: string[] = [];
    for (const svc of snapshot.services) {
      appendRawServiceLines(svc, lines);
    }

    if (lines.length === 0) {
      out.write("(no ports allocated)\n");
      return { exitCode: 0 };
    }

    for (const line of lines) {
      out.write(line + "\n");
    }
    return { exitCode: 0 };
  }

  // ---- default: emit friendly URLs from the routing table -----------------
  // The snapshot's `routing` field is populated by `lich up` once a stack
  // is ready (Plan 5 Task 8). Each entry carries the friendly hostname
  // (e.g. `api.feature-x` or `supabase-api.feature-x`) and the upstream
  // URL the proxy forwards to. We don't use the upstream URL here — we
  // just need the hostname + service to format the user-facing string.
  const routing = snapshot.routing;
  if (!routing || routing.length === 0) {
    // No routing entries can happen in two ways:
    //   1. The snapshot is pre-Plan-5 (field never set).
    //   2. The stack is up but no service declared a port (so no proxy
    //      routes were ever computed).
    // Both warrant the same hint: either re-run up to get fresh routing,
    // or you actually have no portful services. Either way, friendly URLs
    // aren't available; suggest --raw as the escape hatch isn't needed
    // here (there's nothing to print either way).
    out.write(
      "No routing entries — run `lich up` first, or services have no ports declared.\n",
    );
    return { exitCode: 0 };
  }

  // Resolve the proxy port. Best-effort: if the yaml has been deleted or
  // can't be parsed, silently fall back to the default. `lich urls` should
  // be robust — the user's workflow shouldn't break when state still
  // exists but the config is in flux.
  const proxyPort = await resolveProxyPort(worktreePath);

  for (const entry of routing) {
    out.write(formatFriendlyLine(entry, proxyPort) + "\n");
  }
  return { exitCode: 0 };
}

/**
 * Resolve the proxy port for friendly URL output. Reads
 * `config.runtime.proxy_port` from the worktree's `lich.yaml`; falls back
 * silently to {@link DEFAULT_PROXY_PORT} if the yaml is missing, fails to
 * parse, or doesn't declare a custom port.
 *
 * Best-effort by design: this command exists to tell the user where their
 * stack is reachable, and a transient yaml problem shouldn't block that.
 * The actual proxy port the daemon listens on is the source of truth at
 * request time — this just produces the URL string we display.
 */
async function resolveProxyPort(worktreePath: string): Promise<number> {
  const yamlPath = join(worktreePath, "lich.yaml");
  if (!existsSync(yamlPath)) return DEFAULT_PROXY_PORT;
  try {
    const parsed = await parseConfig(yamlPath);
    if (!parsed.ok) return DEFAULT_PROXY_PORT;
    return parsed.config.runtime?.proxy_port ?? DEFAULT_PROXY_PORT;
  } catch {
    return DEFAULT_PROXY_PORT;
  }
}

/**
 * Format one friendly URL line for a routing entry.
 *
 * The display logic peels the per-port key (if any) back out of the
 * hostname so single-port services print without the redundant key.
 * Hostname conventions (set by `up.ts#buildRoutingEntries`):
 *   - Single port: `<service>.<worktree>` → `<service>: http://...`
 *   - Multi-port:  `<service>-<key>.<worktree>` → `<service> (<key>): http://...`
 *
 * Detection: if the hostname starts with `<service>-`, everything between
 * that and the first `.` is the port key. If it starts with `<service>.`
 * (no dash), it's single-port. We avoid splitting on `.` because the
 * worktree name itself is `[a-z0-9-]+` and may contain dashes — splitting
 * on dashes would over-eagerly chop the worktree name.
 *
 * Defensive fallback: if neither prefix matches (shouldn't happen for any
 * entry we wrote, but possible if a future writer reshapes the hostname),
 * print the raw hostname without trying to derive a key. Better to show
 * something than to throw.
 */
function formatFriendlyLine(entry: RoutingEntry, proxyPort: number): string {
  const url = `http://${entry.hostname}.lich.localhost:${proxyPort}/`;
  const dashPrefix = `${entry.service}-`;
  const dotPrefix = `${entry.service}.`;

  if (entry.hostname.startsWith(dashPrefix)) {
    // Multi-port: extract the key between the dash and the first dot.
    const afterPrefix = entry.hostname.slice(dashPrefix.length);
    const dotIdx = afterPrefix.indexOf(".");
    const key = dotIdx === -1 ? afterPrefix : afterPrefix.slice(0, dotIdx);
    return `${entry.service} (${key}): ${url}`;
  }
  if (entry.hostname.startsWith(dotPrefix)) {
    return `${entry.service}: ${url}`;
  }
  // Unexpected hostname shape — surface the entry as-is rather than
  // misattributing a key. Worst case the user sees a hostname they
  // recognize and the URL still works.
  return `${entry.service}: ${url}`;
}

/**
 * Append raw (`--raw` mode) URL lines for a single service. A service may
 * declare zero, one, or many logical ports; we print one line per
 * allocated entry.
 *
 * - 1 logical port: `<service>: http://127.0.0.1:<port>`
 * - N logical ports: `<service>.<key>: http://127.0.0.1:<port>` per entry
 *
 * The single-vs-multi distinction is based purely on the number of entries
 * in `allocated_ports`, NOT on the original config shape (`port:` vs
 * `ports:`). A multi-port service that happens to have only one allocated
 * port still prints in single-port form — the raw output is purely about
 * what's reachable on localhost.
 *
 * 127.0.0.1 rather than `localhost` to dodge Docker IPv6 hijack on macOS
 * (see commit 1c19912 / LEV-407). Friendly URLs use `.lich.localhost`
 * which Bun resolves correctly; raw URLs need the explicit IPv4 to be
 * useful for scripts that fetch them.
 */
function appendRawServiceLines(svc: ServiceSnapshot, lines: string[]): void {
  const allocated = svc.allocated_ports;
  if (!allocated) return;

  const entries = Object.entries(allocated);
  if (entries.length === 0) return;

  if (entries.length === 1) {
    const port = entries[0][1];
    lines.push(`${svc.name}: http://127.0.0.1:${port}`);
    return;
  }

  // Multi-port: one line per logical port, in declaration order of the
  // allocated_ports object (JSON object key order is insertion order, which
  // matches how the runner wrote it — typically the config's ports map).
  for (const [key, port] of entries) {
    lines.push(`${svc.name}.${key}: http://127.0.0.1:${port}`);
  }
}
