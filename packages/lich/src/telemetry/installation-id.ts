import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const ID_FILENAME = "installation-id";
// Accepts either format: legacy UUIDv4 (36 chars with dashes) or the current
// 32-char hex hash. Lets older installs keep the id they already have.
const VALID_ID_RE = /^([0-9a-f-]{36}|[0-9a-f]{32})$/i;

function defaultPath(): string {
  return join(process.env.LICH_HOME ?? join(homedir(), ".lich"), ID_FILENAME);
}

/**
 * Anonymous installation identifier used as PostHog's distinct_id. Derived
 * from machine-stable inputs (real homedir, hostname, platform-arch) so the
 * same user on the same machine maps to the same id across worktrees, fresh
 * LICH_HOME dirs, container rebuilds, and `~/.lich` wipes.
 *
 * Cached at `<LICH_HOME>/installation-id` once derived. Existing legacy
 * UUIDv4 ids from earlier builds remain valid (read back as-is); only fresh
 * installs use the derived form.
 *
 * The cached file becomes the source of truth — if a user wants a different
 * id, they can write any 32-hex / UUIDv4 value into it manually.
 *
 * Returns `null` if both cache I/O and derivation fail — telemetry then
 * sends events without a distinct_id rather than crashing the CLI.
 */
export function getInstallationId(path: string = defaultPath()): string | null {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8").trim();
      if (VALID_ID_RE.test(raw)) return raw;
    }
    const id = deriveStableId();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, id + "\n", { mode: 0o600 });
    return id;
  } catch {
    return null;
  }
}

/**
 * Stable per-machine hash. Inputs are hashed with a fixed salt so:
 *   - the underlying values (homedir contains username, hostname is the
 *     machine name) never leave the device
 *   - two installs on the same machine collapse to one distinct_id
 *   - tests using temp LICH_HOME dirs all derive the same id, so any
 *     telemetry leak in CI collapses to a single ghost user instead of
 *     hundreds.
 */
export function deriveStableId(): string {
  try {
    const stable = [
      homedir(),
      hostname(),
      `${process.platform}-${process.arch}`,
    ].join("\0");
    return createHash("sha256")
      .update("lich-installation-v1\0" + stable)
      .digest("hex")
      .slice(0, 32);
  } catch {
    return randomUUID();
  }
}
