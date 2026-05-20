import concurrently, { type ConcurrentlyCommandInput } from 'concurrently';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceLogWriter } from './log-writer';
import type { OwnedService, StackContext, PortMap } from '../services/types';

export interface RunnerOptions {
  logDir: string;
}

export interface RunnerHandle {
  pids: Record<string, number>;
  stop(): Promise<void>;
  done: Promise<{ exitCodes: Record<string, number> }>;
}

/**
 * Detached-mode runner options (LEV-194).
 *
 * `logDir` — directory where each owned service's raw stdout/stderr is appended
 * (one `<service>.log` file per service). Created if missing.
 *
 * `pidDir` — directory where each owned service's `<service>.pid` file lives.
 * `stop` reads these later to deliver SIGTERM/SIGKILL.
 *
 * `readinessTimeoutMs` — best-effort upper bound on the per-service HTTP probe.
 * Services that don't expose a port (no `portNames`) skip the probe entirely
 * and are assumed ready as soon as `spawn` returns.
 */
export interface DetachedRunnerOptions {
  logDir: string;
  pidDir: string;
  readinessTimeoutMs?: number;
}

/**
 * Result of the detached owned-service spawn path (LEV-194).
 *
 * `pids` maps `service.name` to the pid the OS assigned. The CLI prints these
 * in its summary so users can `kill <pid>` directly if `levelzero stop`
 * is unavailable.
 *
 * `readiness` reports the outcome of the optional HTTP probe per service:
 *   - `'ready'`: probe succeeded within the timeout.
 *   - `'timeout'`: probe was attempted but never returned 2xx/3xx/4xx within
 *     `readinessTimeoutMs`. The service may still be coming up — we just
 *     stopped waiting.
 *   - `'skipped'`: service exposes no port we can probe (no `portNames`).
 *
 * `logPaths` and `pidPaths` are absolute paths to the files the runner wrote.
 * Exposed so `dev` can surface them in the summary and so `stop` / tests can
 * find them without re-deriving the layout.
 */
export interface DetachedRunnerHandle {
  pids: Record<string, number>;
  readiness: Record<string, 'ready' | 'timeout' | 'skipped'>;
  logPaths: Record<string, string>;
  pidPaths: Record<string, string>;
}

export function topologicalSort(services: OwnedService[]): OwnedService[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const visited = new Set<string>();
  const ordered: OwnedService[] = [];

  function visit(s: OwnedService, stack: string[]) {
    if (visited.has(s.name)) return;
    if (stack.includes(s.name)) {
      throw new Error(`cycle in dependsOn: ${[...stack, s.name].join(' -> ')}`);
    }
    for (const dep of s.dependsOn ?? []) {
      const depSvc = byName.get(dep);
      if (depSvc) visit(depSvc, [...stack, s.name]);
    }
    visited.add(s.name);
    ordered.push(s);
  }

  for (const s of services) visit(s, []);
  return ordered;
}

/**
 * Spawn every owned service via `concurrently`, ordered by `dependsOn`. Each
 * service inherits `process.env`, then layers `baseEnv` (shared across every
 * service — Plan 16 host-side cross-service vars like the legacy `DATABASE_URL`
 * derived from sibling docker services), then `serviceEnv[name]` (LEV-182:
 * pre-resolved per-service env from `resolveEnvForService({ context: 'host' })`
 * — explicit `envInjection` entries plus `importAll` payloads), then the
 * service's own legacy `envContributions(ports)`. Last layer wins, matching
 * `dev.ts`'s "explicit injection beats inherited stack env beats process env"
 * ordering.
 *
 * This is the `--live` foreground runner (LEV-194). It inherits stdio via
 * `concurrently` so the user sees interleaved-prefix output until Ctrl-C
 * tears the stack down. For the default detached behavior, see
 * {@link runOwnedServicesDetached}.
 */
export async function runOwnedServices(
  services: OwnedService[],
  _ctx: StackContext,
  ports: PortMap,
  baseEnv: Record<string, string>,
  opts: RunnerOptions,
  serviceEnv: Record<string, Record<string, string>> = {},
): Promise<RunnerHandle> {
  if (services.length === 0) {
    return {
      pids: {},
      stop: async () => {},
      done: Promise.resolve({ exitCodes: {} }),
    };
  }

  const ordered = topologicalSort(services);

  const inputs: ConcurrentlyCommandInput[] = ordered.map((s) => ({
    name: s.name,
    command: s.command,
    cwd: s.cwd,
    // `serviceEnv[s.name]` comes from the EnvSource resolver (LEV-182): the
    // booted plugin set produces a per-service env map that wins over both
    // `process.env` and the shared `baseEnv`. The legacy per-service
    // `envContributions(ports)` hook is now optional (LEV-187 — v0 plugins
    // migrated to `api.addEnvSource()`); services without it contribute
    // nothing through this code path. Legacy contributions still come LAST
    // so that any plugin that hasn't migrated yet keeps overriding the
    // EnvSource resolver result for its own service — matching the old
    // precedence, which the LEV-185 compat shim relies on.
    env: {
      ...process.env,
      ...baseEnv,
      ...(serviceEnv[s.name] ?? {}),
      ...(typeof s.envContributions === 'function' ? s.envContributions(ports) : {}),
    },
  }));

  const { result, commands } = concurrently(inputs, {
    killOthersOn: ['failure', 'success'],
    prefix: 'name',
    raw: false,
  });

  const writers: ServiceLogWriter[] = [];
  const pids: Record<string, number> = {};

  for (const cmd of commands) {
    const writer = new ServiceLogWriter({ service: cmd.name, logDir: opts.logDir });
    writers.push(writer);

    cmd.stdout.subscribe({
      next: (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        for (const line of text.split('\n').filter((l) => l.length > 0)) {
          void writer.appendLine('stdout', 'info', line);
        }
      },
    });
    cmd.stderr.subscribe({
      next: (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        for (const line of text.split('\n').filter((l) => l.length > 0)) {
          void writer.appendLine('stderr', 'error', line);
        }
      },
    });

    pids[cmd.name] = cmd.pid ?? Number.NaN;
    if (cmd.pid === undefined) {
      cmd.error.subscribe(() => {});
      setImmediate(() => {
        pids[cmd.name] = cmd.pid ?? Number.NaN;
      });
    }
  }

  const done = result.then(
    async (events) => {
      await Promise.all(writers.map((w) => w.close()));
      const exitCodes: Record<string, number> = {};
      for (const e of events) {
        exitCodes[e.command.name] =
          typeof e.exitCode === 'number' ? e.exitCode : e.exitCode ? Number(e.exitCode) : 0;
      }
      return { exitCodes };
    },
    async (events) => {
      await Promise.all(writers.map((w) => w.close()));
      const exitCodes: Record<string, number> = {};
      const arr = Array.isArray(events) ? events : [events];
      for (const e of arr) {
        if (e?.command?.name) {
          exitCodes[e.command.name] = typeof e.exitCode === 'number' ? e.exitCode : 1;
        }
      }
      for (const s of ordered) {
        if (!(s.name in exitCodes)) exitCodes[s.name] = 1;
      }
      return { exitCodes };
    },
  );

  const stop = async () => {
    for (const cmd of commands) {
      try {
        cmd.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    await new Promise((res) => setTimeout(res, 500));
    for (const cmd of commands) {
      try {
        cmd.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  };

  return { pids, stop, done };
}

/**
 * Best-effort TCP-port readiness probe. `levelzero dev` (detached default)
 * uses this to give services a chance to come up before printing the summary,
 * so the user's first `curl` doesn't race the spawn.
 *
 * We try a single GET to `http://localhost:<port>/` and accept any HTTP
 * response (`status` is set) as "ready" — even a 404 or 500 means the
 * server is listening and parsing requests. We do NOT require a 200 because
 * many services don't have a `/` route mounted in dev. `ECONNREFUSED`,
 * timeout, and DNS errors all count as "not ready yet" and trigger a retry.
 *
 * Caller bounds the total wall-clock budget; this just keeps retrying with a
 * small backoff until either a response arrives or the budget expires.
 */
async function probeHttpReady(
  port: number,
  timeoutMs: number,
): Promise<'ready' | 'timeout'> {
  const start = Date.now();
  const tryOnce = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 1000);
      // `node:http`-style fetch keeps the dependency surface to the standard
      // global. Any HTTP response (including 4xx/5xx) confirms the listener
      // is up, which is the whole "service is ready" signal we need.
      fetch(`http://localhost:${port}/`, { signal: ac.signal })
        .then(() => {
          clearTimeout(t);
          resolve(true);
        })
        .catch(() => {
          clearTimeout(t);
          resolve(false);
        });
    });

  while (Date.now() - start < timeoutMs) {
    if (await tryOnce()) return 'ready';
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'timeout';
}

/**
 * Detached owned-service runner (LEV-194 default).
 *
 * Spawns each service via `child_process.spawn` with `detached: true` +
 * `child.unref()` so the children survive this CLI process exiting. stdout
 * and stderr are redirected to a single per-service log file (raw bytes
 * appended; the JSONL `ServiceLogWriter` is only used in `--live` mode
 * because a JSONL writer requires a live parent to consume pipes).
 *
 * Each child's pid is written to `<pidDir>/<service>.pid`. `levelzero stop`
 * reads these later to signal the processes — there's no in-memory handle
 * across the CLI exit boundary so the filesystem is the source of truth.
 *
 * After spawning, if a service exposes a host port we briefly probe it over
 * HTTP so the summary printed by `dev` reflects "ready" rather than "we
 * fired and forgot." Services without a port skip the probe.
 *
 * Returns synchronously after spawning + readiness probes complete; the
 * caller can `await` this and then exit cleanly. No `done` promise is
 * exposed because the parent will not see exit codes — `levelzero stop`
 * inspects pid liveness instead.
 */
export async function runOwnedServicesDetached(
  services: OwnedService[],
  _ctx: StackContext,
  ports: PortMap,
  baseEnv: Record<string, string>,
  opts: DetachedRunnerOptions,
  serviceEnv: Record<string, Record<string, string>> = {},
): Promise<DetachedRunnerHandle> {
  if (services.length === 0) {
    return { pids: {}, readiness: {}, logPaths: {}, pidPaths: {} };
  }

  await mkdir(opts.logDir, { recursive: true });
  await mkdir(opts.pidDir, { recursive: true });

  const ordered = topologicalSort(services);
  const pids: Record<string, number> = {};
  const readiness: Record<string, 'ready' | 'timeout' | 'skipped'> = {};
  const logPaths: Record<string, string> = {};
  const pidPaths: Record<string, string> = {};

  for (const s of ordered) {
    const logPath = join(opts.logDir, `${s.name}.log`);
    const pidPath = join(opts.pidDir, `${s.name}.pid`);
    logPaths[s.name] = logPath;
    pidPaths[s.name] = pidPath;

    // `openSync('a')` gives us a writable FD that `spawn` can pass straight
    // into the child's stdio array. Both stdout and stderr point at the
    // same FD so we get an interleaved log — matches what users see when
    // they run a service in a foreground terminal.
    const fd = openSync(logPath, 'a');
    // Marker so each new dev invocation is visually separable when tailing
    // the same log file across multiple stack lifetimes.
    try {
      const stamp = `\n--- levelzero dev ${new Date().toISOString()} ---\n`;
      const { writeSync } = await import('node:fs');
      writeSync(fd, stamp);
    } catch {
      /* best-effort marker; ignore failures */
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...baseEnv,
      ...(serviceEnv[s.name] ?? {}),
      ...(typeof s.envContributions === 'function' ? s.envContributions(ports) : {}),
    };

    // `shell: true` matches the `concurrently` contract — `s.command` is a
    // shell-quoted string (e.g. `bun run dev`). `detached: true` puts the
    // child in its own process group so SIGINT to this CLI does not
    // propagate; `unref()` lets the event loop exit even with the child
    // still running.
    const child = spawn(s.command, {
      cwd: s.cwd,
      env,
      shell: true,
      detached: true,
      stdio: ['ignore', fd, fd],
    });

    // Close our copy of the log FD — the child now owns its own dup'd copy.
    // Leaking the FD here would keep the file open forever in the parent.
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }

    if (typeof child.pid === 'number') {
      pids[s.name] = child.pid;
      await writeFile(pidPath, `${child.pid}\n`, 'utf8');
    } else {
      pids[s.name] = Number.NaN;
      // No pid means the spawn failed pre-fork; record an empty file so
      // `stop` has a uniform shape but won't kill the wrong pid.
      await writeFile(pidPath, '', 'utf8');
    }

    // Decouple the child from the parent: combined with `detached: true`
    // above, `unref()` lets `levelzero dev` exit while the child keeps
    // running. Without `unref()` the parent's event loop would stay alive
    // waiting on the child handle.
    child.unref();
  }

  // Readiness probe — run after every service has been spawned so a slow
  // probe on one doesn't delay the spawn of the next.
  const timeoutMs = opts.readinessTimeoutMs ?? 10_000;
  await Promise.all(
    ordered.map(async (s) => {
      const firstPort = s.portNames[0];
      const port = firstPort !== undefined ? ports[firstPort] : undefined;
      if (port === undefined) {
        readiness[s.name] = 'skipped';
        return;
      }
      readiness[s.name] = await probeHttpReady(port, timeoutMs);
    }),
  );

  return { pids, readiness, logPaths, pidPaths };
}

/**
 * Remove a single pid file. Used by `stop` after signalling completes — keeps
 * the state dir tidy so a subsequent `dev` doesn't see stale pid files from
 * a previous run.
 */
export async function removePidFile(pidPath: string): Promise<void> {
  await rm(pidPath, { force: true });
}
