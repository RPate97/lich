import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  clearDaemonPid,
  clearDaemonUrl,
  isDaemonAlive,
  writeDaemonPid,
  writeDaemonUrl,
  type PidFileOpts,
} from "./pid-file.js";
import { StateWatcher } from "./watcher.js";
import {
  startDashboardServer,
  type DashboardServer,
  type EmbeddedAssetSource,
} from "./dashboard/server.js";
import { deriveProxyPort, startProxy } from "./proxy/proxy.js";
import { RoutingTable } from "./proxy/routing.js";
import { createStaticRoutes } from "./proxy/static-routes.js";
import { readSnapshot, type StackStatus } from "../state/snapshot.js";

export interface RunDaemonOpts {
  lichHome?: string;
  proxyPort?: number;
  uiDir?: string;
  embeddedUi?: EmbeddedAssetSource;
  signal?: AbortSignal;
  out?: NodeJS.WritableStream;
  shutdownCheckMs?: number;
  shutdownGraceTicks?: number;
}

export interface RunDaemonResult {
  exitCode: number;
}

const DEFAULT_SHUTDOWN_CHECK_MS = 10_000;
const DEFAULT_SHUTDOWN_GRACE_TICKS = 3;

const ALIVE_STATUSES: ReadonlySet<StackStatus> = new Set<StackStatus>([
  "starting",
  "up",
  "partial",
  "stopping",
]);

function resolveStateRoot(lichHome: string | undefined): string {
  if (lichHome && lichHome.length > 0) {
    return join(lichHome, "stacks");
  }
  const env = process.env.LICH_HOME;
  if (env && env.length > 0) {
    return join(env, "stacks");
  }
  return join(homedir(), ".lich", "stacks");
}

function resolveLichHomeIdentity(lichHome: string | undefined): string {
  if (lichHome && lichHome.length > 0) return lichHome;
  const env = process.env.LICH_HOME;
  if (env && env.length > 0) return env;
  return join(homedir(), ".lich");
}

async function countAliveStacks(stateRoot: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(stateRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }

  let alive = 0;
  for (const name of entries) {
    let isDir: boolean;
    try {
      const s = await stat(join(stateRoot, name));
      isDir = s.isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const snap = await readSnapshot(name).catch(() => null);
    if (snap && ALIVE_STATUSES.has(snap.status)) {
      alive++;
    }
  }
  return alive;
}

function log(out: NodeJS.WritableStream, line: string): void {
  try {
    out.write(`[lich-daemon] ${line}\n`);
  } catch {
    // Broken stdout must not take down the daemon.
  }
}

export async function runDaemon(
  opts: RunDaemonOpts = {},
): Promise<RunDaemonResult> {
  const out = opts.out ?? process.stdout;
  let proxyPort: number;
  if (opts.proxyPort !== undefined) {
    proxyPort = opts.proxyPort;
  } else {
    const identity = resolveLichHomeIdentity(opts.lichHome);
    proxyPort = deriveProxyPort(identity);
  }
  const shutdownCheckMs = opts.shutdownCheckMs ?? DEFAULT_SHUTDOWN_CHECK_MS;
  const shutdownGraceTicks =
    opts.shutdownGraceTicks ?? DEFAULT_SHUTDOWN_GRACE_TICKS;

  const pidOpts: PidFileOpts | undefined =
    opts.lichHome !== undefined ? { lichHome: opts.lichHome } : undefined;

  if (await isDaemonAlive(pidOpts)) {
    process.stderr.write(
      "lich-daemon: another daemon is already running for this LICH_HOME\n",
    );
    return { exitCode: 1 };
  }

  // Mirror explicit lichHome into env so shared state helpers (readSnapshot, watcher) see the same root.
  const prevLichHome = process.env.LICH_HOME;
  if (opts.lichHome !== undefined) {
    process.env.LICH_HOME = opts.lichHome;
  }

  await writeDaemonPid(process.pid, pidOpts);

  const stateRoot = resolveStateRoot(opts.lichHome);
  const routingTable = new RoutingTable();
  await routingTable.reload(stateRoot).catch((err: unknown) => {
    log(
      out,
      `routing table initial load failed: ${(err as Error).message}`,
    );
  });

  let dashboardServer: DashboardServer | null = null;
  const watcher = new StateWatcher({
    stateRoot,
    onChange: () => {
      if (dashboardServer) {
        dashboardServer.refresh();
      }
      void routingTable.reload(stateRoot).catch((err: unknown) => {
        log(
          out,
          `routing table reload failed: ${(err as Error).message}`,
        );
      });
    },
  });
  await watcher.start();

  // Dashboard binds before proxy so the proxy's static-routes table can
  // include `lich.localhost` → dashboard URL from request one.
  try {
    dashboardServer = await startDashboardServer({
      port: 0,
      stateRoot,
      uiDir: opts.uiDir,
      embeddedUi: opts.embeddedUi,
      routingTable: {
        list: () => routingTable.list(),
        reload: () => routingTable.reload(stateRoot),
      },
    });
  } catch (err) {
    log(out, `dashboard failed to start: ${(err as Error).message}`);
    await watcher.stop().catch(() => {});
    await clearDaemonPid(pidOpts).catch(() => {});
    if (opts.lichHome !== undefined) {
      if (prevLichHome === undefined) {
        delete process.env.LICH_HOME;
      } else {
        process.env.LICH_HOME = prevLichHome;
      }
    }
    return { exitCode: 1 };
  }
  log(out, `dashboard listening on ${dashboardServer.url}`);

  const staticRoutes = createStaticRoutes({
    "lich.localhost": dashboardServer.url,
  });
  let proxy: { url: string; stop(): Promise<void> } | null = null;
  try {
    proxy = await startProxy({
      port: proxyPort,
      routingTable,
      staticRoutes,
    });
    log(out, `proxy listening on ${proxy.url}`);
  } catch (err) {
    log(
      out,
      `proxy failed to start on port ${proxyPort}: ${(err as Error).message}`,
    );
  }

  // Write URL file only after Bun.serve has bound — the auto-start hook
  // polls this file to surface the URL in `lich up`.
  await writeDaemonUrl(dashboardServer.url, pidOpts);

  // Cleanup is gated by cleanupPromise so concurrent abort paths
  // (signal + SIGTERM + auto-shutdown) converge on one teardown.
  let cleanupPromise: Promise<void> | null = null;
  const runCleanup = (): Promise<void> => {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      await watcher.stop().catch(() => {});
      if (dashboardServer) {
        await dashboardServer.stop().catch(() => {});
      }
      if (proxy) {
        await proxy.stop().catch(() => {});
      }
      await clearDaemonUrl(pidOpts).catch(() => {});
      await clearDaemonPid(pidOpts).catch(() => {});
      if (opts.lichHome !== undefined) {
        if (prevLichHome === undefined) {
          delete process.env.LICH_HOME;
        } else {
          process.env.LICH_HOME = prevLichHome;
        }
      }
    })();
    return cleanupPromise;
  };

  let shutdownReason: string | null = null;
  let resolveExit: (() => void) | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const signalShutdown = (reason: string): void => {
    if (shutdownReason !== null) return;
    shutdownReason = reason;
    log(out, `shutdown requested: ${reason}`);
    resolveExit?.();
  };

  const onSigTerm = (): void => signalShutdown("SIGTERM");
  const onSigInt = (): void => signalShutdown("SIGINT");
  process.on("SIGTERM", onSigTerm);
  process.on("SIGINT", onSigInt);

  const onAbort = (): void => signalShutdown("signal-abort");
  if (opts.signal) {
    if (opts.signal.aborted) {
      signalShutdown("signal-already-aborted");
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let emptyTicks = 0;
  let shutdownTimer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (shutdownReason !== null) return;
    const alive = await countAliveStacks(stateRoot).catch(() => 0);
    if (alive === 0) {
      emptyTicks++;
      if (emptyTicks >= shutdownGraceTicks) {
        signalShutdown(`auto-shutdown (${emptyTicks} empty ticks)`);
        return;
      }
    } else {
      emptyTicks = 0;
    }
    // setTimeout (not setInterval): schedule relative to "now" so a slow
    // snapshot read doesn't cause back-to-back ticks.
    if (shutdownReason === null) {
      shutdownTimer = setTimeout(tick, shutdownCheckMs);
    }
  };

  // Delay first tick by one full interval — `lich up` writes state.json
  // AFTER spawning the daemon, so an immediate count would auto-shutdown.
  shutdownTimer = setTimeout(tick, shutdownCheckMs);

  await exitPromise;

  if (shutdownTimer !== null) clearTimeout(shutdownTimer);
  process.off("SIGTERM", onSigTerm);
  process.off("SIGINT", onSigInt);
  if (opts.signal && !opts.signal.aborted) {
    opts.signal.removeEventListener("abort", onAbort);
  }
  await runCleanup();

  return { exitCode: 0 };
}
