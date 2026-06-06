import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FLAG_FILENAME = "seen-telemetry-notice";

const NOTICE = [
  "",
  "lich collects anonymous CLI usage telemetry (command name, exit code,",
  "duration, version, platform). No paths, no config contents, no env values.",
  "Disable with LICH_TELEMETRY=0. Details: https://lich.sh/telemetry",
  "",
].join("\n");

function defaultFlagPath(): string {
  return join(process.env.LICH_HOME ?? join(homedir(), ".lich"), FLAG_FILENAME);
}

/**
 * Show the one-time first-run notice and persist a flag so it never shows
 * again. Best-effort: any I/O error swallows silently — never block a CLI
 * command on the notice.
 *
 * No-op if telemetry is disabled (caller is responsible for checking).
 */
export function maybeShowFirstRunNotice(opts: {
  out?: NodeJS.WritableStream;
  flagPath?: string;
} = {}): void {
  const flagPath = opts.flagPath ?? defaultFlagPath();
  const out = opts.out ?? process.stderr;
  try {
    if (existsSync(flagPath)) return;
    out.write(NOTICE);
    mkdirSync(join(flagPath, ".."), { recursive: true });
    writeFileSync(flagPath, new Date().toISOString() + "\n", { mode: 0o600 });
  } catch {
    // best-effort
  }
}
