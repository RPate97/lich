/**
 * Pretty output mode.
 *
 * Renders phases, service status, summary, and error blocks with ANSI
 * colors. When the stream is a TTY, in-progress phases animate a
 * spinner on a single line; on phase end the line is rewritten with a
 * status icon. On non-TTY streams (CI logs, captured test streams) the
 * same events render as plain lines: `▶ phase` on begin, `✓ phase`
 * (or `✗` / `…`) on end.
 *
 * No external deps — ANSI escapes are emitted directly.
 */

import type {
  ErrorBlock,
  Output,
  PhaseHandle,
  ServiceState,
  SummaryBlock,
} from "./index.js";

// ──────────────────────────────────────────────────────────────────────
// ANSI helpers
// ──────────────────────────────────────────────────────────────────────

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

// Cursor / line control (only used in TTY mode).
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `\r${ESC}2K`;

// ──────────────────────────────────────────────────────────────────────
// Icons and state styling
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// Block renderers (also reused by quiet mode for summary/error)
// ──────────────────────────────────────────────────────────────────────

/** Render an elapsed-time number in seconds with one decimal. */
export function formatElapsed(ms: number): string {
  // Seconds with one decimal — `91.2s`. Anything sub-second still reads
  // sensibly (`0.4s`, `0.0s`).
  const seconds = ms / 1000;
  return `${seconds.toFixed(1)}s`;
}

/** Format the allocated-ports cell for a service in the summary table. */
function formatPortsCell(ports: Record<string, number> | undefined): string {
  if (!ports) return "";
  const entries = Object.entries(ports);
  if (entries.length === 0) return "";
  if (entries.length === 1) {
    const [key, port] = entries[0];
    // For the single-port owned case the key is `default` — collapse to
    // the user-facing form `1 port (9000)` rather than `1 port (default=9000)`.
    if (key === "default") return `1 port (${port})`;
    return `1 port (${key}=${port})`;
  }
  return `${entries.length} ports`;
}

/**
 * When color is enabled, `padEnd` counts ANSI escape bytes toward the
 * width, breaking visual alignment. Compute the extra bytes added by a
 * paint(text, color) call so callers can pad against the visible width.
 */
function colorOverhead(color: ColorName): number {
  return COLOR[color].length + RESET.length;
}

export function renderSummary(summary: SummaryBlock, color: boolean): string {
  const lines: string[] = [];
  // Title line: optionally suffix with elapsed time (`stack up — 12.4s`).
  const titleSuffix =
    summary.elapsedMs !== undefined
      ? ` — ${formatElapsed(summary.elapsedMs)}`
      : "";
  lines.push(paint(`${summary.title}${titleSuffix}`, "bold", color));
  for (const line of summary.lines) {
    lines.push(`  ${line}`);
  }
  if (summary.services && summary.services.length > 0) {
    // Blank line separates the title-with-stack-info block from the table.
    lines.push("");
    lines.push("  services:");
    // Compute padding so the state + ports columns line up across rows.
    const nameWidth = Math.max(...summary.services.map((s) => s.name.length));
    for (const svc of summary.services) {
      const style = SERVICE_STYLE[svc.state];
      const namePadded = svc.name.padEnd(nameWidth);
      // Pad the state column to a fixed width. When color is enabled, the
      // string carries ANSI bytes that don't print — compensate so the
      // visible column width is consistent.
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
  // Trailing newline so the block is visually separated from anything after.
  return `${lines.join("\n")}\n`;
}

export function renderError(err: ErrorBlock, color: boolean): string {
  const lines: string[] = [];
  lines.push(paint(`${ICON.fail} ${err.title}`, "red", color));
  // Indent each detail line so multi-line details read as a block.
  for (const detailLine of err.detail.split("\n")) {
    lines.push(`  ${detailLine}`);
  }
  if (err.hint !== undefined) {
    lines.push(paint(`  hint: ${err.hint}`, "cyan", color));
  }
  return `${lines.join("\n")}\n`;
}

// ──────────────────────────────────────────────────────────────────────
// Output implementation
// ──────────────────────────────────────────────────────────────────────

interface MaybeTTYStream extends NodeJS.WritableStream {
  isTTY?: boolean;
}

export interface PrettyOptions {
  /**
   * When true, append per-phase elapsed time to phase-end lines and
   * surface the SummaryBlock's elapsedMs in the summary title. Defaults
   * to false so existing unit tests with `toEqual` assertions still match.
   */
  showTiming?: boolean;
}

export function createPrettyOutput(
  stream: NodeJS.WritableStream,
  opts: PrettyOptions = {},
): Output {
  const ttyStream = stream as MaybeTTYStream;
  // Use TTY-only behavior (spinners, color, cursor control) iff the
  // stream declares itself a TTY. Tests use captured streams where
  // isTTY is undefined/false, so they exercise the plain-line path.
  const isTTY = ttyStream.isTTY === true;
  const color = isTTY;
  const showTiming = opts.showTiming === true;

  // Track at most one active spinner. We don't try to render concurrent
  // phases — phases are sequential by design (see plan-1).
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

  function startSpinner(name: string): void {
    // Defensive: only one spinner at a time. Stop any prior one.
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
        stream.write(`${CLEAR_LINE}${paint(frame, "cyan", color)} ${name}`);
      }, SPINNER_TICK_MS),
    };
    // Don't keep the event loop alive for the spinner.
    if (typeof (state.timer as { unref?: () => void }).unref === "function") {
      (state.timer as { unref: () => void }).unref();
    }
    activeSpinner = state;
  }

  return {
    phase(name: string): PhaseHandle {
      const startedAt = Date.now();
      if (isTTY) {
        // Print an initial frame so the user sees the phase immediately,
        // then let the timer take over animating it.
        stream.write(`${paint(ICON.pending, "cyan", color)} ${name}`);
        startSpinner(name);
      } else {
        // Non-TTY: one line on begin, another on end. Keeps logs readable.
        stream.write(`${ICON.pending} ${name}\n`);
      }

      return {
        step(line: string): void {
          if (isTTY) {
            // Render the step on its own line above where the spinner
            // will re-draw on its next tick.
            stream.write(`${CLEAR_LINE}  ${paint(line, "gray", color)}\n`);
          } else {
            stream.write(`  ${line}\n`);
          }
        },
        end(status: "ok" | "fail" | "skip", message?: string): void {
          if (isTTY) {
            stopSpinner();
          }
          const icon = ICON[status];
          const iconColor: ColorName =
            status === "ok" ? "green" : status === "fail" ? "red" : "gray";
          // Compose the trailing suffix from message + elapsed time. Both
          // are optional; join with the same `— ` separator the framework
          // uses elsewhere so `start 1/3 (api) — 3.1s` reads naturally.
          const parts: string[] = [];
          if (message !== undefined) parts.push(message);
          if (showTiming) parts.push(formatElapsed(Date.now() - startedAt));
          const suffix = parts.length > 0 ? ` — ${parts.join(" — ")}` : "";
          stream.write(`${paint(icon, iconColor, color)} ${name}${suffix}\n`);
        },
      };
    },

    info(line: string): void {
      // Info lines compete with the spinner for the current row. In TTY
      // mode, clear and re-print above.
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

    async close(): Promise<void> {
      stopSpinner();
    },
  };
}
