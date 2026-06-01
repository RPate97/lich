import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  clearDaemonPid,
  clearDaemonProxyUrl,
  clearDaemonUrl,
  isDaemonAlive,
  writeDaemonPid,
  writeDaemonProxyUrl,
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
import { MetricsSampler } from "./metrics/sampler.js";

export interface RunDaemonOpts {
  lichHome?: string;
  proxyPort?: number;
  /** Dashboard bind hostname. Defaults to "127.0.0.1". Set to "0.0.0.0" for non-loopback access. */
  hostname?: string;
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

// Two ticks (not one) absorbs the down-then-up race where state briefly
// shows zero before the new `lich up` writes its snapshot.
const DEFAULT_SHUTDOWN_CHECK_MS = 2_000;
const DEFAULT_SHUTDOWN_GRACE_TICKS = 2;

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
    // broken stdout must not take down the daemon
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

  // mirror explicit lichHome into env so shared state helpers see the same root
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
  const metricsSampler = new MetricsSampler({ stateRoot });
  // Forward-declared so the watcher's onChange can kick an auto-shutdown
  // check on every state change. Null-check guards the tiny window
  // between watcher.start() and tick assignment.
  let tickNow: (() => Promise<void>) | null = null;
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
      // Kick an immediate auto-shutdown check so `lich down` surfaces
      // daemon exit without waiting up to shutdownCheckMs.
      if (tickNow) void tickNow().catch(() => {});
    },
  });
  await watcher.start();

  // Dashboard binds before proxy so the static-routes table can include
  // `lich.localhost` → dashboard URL from request one.
  try {
    dashboardServer = await startDashboardServer({
      port: 0,
      stateRoot,
      proxyPort,
      hostname: opts.hostname,
      uiDir: opts.uiDir,
      embeddedUi: opts.embeddedUi,
      routingTable: {
        list: () => routingTable.list(),
        reload: () => routingTable.reload(stateRoot),
      },
      metricsSampler: {
        latest: (id) => metricsSampler.latest(id),
        subscribe: (id, cb) => metricsSampler.subscribe(id, cb),
      },
    });
  } catch (err) {
    log(out, `dashboard failed to start: ${(err as Error).message}`);
    metricsSampler.stop();
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

  // Written BEFORE daemon.url so consumers using daemon.url as the
  // readiness signal can read this file unconditionally.
  if (proxy !== null) {
    try {
      const u = new URL(proxy.url);
      const friendly = `http://lich.localhost:${u.port}/`;
      await writeDaemonProxyUrl(friendly, pidOpts);
    } catch {
      // proxy URL didn't parse — auto-start falls back to daemon.url
    }
  }

  // Written only after Bun.serve has bound — auto-start polls this file.
  await writeDaemonUrl(dashboardServer.url, pidOpts);

  // Sampler bootstraps in the background — first tick scans all on-disk
  // stacks; subsequent ticks fire every 2s on the sampler's own timer.
  void metricsSampler.start().catch((err: unknown) => {
    log(out, `metrics sampler failed to start: ${(err as Error).message}`);
  });

  // cleanupPromise dedupes concurrent abort paths (signal, SIGTERM,
  // auto-shutdown) onto a single teardown.
  let cleanupPromise: Promise<void> | null = null;
  const runCleanup = (): Promise<void> => {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      metricsSampler.stop();
      await watcher.stop().catch(() => {});
      if (dashboardServer) {
        await dashboardServer.stop().catch(() => {});
      }
      if (proxy) {
        await proxy.stop().catch(() => {});
      }
      await clearDaemonUrl(pidOpts).catch(() => {});
      await clearDaemonProxyUrl(pidOpts).catch(() => {});
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
    // setTimeout (not setInterval) so a slow snapshot read doesn't
    // cause back-to-back ticks.
    if (shutdownReason === null) {
      shutdownTimer = setTimeout(tick, shutdownCheckMs);
    }
  };

  tickNow = tick;

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
