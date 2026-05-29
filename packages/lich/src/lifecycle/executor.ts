import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type LifecyclePhase =
  | "before_up"
  | "after_up"
  | "before_down"
  | "after_down";

export type LifecycleEntry =
  | string
  | { cmd: string; env_group?: string };

export interface RunLifecycleInput {
  phase: LifecyclePhase;
  entries: LifecycleEntry[];
  /** Working directory; typically the worktree root. */
  cwd: string;
  /** Resolved env for the hook execution. */
  env: NodeJS.ProcessEnv;
  /** Resolver for long-form entries with `env_group`. Throws if missing when needed. */
  resolveEnvGroup?: (name: string) => Promise<NodeJS.ProcessEnv>;
  /** Path to the phase log file. All entries for this phase are appended here. When unset, no logs are written. */
  logPath?: string;
}

export interface LifecycleWarning {
  index: number;
  cmd: string;
  exitCode: number;
  stderr: string;
}

/** Per-entry start callback. Fires BEFORE spawn. `index` is 0-based; `total` is the entries-array length. */
export interface LifecycleEntryStart {
  phase: LifecyclePhase;
  index: number;
  total: number;
  cmd: string;
}

/**
 * Per-entry completion callback. Fires for EVERY entry — exit 0 or not — so
 * callers can surface stderr from `cmd || true` patterns that silently exit 0.
 * `stderrTail` is the last `STDERR_TAIL_BYTES` of stderr; `logPath` is set
 * iff `RunLifecycleInput.logPath` was supplied.
 */
export interface LifecycleEntryCompletion {
  phase: LifecyclePhase;
  index: number;
  total: number;
  cmd: string;
  exitCode: number;
  elapsedMs: number;
  stderrTail: string;
  logPath?: string;
}

export class LifecycleHookError extends Error {
  /** Which phase failed. */
  readonly phase: LifecyclePhase;
  /** Zero-based index of the offending entry within the phase. */
  readonly index: number;
  /** The command that failed. */
  readonly cmd: string;
  /** Exit code (non-zero). */
  readonly exitCode: number;
  /** Captured stderr (last N bytes). */
  readonly stderr: string;

  constructor(args: {
    phase: LifecyclePhase;
    index: number;
    cmd: string;
    exitCode: number;
    stderr: string;
  }) {
    super(
      `lifecycle ${args.phase} entry #${args.index} failed (exit ${args.exitCode}): ${args.cmd}`,
    );
    this.name = "LifecycleHookError";
    this.phase = args.phase;
    this.index = args.index;
    this.cmd = args.cmd;
    this.exitCode = args.exitCode;
    this.stderr = args.stderr;
  }
}

const STDERR_TAIL_BYTES = 4096;

// 1 MB cap per phase; runaway hooks would otherwise fill disk.
const LOG_FILE_CAP_BYTES = 1_000_000;

/**
 * Format a single-line stderr surface like
 * `▶ before_down (1/2): supabase stop — stderr: <l1> | <l2> | <l3>`.
 * Returns `null` when stderrTail is empty.
 */
export function formatStderrSurface(args: {
  phase: LifecyclePhase;
  index: number;
  total: number;
  cmd: string;
  stderrTail: string;
}): string | null {
  const trimmedTail = args.stderrTail.trim();
  if (trimmedTail.length === 0) return null;
  const lines = trimmedTail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // last 3 lines — most-recent context near the surface of the failure
  const tail = lines.slice(-3).join(" | ");
  return (
    `▶ ${args.phase} (${args.index + 1}/${args.total}): ` +
    `${args.cmd} — stderr: ${tail}`
  );
}

const FAILURE_MAX_LINES = 500;
const FAILURE_MAX_BYTES = 200_000;

export function formatHookFailureOutput(args: {
  phase: LifecyclePhase;
  index: number;
  total: number;
  cmd: string;
  exitCode: number;
  logPath: string;
}): { lines: string[]; footer: string } | null {
  let raw: string;
  try {
    const buf = readFileSync(args.logPath);
    // Tail by bytes first to stay under 200KB budget.
    const sliced =
      buf.length > FAILURE_MAX_BYTES
        ? buf.slice(buf.length - FAILURE_MAX_BYTES)
        : buf;
    raw = sliced.toString("utf8");
  } catch {
    return null;
  }

  const allLines = raw.split("\n");
  // Strip trailing empty line left by a trailing newline before tailing.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  // Tail by lines — actual errors are at the bottom.
  const tailed =
    allLines.length > FAILURE_MAX_LINES
      ? allLines.slice(allLines.length - FAILURE_MAX_LINES)
      : allLines;

  const footer = `(full log: ${args.logPath})`;
  return { lines: tailed, footer };
}

interface NormalizedEntry {
  cmd: string;
  envGroup: string | undefined;
}

function normalize(entry: LifecycleEntry): NormalizedEntry {
  if (typeof entry === "string") {
    return { cmd: entry, envGroup: undefined };
  }
  return { cmd: entry.cmd, envGroup: entry.env_group };
}

interface SpawnResult {
  exitCode: number;
  stderr: string;
}

function formatTimestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Appends to the phase log file. Creates parent dirs on first use.
 * `written` tracks bytes appended in this executor call (not the file's total).
 */
function makePhaseLogAppender(logPath: string): {
  write: (chunk: Buffer | string) => void;
  writeLine: (line: string) => void;
} {
  let initialized = false;
  let written = 0;

  function ensureDir(): boolean {
    if (initialized) return true;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      initialized = true;
      return true;
    } catch {
      initialized = true;
      return false;
    }
  }

  return {
    write(chunk: Buffer | string): void {
      if (written >= LOG_FILE_CAP_BYTES) return;
      if (!ensureDir()) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const remaining = LOG_FILE_CAP_BYTES - written;
      const toWrite = text.length <= remaining ? text : text.slice(0, remaining);
      try {
        appendFileSync(logPath, toWrite);
        written += toWrite.length;
      } catch {
        written = LOG_FILE_CAP_BYTES;
      }
    },
    writeLine(line: string): void {
      this.write(line + "\n");
    },
  };
}

function runOne(
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  appender: ReturnType<typeof makePhaseLogAppender> | null,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (appender) appender.write(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text =
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrTail += text;
      if (stderrTail.length > STDERR_TAIL_BYTES) {
        stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_BYTES);
      }
      if (appender) appender.write(chunk);
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 1);
      resolve({ exitCode, stderr: stderrTail });
    });
  });
}

/** Optional callbacks passed to `runLifecycle`. */
export interface LifecycleCallbacks {
  /** Per-entry warning, best-effort phases only. */
  onWarning?: (warning: LifecycleWarning) => void;
  /** Fires BEFORE each entry is spawned. */
  onEntryStart?: (start: LifecycleEntryStart) => void;
  /** Fires AFTER each entry settles — exit 0 or not. */
  onEntryComplete?: (completion: LifecycleEntryCompletion) => void;
}

/**
 * Run `entries` in order. Up phases throw `LifecycleHookError` on non-zero
 * exit; down phases call `onWarning` and continue.
 *
 * Per entry, callbacks fire as: `onEntryStart` → `onEntryComplete` →
 * `onWarning` (down phases only, on failure). `onEntryComplete` fires for
 * every entry regardless of exit code.
 *
 * Two call shapes are supported: a `LifecycleCallbacks` object (preferred),
 * or the legacy positional `(input, onWarning?, onEntryComplete?)`.
 */
export async function runLifecycle(
  input: RunLifecycleInput,
  callbacks?: LifecycleCallbacks,
): Promise<void>;
export async function runLifecycle(
  input: RunLifecycleInput,
  onWarning?: (warning: LifecycleWarning) => void,
  onEntryComplete?: (completion: LifecycleEntryCompletion) => void,
): Promise<void>;
export async function runLifecycle(
  input: RunLifecycleInput,
  callbacksOrOnWarning?:
    | LifecycleCallbacks
    | ((warning: LifecycleWarning) => void),
  onEntryComplete?: (completion: LifecycleEntryCompletion) => void,
): Promise<void> {
  // normalize the two call shapes (object vs legacy positional) into one
  // LifecycleCallbacks. third positional arg => legacy form regardless of
  // whether the second was supplied.
  let callbacks: LifecycleCallbacks;
  if (typeof callbacksOrOnWarning === "function") {
    callbacks = {
      onWarning: callbacksOrOnWarning,
      ...(onEntryComplete !== undefined ? { onEntryComplete } : {}),
    };
  } else if (onEntryComplete !== undefined) {
    callbacks = { onEntryComplete };
  } else {
    callbacks = callbacksOrOnWarning ?? {};
  }

  const { phase, entries, cwd, env, resolveEnvGroup, logPath } = input;
  const bestEffort = phase === "before_down" || phase === "after_down";

  // One appender shared across all entries in the phase.
  const appender = logPath ? makePhaseLogAppender(logPath) : null;

  for (let index = 0; index < entries.length; index++) {
    const { cmd, envGroup } = normalize(entries[index]!);

    let entryEnv: NodeJS.ProcessEnv;
    if (envGroup !== undefined) {
      if (!resolveEnvGroup) {
        throw new Error(
          `lifecycle ${phase} entry #${index} references env_group "${envGroup}": ` +
            `env_group not supported in Plan 1; provide resolveEnvGroup in Plan 2+`,
        );
      }
      entryEnv = await resolveEnvGroup(envGroup);
    } else {
      entryEnv = env;
    }

    // Write command header into the phase log before spawning.
    if (appender) {
      appender.writeLine(`[${formatTimestamp()}] $ ${phase}[${index}]: ${cmd}`);
    }

    if (callbacks.onEntryStart) {
      callbacks.onEntryStart({
        phase,
        index,
        total: entries.length,
        cmd,
      });
    }

    const startMs = Date.now();
    const result = await runOne(cmd, cwd, entryEnv, appender);
    const elapsedMs = Date.now() - startMs;

    if (callbacks.onEntryComplete) {
      const completion: LifecycleEntryCompletion = {
        phase,
        index,
        total: entries.length,
        cmd,
        exitCode: result.exitCode,
        elapsedMs,
        stderrTail: result.stderr,
      };
      if (logPath !== undefined) {
        completion.logPath = logPath;
      }
      callbacks.onEntryComplete(completion);
    }

    if (result.exitCode !== 0) {
      if (bestEffort) {
        callbacks.onWarning?.({
          index,
          cmd,
          exitCode: result.exitCode,
          stderr: result.stderr,
        });
        continue;
      }
      throw new LifecycleHookError({
        phase,
        index,
        cmd,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
  }
}
