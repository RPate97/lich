import concurrently, { type ConcurrentlyCommandInput } from 'concurrently';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
 * Per-service outcome of the detached owned-service spawn path (LEV-194 /
 * LEV-219).
 *
 *   - `'ready'`:   HTTP probe succeeded within the timeout.
 *   - `'failed'`:  the process exited with a NON-ZERO code before the
 *     readiness deadline. The demo is broken — `dev` surfaces the log tail
 *     and exits non-zero (LEV-219).
 *   - `'timeout'`: the process is still running but never passed its HTTP
 *     probe before `readinessTimeoutMs` elapsed. The service may still be
 *     coming up — we just stopped waiting. Also covers the odd case of a
 *     port-claiming service that exited 0 without ever binding.
 *   - `'skipped'`: service exposes no port we can probe (no `portNames`) and
 *     did not exit non-zero — assumed up.
 */
export type DetachedServiceStatus = 'ready' | 'failed' | 'timeout' | 'skipped';

/**
 * Result of the detached owned-service spawn path (LEV-194 / LEV-219).
 *
 * `pids` maps `service.name` to the pid the OS assigned. The CLI prints these
 * in its summary so users can `kill <pid>` directly if `lich stop`
 * is unavailable.
 *
 * `statuses` reports the resolved per-service outcome (see
 * {@link DetachedServiceStatus}). `readiness` is a back-compat alias that
 * holds the same values — pre-LEV-219 callers referred to this field, and the
 * `'failed'` value is simply a new member of the union it already exposed-ish.
 *
 * `exitCodes` carries the exit code of any service that exited non-zero
 * before the deadline (i.e. every `'failed'` service). Services that were
 * still running when the runner returned have no entry here.
 *
 * `exitedAfterMs` carries the wall-clock ms between spawn and exit for any
 * `'failed'` service — `dev` renders it as `(exit code 1 after 2.3s)`.
 *
 * `lastLogTail` carries the last ~20 lines of each non-healthy service's
 * combined stdout/stderr log file — captured best-effort so `dev` can show
 * the user WHY a service is `failed` / `timeout` without them having to run
 * `lich logs`. Empty string when nothing could be read.
 *
 * `logPaths` and `pidPaths` are absolute paths to the files the runner wrote.
 * Exposed so `dev` can surface them in the summary and so `stop` / tests can
 * find them without re-deriving the layout.
 */
export interface DetachedRunnerHandle {
  pids: Record<string, number>;
  statuses: Record<string, DetachedServiceStatus>;
  /** Back-compat alias for {@link statuses} (pre-LEV-219 field name). */
  readiness: Record<string, DetachedServiceStatus>;
  exitCodes: Record<string, number>;
  exitedAfterMs: Record<string, number>;
  lastLogTail: Record<string, string>;
  logPaths: Record<string, string>;
  pidPaths: Record<string, string>;
}

/** How many trailing log lines to surface for a failed/timed-out service. */
const LOG_TAIL_LINES = 20;

/**
 * Read the last {@link LOG_TAIL_LINES} non-empty lines of a service's
 * JSONL log file (written by the detached runner via `ServiceLogWriter`).
 * Best-effort: a missing/unreadable file yields `''` rather than throwing, so
 * a still-timing-out service can never block `dev` from returning.
 *
 * Each line in the JSONL file is a JSON record with a `message` field. We
 * extract just the `message` so the tail reads like plain log output.
 */
async function readLogTail(logPath: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(logPath, 'utf8');
    const lines = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        if (l.startsWith('{')) {
          try {
            const rec = JSON.parse(l) as { message?: string };
            if (typeof rec.message === 'string') return rec.message;
          } catch {
            /* not valid JSON — fall through to raw line */
          }
        }
        return l;
      });
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  }
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
 * Best-effort TCP-port readiness probe. `lich dev` (detached default)
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
/**
 * Single-shot HTTP probe. Resolves `true` if `http://localhost:<port>/`
 * returns any HTTP response within 1s, `false` otherwise. The detached
 * runner calls this in its readiness loop so it can interleave probe
 * attempts with checks on the child's exit state.
 */
function probeHttpReadyOnce(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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
}

/**
 * Per-service exit observation captured while the readiness window is open.
 * `code` is the exit code (null if the process was killed by a signal);
 * `at` is when the exit fired. Populated by the `child.on('exit')` listener
 * the runner attaches before probing.
 */
interface ExitObservation {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

/**
 * Detached owned-service runner (LEV-194 default; LEV-219 failure surfacing;
 * LEV-245 structured JSONL logs).
 *
 * Spawns each service via `child_process.spawn` with `detached: true` +
 * `child.unref()` so the children survive this CLI process exiting.
 *
 * **LEV-245 — structured JSONL logging**: stdout and stderr are piped through
 * the parent and consumed by a per-service `ServiceLogWriter`, which writes
 * one `{ts, service, stream, level, message}` JSON record per line to
 * `<logDir>/<service>.jsonl` — the same format as the `--live` foreground
 * runner. The parent consumes the pipes DURING the readiness window (which it
 * already waits for), then tears them down before returning, leaving the
 * child free to keep running. After the readiness window the child's stdout/
 * stderr write-end has no reader in this process; the OS will deliver SIGPIPE
 * to the child on its next write — most shells and long-running services
 * handle this gracefully (they either ignore SIGPIPE or restart their write
 * loop). If a service is expected to produce output after the readiness window
 * and needs every line captured, use `dev --live` instead.
 *
 * Each child's pid is written to `<pidDir>/<service>.pid`. `lich stop`
 * reads these later to signal the processes — there's no in-memory handle
 * across the CLI exit boundary so the filesystem is the source of truth.
 *
 * After spawning, each service is monitored until either (a) the process
 * exits, (b) its HTTP probe succeeds, or (c) the readiness deadline elapses.
 * A service that exits NON-ZERO before the deadline is `'failed'` — the demo
 * is broken, so the runner reads the tail of its log file so `dev` can show
 * the user WHY (LEV-219). A service still running at the deadline that never
 * passed its probe is `'timeout'`; its log tail is also captured so `dev`
 * can surface whatever output exists so far. Reading the tail is best-effort
 * and never blocks the runner from returning.
 *
 * Returns once every service has resolved a status. No `done` promise is
 * exposed because the parent will not wait on long-running children —
 * `lich stop` inspects pid liveness instead.
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
    return {
      pids: {},
      statuses: {},
      readiness: {},
      exitCodes: {},
      exitedAfterMs: {},
      lastLogTail: {},
      logPaths: {},
      pidPaths: {},
    };
  }

  await mkdir(opts.logDir, { recursive: true });
  await mkdir(opts.pidDir, { recursive: true });

  const ordered = topologicalSort(services);
  const pids: Record<string, number> = {};
  const statuses: Record<string, DetachedServiceStatus> = {};
  const exitCodes: Record<string, number> = {};
  const exitedAfterMs: Record<string, number> = {};
  const lastLogTail: Record<string, string> = {};
  const logPaths: Record<string, string> = {};
  const pidPaths: Record<string, string> = {};
  // Per-service exit observation, filled asynchronously by the `'exit'`
  // listener. `undefined` means the process is still running.
  const exits: Record<string, ExitObservation | undefined> = {};
  // Wall-clock spawn time per service, so a `'failed'` exit can be reported
  // as `(exit code N after Xs)`.
  const spawnedAt: Record<string, number> = {};

  // Per-service writers and their pipe-consumption promises. We close all
  // writers after the readiness window so the JSONL files are flushed before
  // `dev` prints its summary.
  const writers: Map<string, ServiceLogWriter> = new Map();
  // Promises that resolve when the writer has consumed ALL output from its
  // attached streams (i.e. when the child exits and both pipes reach EOF).
  // We await these AFTER the readiness window so we don't block spawn order.
  const writeDonePromises: Map<string, Promise<void>> = new Map();

  for (const s of ordered) {
    // LEV-245: use .jsonl extension (structured JSONL via ServiceLogWriter).
    const logPath = join(opts.logDir, `${s.name}.jsonl`);
    const pidPath = join(opts.pidDir, `${s.name}.pid`);
    logPaths[s.name] = logPath;
    pidPaths[s.name] = pidPath;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...baseEnv,
      ...(serviceEnv[s.name] ?? {}),
      ...(typeof s.envContributions === 'function' ? s.envContributions(ports) : {}),
    };

    // LEV-245: pipe stdout/stderr through the parent so we can write structured
    // JSONL records. We use `detached: true` so the child is in its own process
    // group (SIGINT from the terminal doesn't propagate). `shell: true` matches
    // the `concurrently` contract — `s.command` is a shell-quoted string.
    //
    // DETACHMENT NOTE: piping stdout/stderr keeps the Node.js readable stream
    // refs alive as long as data can arrive. We consume both streams via
    // `ServiceLogWriter.attachStdout/attachStderr` which resolve their promises
    // when the stream reaches EOF (child exits). After the readiness window we
    // call `writer.close()` and destroy the streams, which lets the event loop
    // exit. The child keeps running in its own process group; it may get SIGPIPE
    // on its next write but most long-running services handle that gracefully.
    // Users who need every post-readiness line captured should use `dev --live`.
    const child = spawn(s.command, {
      cwd: s.cwd,
      env,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // LEV-219 — record the child's exit so the readiness loop below can tell
    // a crash (`'failed'`, non-zero exit) apart from a still-coming-up
    // service (`'timeout'`). The listener is attached BEFORE `unref()` and
    // stays valid for the lifetime of this process; we never `await` the
    // child, so this can't keep the event loop alive on its own.
    spawnedAt[s.name] = Date.now();
    exits[s.name] = undefined;
    child.on('exit', (code, signal) => {
      exits[s.name] = { code, signal, at: Date.now() };
    });
    // A spawn that fails before fork emits `'error'` rather than `'exit'`;
    // treat it as a non-zero exit so the service still surfaces as failed.
    child.on('error', () => {
      if (exits[s.name] === undefined) {
        exits[s.name] = { code: 1, signal: null, at: Date.now() };
      }
    });

    // Set up the JSONL writer and begin consuming stdout/stderr. The
    // `attachStdout`/`attachStderr` promises resolve at stream EOF (child exit).
    const writer = new ServiceLogWriter({ service: s.name, logDir: opts.logDir });
    writers.set(s.name, writer);
    const stdoutDone = child.stdout
      ? writer.attachStdout(child.stdout)
      : Promise.resolve();
    const stderrDone = child.stderr
      ? writer.attachStderr(child.stderr)
      : Promise.resolve();
    writeDonePromises.set(s.name, Promise.all([stdoutDone, stderrDone]).then(() => {}));

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
    // above, `unref()` lets `lich dev` exit while the child keeps
    // running. Without `unref()` the parent's event loop would stay alive
    // waiting on the child handle.
    child.unref();
  }

  // Readiness window — run after every service has been spawned so a slow
  // probe on one doesn't delay the spawn of the next. Per service we race
  // the HTTP probe (when there's a port) against the child's exit; the
  // deadline bounds the wall-clock budget either way.
  const timeoutMs = opts.readinessTimeoutMs ?? 10_000;
  // Crash-detection window for PORTLESS services. A portless service has no
  // probe, so historically it was `'skipped'` immediately. We now give it a
  // brief beat to surface a fast startup crash — but capped well below the
  // full readiness budget so a healthy portless service never makes `dev`
  // hang (LEV-219: "reading the tail must not block `dev` from returning").
  const portlessCrashWindowMs = Math.min(timeoutMs, 500);

  // Resolve one service's status. Captures the failed/timeout log tail
  // best-effort — `readLogTail` swallows read errors so a missing log file
  // can never block `dev` from returning.
  const resolveFailed = async (name: string, exit: ExitObservation) => {
    statuses[name] = 'failed';
    exitCodes[name] = exit.code ?? 1;
    exitedAfterMs[name] = Math.max(0, exit.at - (spawnedAt[name] ?? exit.at));
    lastLogTail[name] = await readLogTail(logPaths[name]!);
  };

  await Promise.all(
    ordered.map(async (s) => {
      const start = Date.now();
      const firstPort = s.portNames[0];
      const port = firstPort !== undefined ? ports[firstPort] : undefined;

      if (port === undefined) {
        // No port to probe. Poll briefly for a startup crash; otherwise the
        // service is assumed up (`'skipped'`).
        while (
          Date.now() - start < portlessCrashWindowMs &&
          exits[s.name] === undefined
        ) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const exit = exits[s.name];
        if (exit && exit.code !== null && exit.code !== 0) {
          await resolveFailed(s.name, exit);
        } else {
          statuses[s.name] = 'skipped';
        }
        return;
      }

      // Service has a port — probe it, but bail early the instant the child
      // exits non-zero (no point probing a port nothing will ever bind).
      while (Date.now() - start < timeoutMs) {
        const exit = exits[s.name];
        if (exit !== undefined) {
          if (exit.code !== null && exit.code !== 0) {
            await resolveFailed(s.name, exit);
            return;
          }
          // Exited 0 (or via signal) without ever binding — odd, but not a
          // crash. Treat as `'timeout'`: it can't pass the probe now.
          statuses[s.name] = 'timeout';
          lastLogTail[s.name] = await readLogTail(logPaths[s.name]!);
          return;
        }
        if ((await probeHttpReadyOnce(port)) === true) {
          statuses[s.name] = 'ready';
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // Deadline elapsed. If the child crashed exactly at the boundary, the
      // exit observation still wins; otherwise it's a genuine timeout.
      const exit = exits[s.name];
      if (exit && exit.code !== null && exit.code !== 0) {
        await resolveFailed(s.name, exit);
        return;
      }
      statuses[s.name] = 'timeout';
      // Capture whatever output exists so far — best-effort, never blocks.
      lastLogTail[s.name] = await readLogTail(logPaths[s.name]!);
    }),
  );

  // LEV-245: flush and close all JSONL writers now that the readiness window
  // has closed. For services that have already exited, `writeDonePromises`
  // resolves quickly (the pipe streams reached EOF). For services still
  // running, we give a brief grace period for the last few buffered lines to
  // land, then destroy the streams regardless so the parent can exit cleanly.
  // `writer.close()` writes any partial line buffer before closing the file.
  const FLUSH_GRACE_MS = 500;
  await Promise.all(
    ordered.map(async (s) => {
      const writer = writers.get(s.name);
      if (!writer) return;
      // Race the stream-drain against a short timeout — the child may still be
      // running (status='ready'|'timeout'|'skipped') so we don't wait forever.
      await Promise.race([
        writeDonePromises.get(s.name) ?? Promise.resolve(),
        new Promise<void>((r) => setTimeout(r, FLUSH_GRACE_MS)),
      ]);
      await writer.close().catch(() => { /* best-effort */ });
    }),
  );

  return {
    pids,
    statuses,
    // Back-compat alias — same object so callers reading either field agree.
    readiness: statuses,
    exitCodes,
    exitedAfterMs,
    lastLogTail,
    logPaths,
    pidPaths,
  };
}

/**
 * Remove a single pid file. Used by `stop` after signalling completes — keeps
 * the state dir tidy so a subsequent `dev` doesn't see stale pid files from
 * a previous run.
 */
export async function removePidFile(pidPath: string): Promise<void> {
  await rm(pidPath, { force: true });
}
