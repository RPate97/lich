/**
 * Per-phase progress UX framework (LEV-217).
 *
 * The problem: `lich dev` runs through phases that take anywhere from
 * 10ms (config load) to 60s (cold `docker pull` + healthchecks). Pre-LEV-217
 * the CLI was silent until the final summary printed, so humans had no
 * signal whether the run was hung or working. This module gives commands a
 * tiny TTY-aware reporter API to wrap each meaningful phase; users see a
 * spinner with an elapsed-time counter while work is in flight, and a
 * checkmark when each phase resolves.
 *
 * Design constraints (from the LEV-217 ticket):
 *
 *  - **Stderr by default.** Progress is metadata about the operation, not
 *    the operation's result. Tests and scripts that parse `--json` stdout
 *    must never see progress noise; routing to stderr keeps the
 *    `runCli`-style consumers (spawnSync stdout capture) unaffected.
 *
 *  - **Three modes**:
 *      - `tty`: interactive spinner with ANSI escape codes, in-place
 *        updates via `\r` + clear-line, elapsed-time counter, cursor
 *        hide/show. Used when stderr is a TTY and we're not in CI/NO_COLOR.
 *      - `plain`: one timestamped line per state change. No ANSI. Safe to
 *        pipe, log, or capture. Used in CI, when stderr isn't a TTY, when
 *        NO_COLOR is set, or when piping to `cat`/`tee`.
 *      - `silent`: no-op. Used when `--json` is set (machine consumers
 *        get a clean, untouched stderr).
 *
 *  - **Sequential steps only (v1).** Concurrent spinners are deferred —
 *    every command site today calls `step` in serial. If a later phase
 *    starts a new step before the previous one resolved, the previous
 *    line is cleared first so the spinner re-renders cleanly under each
 *    new step's frame.
 *
 *  - **No new external deps.** ~80 lines of homegrown ANSI is fine — the
 *    spinner frame set is the standard braille dots, the clear-line
 *    sequence is `\x1b[2K\r`, and cursor hide/show are `\x1b[?25l` /
 *    `\x1b[?25h`. The whole spinner pipeline costs nothing to import.
 *
 *  - **Signal-safe cursor restore.** When a SIGINT fires while a spinner
 *    is active the cursor would stay hidden if we didn't restore it —
 *    we register a cleanup via {@link addCleanup} from `signal-handlers`
 *    on first install so a Ctrl-C during `dev` doesn't leave the user's
 *    shell with a missing cursor. The registration is removed when the
 *    reporter shuts down cleanly.
 */
import { addCleanup } from '../signal-handlers';

export type ProgressMode = 'tty' | 'plain' | 'silent';

export interface Step {
  /** Begin tracking; in TTY mode this starts the spinner animating. */
  start(): void;
  /** Finish OK. Optional `detail` is appended after the label. */
  succeed(detail?: string): void;
  /** Finish with an error. `err` is appended after the label. */
  fail(err?: string): void;
  /** Optionally change the label mid-flight (e.g. after a slow phase reveals more detail). */
  update(label: string): void;
}

export interface ProgressReporter {
  step(label: string): Step;
  /**
   * Wrapper for the common "start, do work, succeed (or fail-and-rethrow)"
   * pattern. Sites that don't care to manage `Step` themselves can call
   * `reporter.group('Booting plugins', async (step) => { ... })` and get
   * the right error surface for free.
   */
  group<T>(label: string, fn: (step: Step) => Promise<T>): Promise<T>;
  /**
   * Tear down any in-flight visual state (clear spinner, restore cursor,
   * unregister signal cleanup). Idempotent. Called automatically when the
   * process exits cleanly, but commands may also call it explicitly if
   * they're switching to a different rendering mode (e.g. handing stdout
   * back to `concurrently` for `--live`).
   */
  shutdown(): void;
}

export interface CreateReporterOpts {
  mode: ProgressMode;
  /** Defaults to `process.stderr`. */
  stream?: NodeJS.WriteStream;
}

// ---------------------------------------------------------------------------
// ANSI primitives
// ---------------------------------------------------------------------------

/**
 * Braille-dot spinner frames. Same set ora/yoctospinner use — feels
 * familiar and renders in every Unicode-capable terminal. ASCII fallback
 * is intentionally not implemented; in non-TTY environments the plain
 * mode kicks in instead.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;

const ANSI = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K\r',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

// ---------------------------------------------------------------------------
// Silent reporter — no-op shell
// ---------------------------------------------------------------------------

function createSilentReporter(): ProgressReporter {
  const noopStep: Step = {
    start() {},
    succeed() {},
    fail() {},
    update() {},
  };
  return {
    step() {
      return noopStep;
    },
    async group(_label, fn) {
      return fn(noopStep);
    },
    shutdown() {},
  };
}

// ---------------------------------------------------------------------------
// Plain reporter — one line per transition, no ANSI
// ---------------------------------------------------------------------------

function createPlainReporter(stream: NodeJS.WriteStream): ProgressReporter {
  const reporterStart = Date.now();

  function ts(): string {
    return `[${formatElapsed(Date.now() - reporterStart)}]`;
  }

  function makeStep(label: string): Step {
    let started = false;
    let finished = false;
    let stepStart = 0;
    let currentLabel = label;
    return {
      start() {
        if (started) return;
        started = true;
        stepStart = Date.now();
        stream.write(`${ts()} > ${currentLabel}\n`);
      },
      succeed(detail) {
        if (finished) return;
        finished = true;
        const elapsed = formatElapsed(Date.now() - stepStart);
        const tail = detail ? ` ${detail}` : '';
        stream.write(`${ts()} ok ${currentLabel} (${elapsed})${tail}\n`);
      },
      fail(err) {
        if (finished) return;
        finished = true;
        const elapsed = formatElapsed(Date.now() - stepStart);
        const tail = err ? ` ${err}` : '';
        stream.write(`${ts()} FAIL ${currentLabel} (${elapsed})${tail}\n`);
      },
      update(next) {
        currentLabel = next;
        if (started && !finished) {
          stream.write(`${ts()} > ${currentLabel}\n`);
        }
      },
    };
  }

  return {
    step(label) {
      return makeStep(label);
    },
    async group(label, fn) {
      const s = makeStep(label);
      s.start();
      try {
        const r = await fn(s);
        s.succeed();
        return r;
      } catch (err) {
        s.fail(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    shutdown() {},
  };
}

// ---------------------------------------------------------------------------
// TTY reporter — single rolling spinner
// ---------------------------------------------------------------------------

interface ActiveSpinner {
  label: string;
  start: number;
  timer: NodeJS.Timeout;
  frame: number;
}

function createTtyReporter(stream: NodeJS.WriteStream): ProgressReporter {
  let active: ActiveSpinner | null = null;
  let unregisterCleanup: (() => void) | null = null;
  let cursorHidden = false;

  function hideCursorIfNeeded(): void {
    if (cursorHidden) return;
    stream.write(ANSI.hideCursor);
    cursorHidden = true;
  }

  function showCursorIfNeeded(): void {
    if (!cursorHidden) return;
    stream.write(ANSI.showCursor);
    cursorHidden = false;
  }

  function clearActiveLine(): void {
    stream.write(ANSI.clearLine);
  }

  function paint(): void {
    if (!active) return;
    const elapsed = formatElapsed(Date.now() - active.start);
    const frame = FRAMES[active.frame % FRAMES.length]!;
    active.frame++;
    stream.write(
      `${ANSI.clearLine}${ANSI.cyan}${frame}${ANSI.reset} ${active.label} ${ANSI.dim}(${elapsed})${ANSI.reset}`,
    );
  }

  function ensureSignalCleanup(): void {
    if (unregisterCleanup) return;
    // Register exactly once on first spinner start so a Ctrl-C while a
    // step is in flight restores the cursor. Idempotent unregister on
    // `shutdown` so process exit doesn't leave a dangling closure.
    unregisterCleanup = addCleanup(() => {
      stopActive();
      showCursorIfNeeded();
    });
  }

  function stopActive(): void {
    if (!active) return;
    clearInterval(active.timer);
    active = null;
    clearActiveLine();
  }

  function makeStep(label: string): Step {
    let started = false;
    let finished = false;
    let myLabel = label;
    let myStart = 0;
    return {
      start() {
        if (started) return;
        started = true;
        myStart = Date.now();
        // If another spinner is still running (sequential-only assumption
        // means this is unusual but possible if a caller forgot to resolve
        // the previous step), retire it silently — the new spinner takes
        // the line.
        if (active) stopActive();
        ensureSignalCleanup();
        hideCursorIfNeeded();
        active = {
          label: myLabel,
          start: myStart,
          frame: 0,
          timer: setInterval(paint, FRAME_INTERVAL_MS),
        };
        // Unref so a still-spinning timer doesn't keep the process alive
        // past a clean main() return. The spinner will get one final paint
        // from `succeed`/`fail` either way.
        active.timer.unref?.();
        paint(); // immediate first frame so the user sees the spinner instantly
      },
      succeed(detail) {
        if (finished) return;
        finished = true;
        const elapsed = formatElapsed(Date.now() - myStart);
        if (active && active.label === myLabel) stopActive();
        const tail = detail ? ` ${ANSI.dim}${detail}${ANSI.reset}` : '';
        stream.write(
          `${ANSI.clearLine}${ANSI.green}✓${ANSI.reset} ${myLabel} ${ANSI.dim}(${elapsed})${ANSI.reset}${tail}\n`,
        );
      },
      fail(err) {
        if (finished) return;
        finished = true;
        const elapsed = formatElapsed(Date.now() - myStart);
        if (active && active.label === myLabel) stopActive();
        const tail = err ? ` ${ANSI.red}${err}${ANSI.reset}` : '';
        stream.write(
          `${ANSI.clearLine}${ANSI.red}✗${ANSI.reset} ${myLabel} ${ANSI.dim}(${elapsed})${ANSI.reset}${tail}\n`,
        );
      },
      update(next) {
        myLabel = next;
        if (active && started && !finished) {
          active.label = next;
          paint(); // immediate repaint so the new label doesn't wait for the next frame
        }
      },
    };
  }

  return {
    step(label) {
      return makeStep(label);
    },
    async group(label, fn) {
      const s = makeStep(label);
      s.start();
      try {
        const r = await fn(s);
        s.succeed();
        return r;
      } catch (err) {
        s.fail(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    shutdown() {
      stopActive();
      showCursorIfNeeded();
      if (unregisterCleanup) {
        unregisterCleanup();
        unregisterCleanup = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function createProgressReporter(opts: CreateReporterOpts): ProgressReporter {
  const stream = opts.stream ?? process.stderr;
  switch (opts.mode) {
    case 'silent':
      return createSilentReporter();
    case 'plain':
      return createPlainReporter(stream);
    case 'tty':
      return createTtyReporter(stream);
  }
}

/**
 * Resolve the right progress mode for a given invocation. Centralized so
 * every command site agrees on the precedence:
 *
 *   1. `--json` (or any explicit silent override)  → silent
 *   2. Not a TTY                                    → plain
 *   3. `CI=true`/`CI=1`                             → plain
 *   4. `NO_COLOR` set                               → plain
 *   5. else                                         → tty
 *
 * Coding agents (and many CI runners) set `NO_COLOR` to disable ANSI; plain
 * mode is the safer choice there because every transition still prints a
 * legible line.
 */
export function detectProgressMode(opts: {
  format: 'json' | 'pretty';
  stream?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}): ProgressMode {
  if (opts.format === 'json') return 'silent';
  const stream = opts.stream ?? process.stderr;
  const env = opts.env ?? process.env;
  if (!stream.isTTY) return 'plain';
  if (env['CI'] === 'true' || env['CI'] === '1') return 'plain';
  if (env['NO_COLOR']) return 'plain';
  return 'tty';
}
