import {
  formatProcessExitFailure,
  type ProcessExitFailure,
} from "./process-exit.js";

/** Discriminated union covering every kind of per-service failure. */
export type FailureInput =
  | {
      kind: "exit";
      service: string;
      exit: ProcessExitFailure;
      logBuffer?: string;
    }
  | {
      kind: "timeout";
      service: string;
      ms: number;
      phase?: string;
      logBuffer?: string;
    }
  | {
      kind: "fail_when";
      service: string;
      matchedLine: string;
      logBuffer?: string;
    }
  | {
      kind: "capture_miss";
      service: string;
      captureKey: string;
      logBuffer?: string;
    };

/** Renderer-agnostic representation of one per-service failure. */
export interface FailureBlock {
  title: string;
  reason: string;
  /** Last N (typically 20) log lines, newline-stripped, oldest-first. */
  logTail: string[];
  hint?: string;
}

const LOG_TAIL_LINES = 20;

/** Turn a FailureInput into a FailureBlock. Pure function. */
export function formatFailure(input: FailureInput): FailureBlock {
  const logTail = extractLogTail(input.logBuffer);

  switch (input.kind) {
    case "exit": {
      const reason = formatProcessExitFailure(input.exit);
      const block: FailureBlock = {
        title: `service "${input.service}" failed`,
        reason,
        logTail,
      };
      const hint = inferHint(input);
      if (hint !== undefined) block.hint = hint;
      return block;
    }

    case "timeout": {
      const human = renderDurationMs(input.ms);
      const phaseSuffix =
        input.phase !== undefined ? ` (${input.phase})` : "";
      const block: FailureBlock = {
        title: `service "${input.service}" did not become ready in ${human}`,
        reason: `ready_when did not satisfy within ${human}${phaseSuffix}`,
        logTail,
      };
      const hint = inferHint(input);
      if (hint !== undefined) block.hint = hint;
      return block;
    }

    case "fail_when": {
      const safeLine = input.matchedLine.replace(/"/g, '\\"');
      const block: FailureBlock = {
        title: `service "${input.service}" matched fail_when pattern`,
        reason: `fail_when matched log line: "${safeLine}"`,
        logTail,
      };
      const hint = inferHint(input);
      if (hint !== undefined) block.hint = hint;
      return block;
    }

    case "capture_miss": {
      const block: FailureBlock = {
        title: `service "${input.service}" capture "${input.captureKey}" not found`,
        reason: `ready_when.capture key "${input.captureKey}" did not match any line in the service log`,
        logTail,
      };
      const hint = inferHint(input);
      if (hint !== undefined) block.hint = hint;
      return block;
    }

    default: {
      return assertNever(input);
    }
  }
}

/**
 * Trim a raw log buffer to the last LOG_TAIL_LINES complete lines.
 * Includes a trailing partial line so a service that crashed mid-line still
 * has its dying gasp visible.
 */
function extractLogTail(buffer: string | undefined): string[] {
  if (buffer === undefined || buffer.length === 0) return [];

  const normalized = buffer.replace(/\r\n/g, "\n");

  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length <= LOG_TAIL_LINES) return lines;
  return lines.slice(lines.length - LOG_TAIL_LINES);
}

// Keep suffixes in sync with parseDuration in ready/timeout.ts so a "2m"
// config round-trips back to "2m" in the failure title.
function renderDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return `${ms}ms`;
  }
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function inferHint(input: FailureInput): string | undefined {
  switch (input.kind) {
    case "fail_when": {
      if (input.matchedLine.includes("EADDRINUSE")) {
        return "hint: run `lich stacks` to find what's using the port";
      }
      if (input.matchedLine.includes("Cannot find module")) {
        return (
          "hint: run `bun install` (or your package manager equivalent) " +
          "in the service's directory"
        );
      }
      return undefined;
    }
    case "timeout": {
      return (
        "hint: increase ready_when.timeout or check the service is actually responding"
      );
    }
    case "capture_miss": {
      return (
        `hint: verify the regex matches the line the service actually printed; ` +
        `check \`lich logs ${input.service}\` for the full log`
      );
    }
    case "exit": {
      return undefined;
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled failure input variant: ${JSON.stringify(value)}`);
}
