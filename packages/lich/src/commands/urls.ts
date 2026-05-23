/**
 * `lich urls` — print raw `http://localhost:<port>` URLs for the current
 * worktree's stack.
 *
 * Plan 1 scope (per spec section 5):
 *   - Reads the per-worktree state snapshot to learn which services are
 *     allocated which host ports.
 *   - Prints one line per allocated port. Single-port services print
 *     `<service>: http://localhost:<port>`. Multi-port services print
 *     `<service>.<port-key>: http://localhost:<port>` — one line per
 *     logical port.
 *   - If no stack exists for this worktree: emits a clear error to stderr
 *     and exits 1.
 *   - If a stack exists but nothing is port-allocated: emits
 *     `(no ports allocated)` on stdout and exits 0.
 *
 * Friendly URLs (`<service>.<worktree>.lich.localhost:3300`) and the
 * `--raw` flag that toggles between friendly and raw output land in
 * Plan 5 when the reverse proxy comes online. Plan 1 prints raw URLs
 * unconditionally.
 *
 * This command intentionally does NOT verify that the URLs are reachable
 * — it only reflects what's recorded in `state.json`. The e2e suite
 * verifies reachability by curling the printed URLs.
 */

import { detectWorktree } from "../worktree/detect.js";
import { readSnapshot, type ServiceSnapshot } from "../state/snapshot.js";

export interface RunUrlsInput {
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Defaults to `process.stdout`. */
  out?: NodeJS.WritableStream;
  /** Defaults to `process.stderr`. */
  err?: NodeJS.WritableStream;
}

export interface RunUrlsResult {
  exitCode: number;
}

/**
 * Print one `<service>[.<key>]: http://localhost:<port>` line per
 * allocated host port for the current worktree's stack.
 */
export async function runUrls(input: RunUrlsInput = {}): Promise<RunUrlsResult> {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  // ---- locate the worktree's stack ---------------------------------------
  // detectWorktree throws if there's no lich.yaml above cwd. That's a
  // distinct failure mode from "lich.yaml exists but no stack is running"
  // — both should land the user in the same "run lich up first" mental
  // model, so we collapse them into the same exit-1 message.
  let stackId: string;
  try {
    stackId = detectWorktree(cwd).stack_id;
  } catch {
    err.write("no stack found for this worktree (run lich up first)\n");
    return { exitCode: 1 };
  }

  const snapshot = await readSnapshot(stackId);
  if (!snapshot) {
    err.write("no stack found for this worktree (run lich up first)\n");
    return { exitCode: 1 };
  }

  // ---- emit URL lines -----------------------------------------------------
  // Preserve the service declaration order from state.json (which itself
  // reflects the order writeSnapshot was called with — typically the
  // declared service order in the resolved profile). This keeps output
  // stable across runs of the same stack and easier to scan visually.
  const lines: string[] = [];
  for (const svc of snapshot.services) {
    appendServiceLines(svc, lines);
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

/**
 * Append the URL lines for a single service. A service may declare zero,
 * one, or many logical ports; we print one line per allocated entry.
 *
 * - 1 logical port: `<service>: http://localhost:<port>`
 * - N logical ports: `<service>.<key>: http://localhost:<port>` per entry
 *
 * The single-vs-multi distinction is based purely on the number of entries
 * in `allocated_ports`, NOT on the original config shape (`port:` vs
 * `ports:`). A multi-port service that happens to have only one allocated
 * port still prints in single-port form here — Plan 5 will revisit when
 * friendly URLs need to know the original key. For Plan 1 (raw URLs only),
 * the output is purely about what's reachable on localhost.
 */
function appendServiceLines(svc: ServiceSnapshot, lines: string[]): void {
  const allocated = svc.allocated_ports;
  if (!allocated) return;

  const entries = Object.entries(allocated);
  if (entries.length === 0) return;

  if (entries.length === 1) {
    const port = entries[0][1];
    lines.push(`${svc.name}: http://localhost:${port}`);
    return;
  }

  // Multi-port: one line per logical port, in declaration order of the
  // allocated_ports object (JSON object key order is insertion order, which
  // matches how the runner wrote it — typically the config's ports map).
  for (const [key, port] of entries) {
    lines.push(`${svc.name}.${key}: http://localhost:${port}`);
  }
}
