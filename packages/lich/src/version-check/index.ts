import { spawn } from "node:child_process";

import { defaultCachePath, isCacheStale, readCache } from "./cache.js";
import { formatNotice } from "./notice.js";
import { isOutdated } from "./semver.js";
import { shouldSuppressNotice } from "./suppress.js";

export { runRefresh } from "./refresh.js";

const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface RunVersionCheckInput {
  currentVersion: string;
  argv: {
    _: unknown[];
    json?: boolean;
    quiet?: boolean;
    version?: boolean;
  };
  env: NodeJS.ProcessEnv;
  commandName: string | undefined;
  stderr?: NodeJS.WritableStream;
  nowMs?: number;
  execPath?: string;
}

export function runVersionCheck(input: RunVersionCheckInput): void {
  if (shouldSuppressNotice({ argv: input.argv, env: input.env, commandName: input.commandName })) {
    return;
  }

  const cachePath = defaultCachePath(input.env);
  const cache = readCache(cachePath);
  const stderr = input.stderr ?? process.stderr;
  const nowMs = input.nowMs ?? Date.now();

  if (cache !== null && isOutdated(input.currentVersion, cache.latest_version)) {
    stderr.write(formatNotice(input.currentVersion, cache.latest_version));
  }

  const refreshDisabled = envTruthy(input.env.LICH_UPDATE_CHECK_NO_REFRESH);
  if (!refreshDisabled && (cache === null || isCacheStale(cache, CACHE_MAX_AGE_MS, nowMs))) {
    spawnBackgroundRefresh(cachePath, input.env, input.execPath ?? process.execPath);
  }
}

function spawnBackgroundRefresh(
  cachePath: string,
  env: NodeJS.ProcessEnv,
  execPath: string,
): void {
  try {
    const child = spawn(execPath, ["__update-check-refresh", `--cache=${cachePath}`], {
      detached: true,
      stdio: "ignore",
      env: { ...env },
    });
    child.unref();
  } catch {
    // best-effort
  }
}

function envTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
