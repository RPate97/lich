import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { detectWorktree, hashPath, sanitizeName, type Worktree } from "../worktree/detect.js";
import { resolveStackId } from "../state/resolve-stack.js";
import {
  readSnapshot,
  writeSnapshot,
  type ServiceSnapshot,
  type StackSnapshot,
} from "../state/snapshot.js";
import { serviceLogPath } from "../state/directory.js";
import { runPerServiceLifecycle } from "../lifecycle/per-service.js";
import { startOwnedService, type OwnedHandle } from "../owned/supervisor.js";
import { waitForHttpReady } from "../ready/http-get.js";
import { waitForTcpReady } from "../ready/tcp.js";
import { waitForCmdReady } from "../ready/cmd.js";
import { waitForLogMatch } from "../ready/log-match.js";
import { withTimeout, parseDuration } from "../ready/timeout.js";
import { LogTail } from "../logs/tail.js";
import { watchFailWhen } from "../failure/fail-when.js";
import { ProcessExitWatcher } from "../failure/process-exit.js";
import { createOutput, type OutputMode } from "../output/index.js";
import { runDown } from "./down.js";
import { runUp, type OwnedSnapshotOverride } from "./up.js";

export interface RunRestartInput {
  cwd?: string;
  /** Stack ID or worktree name (`--worktree`); defaults to cwd-derived. */
  worktreeArg?: string;
  outputMode?: OutputMode;
  out?: NodeJS.WritableStream;
  signal?: AbortSignal;
  services?: string[];
  profile?: string;
}

export interface RunRestartResult {
  exitCode: number;
  stackId?: string;
  services?: Array<{ name: string; state: string }>;
}

const DEFAULT_OWNED_READY_TIMEOUT_MS = 60_000;
const SIGTERM_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const STOP_CMD_TIMEOUT_MS = 30_000;

export async function runRestart(
  input: RunRestartInput,
): Promise<RunRestartResult> {
  const services = (input.services ?? []).filter((s) => s !== "--all");
  const isWholeStack = (input.services ?? []).length === 0 || (input.services?.length === 1 && input.services[0] === "--all");

  if (isWholeStack) {
    return runWholeStackRestart(input);
  }

  return runPerServiceRestart(input, services);
}

async function runWholeStackRestart(
  input: RunRestartInput,
): Promise<RunRestartResult> {
  const cwd = input.cwd ?? process.cwd();

  // For --worktree, resolve up front so down + up both target the same stack
  // even from outside the worktree. cwd-fallback path keeps today's behavior.
  let restartCwd = cwd;
  if (input.worktreeArg !== undefined && input.worktreeArg.length > 0) {
    try {
      const resolved = await resolveStackId({ cwd, worktreeArg: input.worktreeArg });
      const snap = resolved.snapshot ?? (await readSnapshot(resolved.stackId).catch(() => null));
      if (!snap) {
        const out = input.out ?? process.stdout;
        out.write(`no stack found with ID/name '${input.worktreeArg}'; try \`lich stacks\`\n`);
        return { exitCode: 1 };
      }
      restartCwd = snap.worktree_path;
    } catch (err) {
      const out = input.out ?? process.stdout;
      out.write(`lich restart: ${(err as Error).message}\n`);
      return { exitCode: 1 };
    }
  }

  // Read snapshot BEFORE down so re-up can reuse up-time env, mirroring LEV-513 for down.
  let snapshotProfile: string | undefined;
  let ownedSnapshotOverrides: Map<string, OwnedSnapshotOverride> | undefined;
  try {
    const worktree = detectWorktree(restartCwd);
    const snap = await readSnapshot(worktree.stack_id);
    if (snap !== null) {
      if (input.profile === undefined) {
        snapshotProfile = snap.active_profile;
      }
      const overrides = new Map<string, OwnedSnapshotOverride>();
      for (const svc of snap.services) {
        if (svc.kind !== "owned") continue;
        if (svc.resolved_env === undefined || svc.cmd === undefined || svc.service_cwd === undefined) continue;
        const entry: OwnedSnapshotOverride = {
          env: svc.resolved_env,
          cmd: svc.cmd,
          cwd: svc.service_cwd,
        };
        if (svc.stop_cmd !== undefined) entry.stop_cmd = svc.stop_cmd;
        if (svc.owned_containers !== undefined) entry.owned_containers = svc.owned_containers;
        overrides.set(svc.name, entry);
      }
      if (overrides.size > 0) ownedSnapshotOverrides = overrides;
    }
  } catch {
    // best-effort — let up re-resolve from yaml if snapshot read fails
  }

  const downResult = await runDown({
    cwd: restartCwd,
    outputMode: input.outputMode,
    out: input.out,
    signal: input.signal,
  });
  if (downResult.exitCode !== 0) {
    return { exitCode: downResult.exitCode };
  }

  const upResult = await runUp({
    cwd: restartCwd,
    outputMode: input.outputMode,
    out: input.out,
    signal: input.signal,
    profile: input.profile ?? snapshotProfile,
    ...(ownedSnapshotOverrides !== undefined && { ownedSnapshotOverrides }),
  });

  return {
    exitCode: upResult.exitCode,
    ...(upResult.stackId !== undefined && { stackId: upResult.stackId }),
    ...(upResult.services !== undefined && { services: upResult.services }),
  };
}

async function runPerServiceRestart(
  input: RunRestartInput,
  serviceNames: string[],
): Promise<RunRestartResult> {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const outputMode: OutputMode = input.outputMode ?? "pretty";
  const output = createOutput({ mode: outputMode, stream: out, showTiming: true });

  let worktree: Worktree;
  let snap: StackSnapshot | null;
  try {
    const resolved = await resolveStackId({
      cwd,
      ...(input.worktreeArg !== undefined && { worktreeArg: input.worktreeArg }),
    });
    snap = resolved.snapshot ?? (await readSnapshot(resolved.stackId).catch(() => null));
    if (resolved.worktree !== undefined) {
      worktree = resolved.worktree;
    } else if (snap) {
      worktree = worktreeFromSnapshot(snap);
    } else {
      writeLine(out, `no stack found with ID/name '${input.worktreeArg ?? "(current worktree)"}'`);
      await output.close();
      return { exitCode: 1 };
    }
  } catch (err) {
    writeLine(out, `lich restart: ${(err as Error).message}`);
    await output.close();
    return { exitCode: 1 };
  }

  if (snap === null || snap.status === "stopped") {
    writeLine(out, "no running stack found; run 'lich up' first");
    await output.close();
    return { exitCode: 1 };
  }

  const snapsByName = new Map(snap.services.map((s) => [s.name, s]));

  for (const name of serviceNames) {
    const svcSnap = snapsByName.get(name);
    if (!svcSnap) {
      writeLine(out, `lich restart: service '${name}' not found in running stack`);
      await output.close();
      return { exitCode: 1 };
    }
    if (svcSnap.kind !== "owned") {
      writeLine(out, `lich restart: per-service restart only supports owned services ('${name}' is a compose service)`);
      await output.close();
      return { exitCode: 1 };
    }
    if (!svcSnap.cmd || !svcSnap.resolved_env) {
      writeLine(out, `lich restart: service '${name}' is missing snapshot data; run 'lich down' then 'lich up' to rebuild`);
      await output.close();
      return { exitCode: 1 };
    }
  }

  const runStartedAtMs = Date.now();

  for (const name of serviceNames) {
    const svcSnap = snapsByName.get(name)!;
    const phase = output.phase(`restart: ${name}`);

    let tail: LogTail | null = null;
    const failWhenAc = new AbortController();

    try {
      if (svcSnap.before_down && svcSnap.before_down.length > 0) {
        await runPerServiceLifecycle(
          {
            serviceName: name,
            phase: "before_down",
            entries: svcSnap.before_down.map((e) => e.cmd),
            cwd: worktree.path,
            env: svcSnap.before_down[0]?.env ?? process.env,
          },
          () => {},
        ).catch(() => {});
      }

      await stopOwned(svcSnap, worktree.path, input.signal);

      if (svcSnap.before_start && svcSnap.before_start.length > 0) {
        await runPerServiceLifecycle({
          serviceName: name,
          phase: "before_start",
          entries: svcSnap.before_start.map((e) => e.cmd),
          cwd: worktree.path,
          env: svcSnap.before_start[0]?.env ?? svcSnap.resolved_env ?? process.env,
        });
      }

      const logPath = serviceLogPath(worktree.stack_id, name);
      const handle = await startOwnedService({
        name,
        cmd: svcSnap.cmd!,
        cwd: svcSnap.service_cwd ?? worktree.path,
        env: svcSnap.resolved_env!,
        logPath,
        runId: randomUUID(),
      });

      const spawnedAt = new Date().toISOString();
      svcSnap.pid = handle.pid;
      svcSnap.started_at = spawnedAt;
      svcSnap.state = "ready";
      await writeSnapshot(snap).catch(() => {});

      tail = new LogTail({
        logPath,
        signal: input.signal,
        startOffset: handle.logStartOffset,
      });
      await tail.start();

      const exitWatcher = new ProcessExitWatcher(handle, {
        readSignal: () => "before_ready",
      });

      const failPattern = readFailWhenPattern(svcSnap);
      const failWhenPromise =
        failPattern !== null
          ? watchFailWhen({ tail, pattern: failPattern, signal: failWhenAc.signal })
          : null;

      const readyPromise = runReadyProbe(svcSnap, handle, logPath, worktree.path, tail, input.signal);

      const racers: Promise<unknown>[] = [readyPromise];
      if (failWhenPromise !== null) racers.push(failWhenPromise);
      racers.push(
        exitWatcher.wait().then((failure) => {
          if (failure === null) return new Promise<void>(() => {});
          throw new Error(
            `owned service "${name}" exited before becoming ready`,
            { cause: failure },
          );
        }),
      );

      try {
        await Promise.race(racers);
      } finally {
        failWhenAc.abort();
      }

      if (svcSnap.after_ready && svcSnap.after_ready.length > 0) {
        await runPerServiceLifecycle({
          serviceName: name,
          phase: "after_ready",
          entries: svcSnap.after_ready.map((e) => e.cmd),
          cwd: worktree.path,
          env: svcSnap.after_ready[0]?.env ?? svcSnap.resolved_env ?? process.env,
        });
      }

      svcSnap.state = "ready";
      await writeSnapshot(snap).catch(() => {});

      phase.end("ok", `${name} restarted`);
    } catch (err) {
      svcSnap.state = "failed";
      svcSnap.failure_reason = (err as Error).message;
      await writeSnapshot(snap).catch(() => {});
      phase.end("fail", (err as Error).message);
      await output.close();
      return { exitCode: 1, stackId: worktree.stack_id };
    } finally {
      failWhenAc.abort();
      if (tail !== null) {
        await tail.stop().catch(() => {});
      }
    }
  }

  output.summary({
    title: `restarted: ${serviceNames.join(", ")}`,
    elapsedMs: Date.now() - runStartedAtMs,
    lines: [`stack_id: ${worktree.stack_id}`],
  });

  await output.close();
  return {
    exitCode: 0,
    stackId: worktree.stack_id,
    services: snap.services.map((s) => ({ name: s.name, state: s.state })),
  };
}

function worktreeFromSnapshot(snap: StackSnapshot): Worktree {
  const path = snap.worktree_path;
  const name = sanitizeName(snap.worktree_name);
  const id = hashPath(path);
  return { name, id, path, stack_id: snap.stack_id };
}

async function stopOwned(
  svcSnap: ServiceSnapshot,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const { pid, stop_cmd, resolved_env } = svcSnap;

  if (stop_cmd) {
    await runStopCmd(stop_cmd, worktreePath, resolved_env ?? process.env);
    return;
  }

  if (typeof pid !== "number") return;

  if (!isAlive(pid)) return;

  // Signal the whole process group (same strategy as down.ts / supervisor.ts).
  try {
    process.kill(-pid, "SIGTERM");
  } catch { /* group send failed; fall through to direct send */ }
  try {
    process.kill(pid, "SIGTERM");
  } catch { return; /* already gone */ }

  const startMs = Date.now();
  while (Date.now() - startMs < SIGTERM_GRACE_MS) {
    if (!isAlive(pid)) return;
    if (signal?.aborted) break;
    await sleep(POLL_INTERVAL_MS);
  }

  try { process.kill(-pid, "SIGKILL"); } catch { /* empty */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* empty */ }
}

async function runStopCmd(cmd: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, env, stdio: "ignore" });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* empty */ }
      resolve();
    }, STOP_CMD_TIMEOUT_MS);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.once("error", () => { clearTimeout(timer); resolve(); });
  });
}

async function runReadyProbe(
  svcSnap: ServiceSnapshot,
  handle: OwnedHandle,
  logPath: string,
  _worktreePath: string,
  sharedTail: LogTail | null,
  signal?: AbortSignal,
): Promise<void> {
  const readyWhen = svcSnap.ready_when;
  if (!readyWhen) return;

  const timeoutRaw = readyWhen.timeout;
  const timeoutMs = typeof timeoutRaw === "string"
    ? parseDuration(timeoutRaw)
    : typeof timeoutRaw === "number"
      ? timeoutRaw
      : DEFAULT_OWNED_READY_TIMEOUT_MS;

  let probePromise: Promise<void>;

  if (typeof readyWhen.log_match === "string" && readyWhen.log_match.length > 0) {
    const pattern = new RegExp(readyWhen.log_match as string, "u");
    let tail = sharedTail;
    let stopAfter = false;
    if (tail === null) {
      tail = new LogTail({ logPath, signal, startOffset: handle.logStartOffset });
      await tail.start();
      stopAfter = true;
    }
    const tailNonNull = tail;
    probePromise = waitForLogMatch({ tail: tailNonNull, pattern, signal }).finally(() => {
      if (stopAfter) void tailNonNull.stop().catch(() => {});
    });
  } else if (typeof readyWhen.http_get === "string" && readyWhen.http_get.length > 0) {
    const url = resolveHttpUrl(readyWhen.http_get as string, svcSnap);
    probePromise = waitForHttpReady({ url, signal });
  } else if (typeof readyWhen.tcp === "string" && readyWhen.tcp.length > 0) {
    probePromise = waitForTcpReady({ target: readyWhen.tcp as string, signal });
  } else if (typeof readyWhen.cmd === "string" && readyWhen.cmd.length > 0) {
    probePromise = waitForCmdReady({
      shellCmd: readyWhen.cmd as string,
      env: (svcSnap.resolved_env ?? process.env) as Record<string, string>,
      cwd: svcSnap.service_cwd ?? process.cwd(),
      signal,
    });
  } else {
    return;
  }

  await withTimeout(probePromise, { ms: timeoutMs });
}

function readFailWhenPattern(svcSnap: ServiceSnapshot): RegExp | null {
  const fw = svcSnap.fail_when;
  if (!fw) return null;
  const logMatch = fw.log_match;
  if (typeof logMatch !== "string" || logMatch.length === 0) return null;
  return new RegExp(logMatch, "u");
}

function resolveHttpUrl(pathOrUrl: string, svcSnap: ServiceSnapshot): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  const port =
    svcSnap.allocated_ports?.default ??
    Object.values(svcSnap.allocated_ports ?? {})[0];
  if (port === undefined) {
    throw new Error(
      `ready_when.http_get uses a relative path but no port is allocated for '${svcSnap.name}'`,
    );
  }
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `http://localhost:${port}${path}`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLine(out: NodeJS.WritableStream, text: string): void {
  out.write(`${text}\n`);
}
