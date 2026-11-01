import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";

import { defaultCachePath, isCacheStale, readCache } from "../version-check/cache.js";
import { runRefresh } from "../version-check/refresh.js";
import { compareVersions, isOutdated } from "../version-check/semver.js";

const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface RunUpdateInput {
  currentVersion: string;
  argv: string[];
  check: boolean;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  execPath: string;
}

export interface RunUpdateResult {
  exitCode: number;
}

export function detectInstallPrefix(execPath: string): string | null {
  if (basename(execPath) !== "lich") return null;
  const binDir = dirname(execPath);
  if (basename(binDir) !== "bin") return null;
  return dirname(binDir);
}

export function buildInstallEnv(opts: {
  prefix: string | null;
  version: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (opts.prefix) env.LICH_PREFIX = opts.prefix;
  if (opts.version !== "latest") env.LICH_VERSION = opts.version;
  return env;
}

export function buildInstallCommand(env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  const prefix = keys.map((k) => `${k}=${env[k]}`).join(" ");
  const tail = prefix.length > 0 ? `${prefix} bash` : "bash";
  return `curl -fsSL https://lich.sh/install.sh | ${tail}`;
}

export async function runUpdate(input: RunUpdateInput): Promise<RunUpdateResult> {
  if (input.check) {
    return doCheck(input);
  }

  const prefix = detectInstallPrefix(input.execPath);
  const version = input.argv[0] ?? "latest";
  const installEnv = buildInstallEnv({ prefix, version });
  const command = buildInstallCommand(installEnv);

  if (input.dryRun) {
    input.stdout.write(`${command}\n`);
    return { exitCode: 0 };
  }

  input.stdout.write(
    `lich update: upgrading ${input.currentVersion} → ${version === "latest" ? "latest" : version}\n`,
  );
  return execInstall(command, installEnv);
}

async function doCheck(input: RunUpdateInput): Promise<RunUpdateResult> {
  const cachePath = defaultCachePath(input.env);
  let cache = readCache(cachePath);
  const refreshDisabled = envTruthy(input.env.LICH_UPDATE_CHECK_NO_REFRESH);

  if (!refreshDisabled && (cache === null || isCacheStale(cache, CACHE_MAX_AGE_MS, Date.now()))) {
    await runRefresh({ cachePath });
    cache = readCache(cachePath);
  }

  if (cache === null) {
    input.stderr.write("lich update: could not resolve latest version (no cache yet)\n");
    return { exitCode: 1 };
  }

  const label = describeStatus(input.currentVersion, cache.latest_version);
  input.stdout.write(
    `current: ${input.currentVersion}\nlatest:  ${cache.latest_version}\n${label}\n`,
  );
  return { exitCode: 0 };
}

function describeStatus(current: string, latest: string): string {
  if (isOutdated(current, latest)) return "status:  out of date — run `lich update` to upgrade.";
  const cmp = compareVersions(current, latest);
  if (cmp === null) return "status:  version comparison unavailable";
  if (cmp === 0) return "status:  up to date";
  return "status:  ahead of latest (dev build?)";
}

function execInstall(
  command: string,
  env: Record<string, string>,
): Promise<RunUpdateResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve({ exitCode: code ?? 1 }));
    child.on("error", () => resolve({ exitCode: 1 }));
  });
}

function envTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
