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

  const routing = snapshot.routing;
  if (!routing || routing.length === 0) {
    out.write(
      "No routing entries — run `lich up` first, or services have no ports declared.\n",
    );
    return { exitCode: 0 };
  }

  const proxyPort = await resolveProxyPort(worktreePath);
  const friendlyUrls = buildFriendlyUrls(routing, proxyPort);

  for (const url of friendlyUrls) {
    out.write(formatUrlLine(url, "friendly") + "\n");
  }
  return { exitCode: 0 };
}

/** Best-effort proxy-port resolution from yaml; falls back to default on any problem. */
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

