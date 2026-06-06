import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ID_FILENAME = "installation-id";

function defaultPath(): string {
  return join(process.env.LICH_HOME ?? join(homedir(), ".lich"), ID_FILENAME);
}

/**
 * Anonymous per-installation UUID. Generated once on first read and persisted
 * at `<LICH_HOME>/installation-id`. Used as PostHog's distinct_id so events
 * from one machine cluster together without any user-identifying data.
 *
 * Returns `null` if reading/writing the id file fails (read-only home, etc.) —
 * telemetry just sends events without a distinct_id rather than failing.
 */
export function getInstallationId(path: string = defaultPath()): string | null {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(raw)) return raw;
    }
    const id = randomUUID();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, id + "\n", { mode: 0o600 });
    return id;
  } catch {
    return null;
  }
}
