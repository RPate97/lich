import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";

import { buildNodeBinAugmentedPath } from "../util/node-bin-path.js";

export interface OwnedServiceSpec {
  name: string;
  cmd: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  portEnvVar?: string;
  port?: number;
  ports?: Record<string, { envVar: string; port: number }>;
  oneshot?: boolean;
  stopCmd?: string;
  logPath: string;
  signal?: AbortSignal;
}

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OwnedHandle {
  name: string;
  pid: number;
  exited: Promise<ExitResult>;
  /** Send SIGTERM, wait up to graceMs, then SIGKILL. Idempotent. Never rejects. */
  stop(graceMs?: number): Promise<void>;
  /** Non-null when the most recent stop() could not verify the process is gone. */
  readonly stopWarning: string | null;
}

const DEFAULT_GRACE_MS = 5_000;
const STOP_CMD_TIMEOUT_MS = 30_000;
const ONESHOT_TAIL_BYTES = 2_048;
// Kernel needs a tick to reap after SIGKILL before kill(pid, 0) reports correctly.
const SIGKILL_VERIFY_GRACE_MS = 500;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal the process group led by pgid and pgid itself. ESRCH is swallowed. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw err;
  }
  try {
    process.kill(pgid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw err;
  }
}

/** Live pids in pid's group, plus pid itself if alive but not in the group result. */
export function survivors(pid: number): number[] {
  let out: number[] = [];
  try {
    const raw = execFileSync("pgrep", ["-g", String(pid)], {
      encoding: "utf8",
    }).trim();
    if (raw !== "") {
      out = raw
        .split("\n")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch {
    /* pgrep failure / no matches → out stays [] */
  }
  if (!out.includes(pid) && isAlive(pid)) out.push(pid);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// macOS APFS is case-insensitive but realpathSync.native canonicalizes case;
// supabase CLI builds its bind-mount path from $PWD and Docker Desktop rejects
// wrong-case paths against its FilesharingDirectories list.
function canonicalizePwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

/**
 * If `cwd` is inside a node workspace and `cmd` isn't already a package-manager
 * `exec`, prepend discovered `.bin` dirs (closest-first) to `env.PATH`.
 * Applied to both start and stop spawn paths so `cmd: prisma` and
 * `stop_cmd: prisma` behave the same.
 */
function maybePrependNodeBin(
  env: NodeJS.ProcessEnv,
  cwd: string,
  cmd: string,
): NodeJS.ProcessEnv {
  const augmented = buildNodeBinAugmentedPath(cwd, cmd, env.PATH);
  if (augmented !== null) env.PATH = augmented;
  return env;
}

/**
 * Spawn one owned service. Never throws asynchronously — spawn failures resolve
 * `exited` with `{ code: 1, signal: null }`.
 */
export async function startOwnedService(
  spec: OwnedServiceSpec,
): Promise<OwnedHandle> {
  if (
    spec.ports !== undefined &&
    (spec.portEnvVar !== undefined || spec.port !== undefined)
  ) {
    throw new Error(
      `owned service "${spec.name}": cannot set both single-port (portEnvVar/port) and multi-port (ports) on the same service`,
    );
  }

  const portEnv: NodeJS.ProcessEnv = {};
  if (spec.portEnvVar && spec.port !== undefined) {
    portEnv[spec.portEnvVar] = String(spec.port);
  }
  if (spec.ports) {
    for (const { envVar, port } of Object.values(spec.ports)) {
      portEnv[envVar] = String(port);
    }
  }
  const env: NodeJS.ProcessEnv = maybePrependNodeBin(
    {
      ...spec.env,
      ...portEnv,
      PWD: canonicalizePwd(spec.cwd),
    },
    spec.cwd,
    spec.cmd,
  );

  // Pass log fd directly as stdio: Node-piped stdout causes Next.js dev to wedge
  // in an infinite ERR_INVALID_URL loop after the first HTTP request.
  const logFd = openSync(spec.logPath, "a");

  let child: ChildProcess;
  try {
    child = spawn("/bin/sh", ["-c", spec.cmd], {
      cwd: spec.cwd,
      env,
      stdio: ["ignore", logFd, logFd],
      // detached:true makes child a process-group leader so signalGroup() reaches
      // the whole tree atomically via kill(-pgid, sig).
      detached: true,
    });
  } finally {
    try {
      closeSync(logFd);
    } catch {
      /* best-effort */
    }
  }

  let exitResult: ExitResult | null = null;
  let resolveExited!: (r: ExitResult) => void;
  const exited = new Promise<ExitResult>((resolve) => {
    resolveExited = resolve;
  });

  const onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (exitResult !== null) return;
    exitResult = { code, signal };
    resolveExited(exitResult);
  };
  child.once("exit", onExit);
  // Pre-fork failures (ENOENT, bad cwd) fire 'error' not 'exit'.
  child.once("error", () => {
    if (exitResult !== null) return;
    onExit(1, null);
  });

  if (typeof child.pid !== "number") {
    const noPidHandle: OwnedHandle = {
      name: spec.name,
      pid: Number.NaN,
      exited,
      stopWarning: null,
      stop: async (): Promise<void> => {
        if (spec.stopCmd) {
          await runStopCmd(spec, STOP_CMD_TIMEOUT_MS).catch(() => {});
        }
        await exited;
      },
    };
    return noPidHandle;
  }

  const pid = child.pid;

  let lastStopWarning: string | null = null;

  const stop = async (
    graceMs: number = DEFAULT_GRACE_MS,
  ): Promise<void> => {
    lastStopWarning = null;

    if (spec.stopCmd) {
      if (exitResult === null) {
        signalGroup(pid, "SIGTERM");
      }
      await runStopCmd(spec, STOP_CMD_TIMEOUT_MS);
      if (exitResult === null) {
        const graceful = await Promise.race([
          exited.then(() => "exited" as const),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs)),
        ]);
        if (graceful === "timeout") {
          signalGroup(pid, "SIGKILL");
          await exited;
        }
      }
      return;
    }

    if (exitResult !== null) return;

    signalGroup(pid, "SIGTERM");

    const graceful = await Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs)),
    ]);

    // Leader can exit cleanly while children keep going — check survivors too.
    const stillAlive = graceful === "timeout" || survivors(pid).length > 0;
    if (stillAlive) {
      signalGroup(pid, "SIGKILL");
      await exited;
    }

    await sleep(SIGKILL_VERIFY_GRACE_MS);
    const lingering = survivors(pid);
    if (lingering.length > 0) {
      lastStopWarning = `SIGKILL did not reap pid(s) ${lingering.join(", ")} after ${SIGKILL_VERIFY_GRACE_MS}ms; one or more processes may still be alive`;
    }
  };

  const handle: OwnedHandle = {
    name: spec.name,
    pid,
    exited,
    stop,
    get stopWarning() {
      return lastStopWarning;
    },
  };
  return handle;
}

async function runStopCmd(
  spec: OwnedServiceSpec,
  timeoutMs: number,
): Promise<void> {
  if (!spec.stopCmd) return;

  const portEnv: NodeJS.ProcessEnv = {};
  if (spec.portEnvVar && spec.port !== undefined) {
    portEnv[spec.portEnvVar] = String(spec.port);
  }
  if (spec.ports) {
    for (const { envVar, port } of Object.values(spec.ports)) {
      portEnv[envVar] = String(port);
    }
  }
  const env: NodeJS.ProcessEnv = maybePrependNodeBin(
    {
      ...spec.env,
      ...portEnv,
      PWD: canonicalizePwd(spec.cwd),
    },
    spec.cwd,
    spec.stopCmd,
  );

  const logFd = openSync(spec.logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn("/bin/sh", ["-c", spec.stopCmd], {
      cwd: spec.cwd,
      env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
  } finally {
    try {
      closeSync(logFd);
    } catch {
      /* best-effort */
    }
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      if (typeof child.pid === "number") {
        signalGroup(child.pid, "SIGKILL");
      }
      finish();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Run a oneshot owned service to completion. Throws on non-zero exit with the
 * log tail (up to ONESHOT_TAIL_BYTES) included in the message.
 */
export async function runOneshot(spec: OwnedServiceSpec): Promise<void> {
  if (spec.signal?.aborted) {
    throw new Error(`oneshot "${spec.name}" aborted before start`);
  }

  const handle = await startOwnedService(spec);

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    handle.stop().catch(() => {});
  };

  if (spec.signal) {
    if (spec.signal.aborted) {
      onAbort();
    } else {
      spec.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let result: ExitResult;
  try {
    result = await handle.exited;
  } finally {
    if (spec.signal) {
      spec.signal.removeEventListener("abort", onAbort);
    }
  }

  if (aborted) {
    throw new Error(`oneshot "${spec.name}" aborted`);
  }

  if (result.code === 0) return;

  let tail = "";
  try {
    const { readFile } = await import("node:fs/promises");
    const contents = await readFile(spec.logPath, "utf8");
    tail =
      contents.length > ONESHOT_TAIL_BYTES
        ? `...${contents.slice(-ONESHOT_TAIL_BYTES)}`
        : contents;
  } catch {
    /* best-effort */
  }

  const exitDesc =
    result.code !== null
      ? `exit code ${result.code}`
      : `signal ${result.signal ?? "unknown"}`;
  const tailSection = tail.trim() ? `\n--- output tail ---\n${tail}` : "";
  throw new Error(
    `oneshot "${spec.name}" failed: ${exitDesc}${tailSection}`,
  );
}
