import { existsSync } from "node:fs";
import { join } from "node:path";

import { readSnapshot } from "../state/snapshot.js";
import { resolveStackId } from "../state/resolve-stack.js";
import { readDaemonProxyPort } from "../daemon/pid-file.js";
import { parseConfig } from "../config/parse.js";
import {
  DEFAULT_PROXY_PORT,
  buildFriendlyUrls,
  buildRawUrls,
  formatUrlLine,
} from "../urls/format.js";

export interface RunUrlsInput {
  cwd?: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  raw?: boolean;
  /** Stack ID or worktree name (`--worktree`); defaults to cwd-derived. */
  worktreeArg?: string;
}

export interface RunUrlsResult {
  exitCode: number;
}

export async function runUrls(input: RunUrlsInput = {}): Promise<RunUrlsResult> {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const raw = Boolean(input.raw);

  let stackId: string;
  let snapshot;
  try {
    const resolved = await resolveStackId({
      cwd,
      ...(input.worktreeArg !== undefined && { worktreeArg: input.worktreeArg }),
    });
    stackId = resolved.stackId;
    snapshot = resolved.snapshot ?? (await readSnapshot(stackId));
  } catch (e) {
    // Cwd-detect failure → legacy "no stack found" hint; --worktree failure
    // → resolver's specific "ID/name X not found" message.
    if (input.worktreeArg) {
      err.write(`${(e as Error).message}\n`);
    } else {
      err.write("no stack found for this worktree (run lich up first)\n");
    }
    return { exitCode: 1 };
  }

  if (!snapshot) {
    err.write("no stack found for this worktree (run lich up first)\n");
    return { exitCode: 1 };
  }
  // Bind to a const so the `finish` closure below keeps the non-null narrowing
  // (`let` narrowing does not flow into closures).
  const snap = snapshot;
  const worktreePath = snap.worktree_path;

  // `lich urls` doubles as a liveness check in scripts. A snapshot persists
  // after `lich down` (status "stopped"/"failed"/…) and its ports may since
  // have been reused by another worktree, so a non-"up" stack must not report
  // success — otherwise callers route commands at stale/foreign ports. Still
  // print what we have (useful for humans), but warn and exit non-zero.
  const finish = (): RunUrlsResult => {
    if (snap.status !== "up") {
      err.write(
        `stack is ${snap.status}, not up — these URLs may be stale (run \`lich up\`)\n`,
      );
      return { exitCode: 1 };
    }
    return { exitCode: 0 };
  };

  if (raw) {
    const rawUrls = buildRawUrls(snap.services);
    if (rawUrls.length === 0) {
      out.write("(no ports allocated)\n");
      return finish();
    }
    for (const url of rawUrls) {
      out.write(formatUrlLine(url, "raw") + "\n");
    }
    return finish();
  }

  const routing = snap.routing;
  if (!routing || routing.length === 0) {
    out.write(
      "No routing entries — run `lich up` first, or services have no ports declared.\n",
    );
    return finish();
  }

  const proxyPort = await resolveProxyPort(worktreePath);
  const friendlyUrls = buildFriendlyUrls(routing, proxyPort);

  for (const url of friendlyUrls) {
    out.write(formatUrlLine(url, "friendly") + "\n");
  }
  return finish();
}

/**
 * Best-effort proxy-port resolution. The daemon's actually-bound port
 * (`daemon.proxy-url`) wins — it binds `runtime.proxy_port` when free but
 * falls back to an OS-assigned port on EADDRINUSE, so advertising the
 * configured/default port alone points users at a dead port. Falls back to
 * the yaml's `runtime.proxy_port`, then the default, when no daemon is up.
 */
async function resolveProxyPort(worktreePath: string): Promise<number> {
  const daemonPort = await readDaemonProxyPort().catch(() => null);
  if (daemonPort !== null) return daemonPort;

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

