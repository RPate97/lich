import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { openInBrowser } from "./open-browser.js";
import {
  isDaemonAlive,
  readDaemonProxyUrl,
  readDaemonUrl,
} from "./pid-file.js";

export interface AutoStartOpts {
  lichHome?: string;
  proxyPort?: number;
  openBrowser?: boolean;
  out?: NodeJS.WritableStream;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface AutoStartResult {
  url: string;
  alreadyRunning: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

/** Ensure the lich daemon is running, spawning it if necessary; returns its dashboard URL. */
export async function ensureDaemonRunning(
  opts: AutoStartOpts = {},
): Promise<AutoStartResult> {
  const out = opts.out ?? process.stdout;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pidOpts =
    opts.lichHome !== undefined ? { lichHome: opts.lichHome } : undefined;

  if (await isDaemonAlive(pidOpts)) {
    const existingUrl = await readDaemonUrl(pidOpts);
    if (existingUrl !== null) {
      return { url: existingUrl, alreadyRunning: true };
    }
    // alive but no URL yet — wait instead of spawning a duplicate
    const url = await pollForUrl(pidOpts, timeoutMs, pollIntervalMs);
    return { url, alreadyRunning: true };
  }

  const binaryPath = resolveDaemonBinary();

  const childEnv: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  if (opts.lichHome !== undefined) {
    childEnv.LICH_HOME = opts.lichHome;
  }
  if (opts.proxyPort !== undefined) {
    childEnv.LICH_PROXY_PORT = String(opts.proxyPort);
  }

  // detached + unref so the daemon outlives this `lich up` invocation
  const child = spawn(binaryPath, [], {
    detached: true,
    stdio: "ignore",
    env: childEnv,
  });
  child.unref();

  // Capture synchronous 'error' (ENOENT, no exec perm) so we don't poll
  // the full timeout for a URL file that's never coming.
  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err;
  });

  let url: string;
  try {
    url = await pollForUrl(pidOpts, timeoutMs, pollIntervalMs);
  } catch (err) {
    if (spawnError !== null) {
      throw new Error(
        `lich daemon failed to start: ${(spawnError as Error).message}`,
      );
    }
    throw err;
  }

  // Reused daemon never re-opens the browser — handled by the early return above.
  if (opts.openBrowser === true) {
    // Prefer the friendly proxy URL so the address bar shows the brand
    // URL instead of an ephemeral 127.0.0.1:<random-port>. The daemon
    // writes proxy-url BEFORE daemon.url, so it's guaranteed present
    // by the time pollForUrl returns. Falls back to the direct URL on
    // proxy bind failure.
    const friendly = await readDaemonProxyUrl(pidOpts).catch(() => null);
    const targetUrl = friendly ?? url;
    try {
      openInBrowser(targetUrl);
    } catch (err) {
      out.write(
        `[lich] warning: could not open browser: ${(err as Error).message}\n`,
      );
    }
  }

  return { url, alreadyRunning: false };
}

function resolveDaemonBinary(): string {
  const envOverride = process.env.LICH_DAEMON_BIN;
  if (envOverride !== undefined && envOverride.length > 0) {
    if (existsSync(envOverride)) {
      return envOverride;
    }
    throw new Error(
      `lich-daemon binary not found at LICH_DAEMON_BIN=${envOverride}`,
    );
  }

  const sibling = join(dirname(process.execPath), "lich-daemon");
  if (existsSync(sibling)) {
    return sibling;
  }

  throw new Error(
    `lich-daemon binary not found at ${sibling}` +
      ` (and LICH_DAEMON_BIN env var is unset).` +
      ` Build it with: cd packages/lich && bun run build:daemon`,
  );
}

async function pollForUrl(
  pidOpts: { lichHome?: string } | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  // First try before the initial sleep — covers the race where another
  // `lich up` just started the daemon.
  const initial = await readDaemonUrl(pidOpts);
  if (initial !== null) return initial;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    const url = await readDaemonUrl(pidOpts);
    if (url !== null) return url;
  }

  const home = pidOpts?.lichHome ?? process.env.LICH_HOME ?? "~/.lich";
  throw new Error(
    `timeout waiting for lich daemon URL file in ${home} after ${timeoutMs}ms` +
      ` (the daemon spawn appears to have failed)`,
  );
}
