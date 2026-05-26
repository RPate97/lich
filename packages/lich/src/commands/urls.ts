import { existsSync } from "node:fs";
import { join } from "node:path";

import { detectWorktree } from "../worktree/detect.js";
import { readSnapshot } from "../state/snapshot.js";
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

  if (raw) {
    const rawUrls = buildRawUrls(snapshot.services);
    if (rawUrls.length === 0) {
      out.write("(no ports allocated)\n");
      return { exitCode: 0 };
    }
    for (const url of rawUrls) {
      out.write(formatUrlLine(url, "raw") + "\n");
    }
    return { exitCode: 0 };
  }

  // ---- default: emit friendly URLs from the routing table -----------------
  // The snapshot's `routing` field is populated by `lich up` once a stack
  // is ready (Plan 5 Task 8). Each entry carries the friendly hostname
  // (e.g. `api.feature-x` or `supabase-api.feature-x`) and the upstream
  // URL the proxy forwards to.
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
  const friendlyUrls = buildFriendlyUrls(routing, proxyPort);

  for (const url of friendlyUrls) {
    out.write(formatUrlLine(url, "friendly") + "\n");
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

