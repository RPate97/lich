import { spawn } from "node:child_process";

import { detectWorktree } from "../worktree/detect.js";
import {
  readSnapshot,
  writeSnapshot,
  type ServiceSnapshot,
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
import { createOutput, type OutputMode } from "../output/index.js";
import { runDown } from "./down.js";
import { runUp } from "./up.js";

export interface RunRestartInput {
  cwd?: string;
  outputMode?: OutputMode;
  out?: NodeJS.WritableStream;
  signal?: AbortSignal;
  /** Named services to restart. Empty/undefined or ["--all"] = whole-stack restart. */
  services?: string[];
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
  const downResult = await runDown({
    cwd: input.cwd,
    outputMode: input.outputMode,
    out: input.out,
    signal: input.signal,
  });
  if (downResult.exitCode !== 0) {
    return { exitCode: downResult.exitCode };
  }

  const upResult = await runUp({
    cwd: input.cwd,
    outputMode: input.outputMode,
    out: input.out,
    signal: input.signal,
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

  let worktree;
  try {
    worktree = detectWorktree(cwd);
  } catch (err) {
    writeLine(out, `lich restart: ${(err as Error).message}`);
    await output.close();
    return { exitCode: 1 };
  }

  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
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

      const logPath = serviceLogPath(worktree.stack_id, name);
      const handle = await startOwnedService({
        name,
        cmd: svcSnap.cmd!,
        cwd: svcSnap.service_cwd ?? worktree.path,
        env: svcSnap.resolved_env!,
        logPath,
      });

      svcSnap.pid = handle.pid;
      svcSnap.state = "ready";
      await writeSnapshot(snap).catch(() => {});

      await runReadyProbe(svcSnap, handle, logPath, worktree.path, input.signal);

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
    const tail = new LogTail({ logPath, signal, startOffset: handle.logStartOffset });
    await tail.start();
    const pattern = new RegExp(readyWhen.log_match, "u");
    probePromise = waitForLogMatch({ tail, pattern, signal }).finally(() => tail.stop().catch(() => {}));
  } else if (typeof readyWhen.http_get === "string" && readyWhen.http_get.length > 0) {
    const url = resolveHttpUrl(readyWhen.http_get, svcSnap);
    probePromise = waitForHttpReady({ url, signal });
  } else if (typeof readyWhen.tcp === "string" && readyWhen.tcp.length > 0) {
    probePromise = waitForTcpReady({ target: readyWhen.tcp, signal });
  } else if (typeof readyWhen.cmd === "string" && readyWhen.cmd.length > 0) {
    probePromise = waitForCmdReady({
      shellCmd: readyWhen.cmd,
      env: svcSnap.resolved_env ?? process.env,
      cwd: svcSnap.service_cwd ?? process.cwd(),
      signal,
    });
  } else {
    return;
  }

  await withTimeout(probePromise, { ms: timeoutMs });
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
