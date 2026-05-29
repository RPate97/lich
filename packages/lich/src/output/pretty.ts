/**
 * Pretty output mode. TTY: animated spinner per phase, redrawn line on
 * end. Non-TTY: plain `▶`/`✓`/`✗`/`…` lines. ANSI escapes emitted directly.
 */

import type { FailureBlock } from "../failure/formatter.js";
import {
  formatHookFailureOutput,
  formatStderrSurface,
  type LifecycleEntryCompletion,
  type LifecycleEntryStart,
  type LifecyclePhase,
} from "../lifecycle/executor.js";
import type {
  ErrorBlock,
  Output,
  PhaseHandle,
  ServiceState,
  SummaryBlock,
} from "./index.js";
import { DEFAULT_COLUMNS, truncateSpinnerName } from "./truncate.js";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const COLOR = {
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
  bold: `${ESC}1m`,
} as const;

type ColorName = keyof typeof COLOR;

function paint(text: string, color: ColorName, enabled: boolean): string {
  if (!enabled) return text;
  return `${COLOR[color]}${text}${RESET}`;
}

// Cursor / line control (TTY only).
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `\r${ESC}2K`;

const ICON = {
  ok: "✓",
  fail: "✗",
  skip: "…",
  pending: "▶",
} as const;

const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
const SPINNER_TICK_MS = 80;

interface ServiceStyle {
  icon: string;
  color: ColorName;
}

const SERVICE_STYLE: Record<ServiceState, ServiceStyle> = {
  starting: { icon: "▶", color: "yellow" },
  healthy: { icon: "✓", color: "green" },
  initializing: { icon: "…", color: "yellow" },
  ready: { icon: "✓", color: "green" },
  stopping: { icon: "↓", color: "yellow" },
  failed: { icon: "✗", color: "red" },
};

/** Elapsed time formatted as seconds with one decimal (`91.2s`, `0.4s`). */
export function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds.toFixed(1)}s`;
}

/**
 * Render the "▶ <phase> (i/N): <cmd>" lifecycle-entry start line. Cmd
 * is truncated to fit `columns` so long shell commands don't wrap and
 * break the spinner redraw; reduced to first line so heredocs don't
 * paint badly. `index` is 0-based; rendered counter is 1-based.
 * Exported for unit tests.
 */
export function formatLifecycleEntryStart(
  args: { phase: LifecyclePhase; index: number; total: number; cmd: string },
  columns: number,
): string {
  const firstLine = firstLineOf(args.cmd);
  const tail = `${args.phase} (${args.index + 1}/${args.total}): ${firstLine}`;
  const truncated = truncateSpinnerName(tail, columns);
  return `${ICON.pending} ${truncated}`;
}

/** Render the "✓ <phase> (i/N) — <elapsed>" complete line; `✗` on non-zero exit. Exported for unit tests. */
export function formatLifecycleEntryComplete(args: {
  phase: LifecyclePhase;
  index: number;
  total: number;
  exitCode: number;
  elapsedMs: number;
}): string {
  const icon = args.exitCode === 0 ? ICON.ok : ICON.fail;
  return (
    `${icon} ${args.phase} (${args.index + 1}/${args.total}) — ` +
    `${formatElapsed(args.elapsedMs)}`
  );
}

function firstLineOf(cmd: string): string {
  for (const line of cmd.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return cmd;
}

function formatPortsCell(ports: Record<string, number> | undefined): string {
  if (!ports) return "";
  const entries = Object.entries(ports);
  if (entries.length === 0) return "";
  if (entries.length === 1) {
    const [key, port] = entries[0];
    // Collapse `default` to the user-facing `1 port (9000)`.
    if (key === "default") return `1 port (${port})`;
    return `1 port (${key}=${port})`;
  }
  return `${entries.length} ports`;
}

// padEnd counts ANSI escape bytes when color is on — compensate so the
// visible column width stays consistent.
function colorOverhead(color: ColorName): number {
  return COLOR[color].length + RESET.length;
}

export function renderSummary(summary: SummaryBlock, color: boolean): string {
  const lines: string[] = [];
  const titleSuffix =
    summary.elapsedMs !== undefined
      ? ` — ${formatElapsed(summary.elapsedMs)}`
      : "";
  lines.push(paint(`${summary.title}${titleSuffix}`, "bold", color));
  for (const line of summary.lines) {
    lines.push(`  ${line}`);
  }
  if (summary.services && summary.services.length > 0) {
    lines.push("");
    lines.push("  services:");
    const nameWidth = Math.max(...summary.services.map((s) => s.name.length));
    for (const svc of summary.services) {
      const style = SERVICE_STYLE[svc.state];
      const namePadded = svc.name.padEnd(nameWidth);
      const stateRendered = paint(svc.state, style.color, color);
      const padTarget = 9 + (color ? colorOverhead(style.color) : 0);
      const stateCol = stateRendered.padEnd(padTarget);
      const portsCol = formatPortsCell(svc.ports);
      const portsSuffix = portsCol ? `  ${portsCol}` : "";
      lines.push(`    ${namePadded}  ${stateCol}${portsSuffix}`.trimEnd());
    }
  }
  if (summary.urls && summary.urls.length > 0) {
    lines.push("");
    lines.push("  urls:");
    const nameWidth = Math.max(...summary.urls.map((u) => u.service.length));
    for (const entry of summary.urls) {
      const namePadded = entry.service.padEnd(nameWidth);
      lines.push(
        `    ${namePadded}  ${paint(entry.url, "cyan", color)}`,
      );
    }
  }
  if (summary.next && summary.next.length > 0) {
    lines.push("");
    lines.push("  next:");
    const cmdWidth = Math.max(...summary.next.map((h) => h.cmd.length));
    for (const hint of summary.next) {
      const cmdPadded = hint.cmd.padEnd(cmdWidth);
      lines.push(`    ${paint(cmdPadded, "bold", color)}  ${hint.description}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderError(err: ErrorBlock, color: boolean): string {
  const lines: string[] = [];
  lines.push(paint(`${ICON.fail} ${err.title}`, "red", color));
  for (const detailLine of err.detail.split("\n")) {
    lines.push(`  ${detailLine}`);
  }
  if (err.hint !== undefined) {
    lines.push(paint(`  hint: ${err.hint}`, "cyan", color));
  }
  return `${lines.join("\n")}\n`;
}

/** Render a per-service failure block. Dumb renderer — takes a FailureBlock from formatFailure and prints it. */
export function renderFailure(block: FailureBlock, color: boolean): string {
  const lines: string[] = [];
  lines.push(paint(`${ICON.fail} ${block.title}`, "red", color));
  for (const reasonLine of block.reason.split("\n")) {
    lines.push(`  ${reasonLine}`);
  }
  if (block.logTail.length > 0) {
    lines.push("  log tail:");
    for (const tailLine of block.logTail) {
      lines.push(`    ${tailLine}`);
    }
  }
  if (block.hint !== undefined) {
    // formatter pre-prefixes well-known hints with `hint: `
    lines.push(paint(`  ${block.hint}`, "cyan", color));
  }
  return `${lines.join("\n")}\n`;
}

interface MaybeTTYStream extends NodeJS.WritableStream {
  isTTY?: boolean;
  /**
   * Terminal width in cells; undefined when not a TTY. We re-read this
   * every spinner tick so SIGWINCH resizes take effect on the next frame
   * without any explicit listener.
   */
  columns?: number;
}

export interface PrettyOptions {
  /** Append per-phase elapsed time on phase-end and surface summary.elapsedMs in the title. */
  showTiming?: boolean;
}

export function createPrettyOutput(
  stream: NodeJS.WritableStream,
  opts: PrettyOptions = {},
): Output {
  const ttyStream = stream as MaybeTTYStream;
  const isTTY = ttyStream.isTTY === true;
  const color = isTTY;
  const showTiming = opts.showTiming === true;

  // At most one active spinner; phases are sequential by design.
  let activeSpinner: SpinnerState | null = null;

  interface SpinnerState {
    name: string;
    timer: NodeJS.Timeout;
    frameIndex: number;
  }

  function stopSpinner(): void {
    if (!activeSpinner) return;
    clearInterval(activeSpinner.timer);
    if (isTTY) {
      stream.write(CLEAR_LINE);
      stream.write(SHOW_CURSOR);
    }
    activeSpinner = null;
  }

  /** Re-reads `ttyStream.columns` each call so SIGWINCH resizes take effect on the next spinner tick without an explicit listener. */
  function currentColumns(): number {
    const cols = ttyStream.columns;
    return typeof cols === "number" && cols > 0 ? cols : DEFAULT_COLUMNS;
  }

  function startSpinner(name: string): void {
    stopSpinner();
    if (isTTY) {
      stream.write(HIDE_CURSOR);
    }
    const state: SpinnerState = {
      name,
      frameIndex: 0,
      timer: setInterval(() => {
        if (!activeSpinner) return;
        const frame = SPINNER_FRAMES[activeSpinner.frameIndex];
        activeSpinner.frameIndex =
          (activeSpinner.frameIndex + 1) % SPINNER_FRAMES.length;
        // Re-truncate every tick — picks up SIGWINCH resizes for free.
        const displayName = truncateSpinnerName(name, currentColumns());
        stream.write(
          `${CLEAR_LINE}${paint(frame, "cyan", color)} ${displayName}`,
        );
      }, SPINNER_TICK_MS),
    };
    // Don't keep the event loop alive just for the spinner.
    if (typeof (state.timer as { unref?: () => void }).unref === "function") {
      (state.timer as { unref: () => void }).unref();
    }
    activeSpinner = state;
  }

  return {
    phase(name: string): PhaseHandle {
      const startedAt = Date.now();
      // currentName is mutable via `.update()`; startedAt stays anchored
      // to the original begin so elapsed covers the full phase.
      let currentName = name;
      if (isTTY) {
        // Initial frame before the timer takes over; truncate up-front
        // so the first paint doesn't overflow the terminal.
        const displayName = truncateSpinnerName(currentName, currentColumns());
        stream.write(
          `${paint(ICON.pending, "cyan", color)} ${displayName}`,
        );
        startSpinner(currentName);
      } else {
        stream.write(`${ICON.pending} ${currentName}\n`);
      }

      return {
        step(line: string): void {
          if (isTTY) {
            stream.write(`${CLEAR_LINE}  ${paint(line, "gray", color)}\n`);
          } else {
            stream.write(`  ${line}\n`);
          }
        },
        update(newName: string): void {
          currentName = newName;
          if (isTTY) {
            // Restart with an immediate paint so the new name appears
            // without waiting up to SPINNER_TICK_MS for the first tick.
            stopSpinner();
            const displayName = truncateSpinnerName(
              currentName,
              currentColumns(),
            );
            stream.write(
              `${paint(ICON.pending, "cyan", color)} ${displayName}`,
            );
            startSpinner(currentName);
          } else {
            stream.write(`${ICON.pending} ${currentName}\n`);
          }
        },
        end(status: "ok" | "fail" | "skip", message?: string): void {
          if (isTTY) {
            stopSpinner();
          }
          const icon = ICON[status];
          const iconColor: ColorName =
            status === "ok" ? "green" : status === "fail" ? "red" : "gray";
          const parts: string[] = [];
          if (message !== undefined) parts.push(message);
          if (showTiming) parts.push(formatElapsed(Date.now() - startedAt));
          const suffix = parts.length > 0 ? ` — ${parts.join(" — ")}` : "";
          stream.write(`${paint(icon, iconColor, color)} ${currentName}${suffix}\n`);
        },
      };
    },

    info(line: string): void {
      // Info competes with the spinner for the current row in TTY mode.
      if (isTTY && activeSpinner) {
        stream.write(`${CLEAR_LINE}${line}\n`);
      } else {
        stream.write(`${line}\n`);
      }
    },

    service(name: string, state: ServiceState, detail?: string): void {
      const style = SERVICE_STYLE[state];
      const tag = paint(`[${name}] ${style.icon} ${state}`, style.color, color);
      const suffix = detail !== undefined ? ` ${detail}` : "";
      if (isTTY && activeSpinner) {
        stream.write(`${CLEAR_LINE}${tag}${suffix}\n`);
      } else {
        stream.write(`${tag}${suffix}\n`);
      }
    },

    summary(summary: SummaryBlock): void {
      if (isTTY) stopSpinner();
      stream.write(renderSummary(summary, color));
    },

    error(err: ErrorBlock): void {
      if (isTTY) stopSpinner();
      stream.write(renderError(err, color));
    },

    failure(block: FailureBlock): void {
      if (isTTY) stopSpinner();
      stream.write(renderFailure(block, color));
    },

    lifecycleEntryStart(start: LifecycleEntryStart): void {
      // Lifecycle entries land inside an outer phase spinner; clear the
      // line so we don't overwrite a half-drawn frame.
      const line = formatLifecycleEntryStart(start, currentColumns());
      const colored =
        isTTY && color
          ? line.replace(ICON.pending, paint(ICON.pending, "cyan", color))
          : line;
      if (isTTY && activeSpinner) {
        stream.write(`${CLEAR_LINE}${colored}\n`);
      } else {
        stream.write(`${colored}\n`);
      }
    },

    lifecycleEntryComplete(completion: LifecycleEntryCompletion): void {
      const headline = formatLifecycleEntryComplete(completion);
      const headlineColor: ColorName =
        completion.exitCode === 0 ? "green" : "red";
      const headlineColored =
        isTTY && color
          ? headline.replace(
              completion.exitCode === 0 ? ICON.ok : ICON.fail,
              paint(
                completion.exitCode === 0 ? ICON.ok : ICON.fail,
                headlineColor,
                color,
              ),
            )
          : headline;
      if (isTTY && activeSpinner) {
        stream.write(`${CLEAR_LINE}${headlineColored}\n`);
      } else {
        stream.write(`${headlineColored}\n`);
      }

      function writeLine(line: string): void {
        if (isTTY && activeSpinner) {
          stream.write(`${CLEAR_LINE}${line}\n`);
        } else {
          stream.write(`${line}\n`);
        }
      }

      if (completion.exitCode !== 0 && completion.logPath !== undefined) {
        // Failure: dump full combined stdout+stderr from the log file (tailed, capped).
        const result = formatHookFailureOutput({
          phase: completion.phase,
          index: completion.index,
          total: completion.total,
          cmd: completion.cmd,
          exitCode: completion.exitCode,
          logPath: completion.logPath,
        });
        if (result !== null) {
          for (const line of result.lines) {
            writeLine(`  ${line}`);
          }
          writeLine(paint(`  ${result.footer}`, "gray", color));
        }
      } else {
        // Success (exit 0): surface stderr inline if any (the `cmd || true` pattern).
        const stderrLine = formatStderrSurface({
          phase: completion.phase,
          index: completion.index,
          total: completion.total,
          cmd: completion.cmd,
          stderrTail: completion.stderrTail,
        });
        if (stderrLine !== null) {
          writeLine(stderrLine);
        }
      }
    },

    async close(): Promise<void> {
      stopSpinner();
    },
  };
}
