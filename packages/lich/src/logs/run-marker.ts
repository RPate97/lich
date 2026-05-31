import { appendFile, mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/**
 * Per-run boundary line written to a service's log file at spawn time.
 * Matchers (ready_when.log_match, fail_when.log_match) anchor at this marker
 * so they only see lines emitted by the CURRENT run.
 *
 * Format: `=== lich up at <ISO timestamp> [run: <uuid>] ===`
 */

export const RUN_MARKER_PATTERN: RegExp =
  /^=== lich up at \S+ \[run: [0-9a-f-]+\] ===$/u;

export interface WriteRunMarkerOptions {
  now?: Date;
  runId?: string;
}

export interface RunMarkerResult {
  /** Byte offset of the file IMMEDIATELY AFTER the marker (and its trailing newline). */
  offset: number;
  /** The run id that was written into the marker. */
  runId: string;
}

/**
 * Append a run-boundary marker line to `logPath`. Creates parent dirs and the
 * file if they don't exist. Returns the file size after the marker write so
 * the caller can use it as a LogTail startOffset.
 *
 * On any failure, returns the file's current size (or 0 if unreachable) so
 * the caller can still bound the LogTail past existing content — the marker
 * is a UX nicety; offset-based filtering is the correctness boundary.
 */
export async function writeRunMarker(
  logPath: string,
  opts: WriteRunMarkerOptions = {},
): Promise<RunMarkerResult> {
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? randomUUID();
  const timestamp = now.toISOString();

  try {
    await mkdir(dirname(logPath), { recursive: true });
  } catch {
    /* best-effort — appendFile may still work or fail with a clearer error */
  }

  let existingSize = 0;
  try {
    existingSize = (await stat(logPath)).size;
  } catch {
    existingSize = 0;
  }

  const needsLeadingNewline =
    existingSize > 0 && !(await endsWithNewline(logPath, existingSize));
  const prefix = needsLeadingNewline ? "\n" : "";
  const line = `${prefix}=== lich up at ${timestamp} [run: ${runId}] ===\n`;

  try {
    await appendFile(logPath, line, "utf8");
  } catch {
    return { offset: existingSize, runId };
  }

  let offset = existingSize + Buffer.byteLength(line);
  try {
    offset = (await stat(logPath)).size;
  } catch {
    /* fall through with computed offset */
  }
  return { offset, runId };
}

async function endsWithNewline(logPath: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  const { open } = await import("node:fs/promises");
  let fh;
  try {
    fh = await open(logPath, "r");
  } catch {
    return true;
  }
  try {
    const buf = Buffer.allocUnsafe(1);
    const { bytesRead } = await fh.read(buf, 0, 1, size - 1);
    if (bytesRead < 1) return true;
    return buf[0] === 0x0a;
  } catch {
    return true;
  } finally {
    try {
      await fh.close();
    } catch {
      /* best-effort */
    }
  }
}
