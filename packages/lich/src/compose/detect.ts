/**
 * Compose CLI detection. Supports `docker compose`, `podman compose`, and
 * `nerdctl compose` interchangeably (same `-p <project> -f <file>` shape).
 * Detection probes in order docker → podman → nerdctl and returns the first
 * one whose `<cmd> compose version --short` exits 0.
 */

import { execFile } from "node:child_process";

export type ComposeCli =
  | { kind: "docker"; cmd: "docker"; args: ["compose"] }
  | { kind: "podman"; cmd: "podman"; args: ["compose"] }
  | { kind: "nerdctl"; cmd: "nerdctl"; args: ["compose"] };

const CANDIDATES: readonly ComposeCli[] = [
  { kind: "docker", cmd: "docker", args: ["compose"] },
  { kind: "podman", cmd: "podman", args: ["compose"] },
  { kind: "nerdctl", cmd: "nerdctl", args: ["compose"] },
] as const;

/**
 * Probe `<cmd> <args...> version --short`. Returns true iff exit 0. Uses
 * `execFile` (no shell) so a missing binary surfaces as ENOENT we catch.
 */
function realProbe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, [...args, "version", "--short"], (err) => {
      resolve(!err);
    });
  });
}

/** Indirection seam for tests to override the probe without touching child_process. */
export const _probe: {
  current: (cmd: string, args: string[]) => Promise<boolean>;
} = { current: realProbe };

/** Detect the first available compose CLI. Throws if none respond. */
export async function detectComposeCli(): Promise<ComposeCli> {
  for (const candidate of CANDIDATES) {
    if (await _probe.current(candidate.cmd, candidate.args)) {
      return candidate;
    }
  }
  throw new Error(
    "No compose CLI found. Tried `docker compose`, `podman compose`, " +
      "and `nerdctl compose`. Install one of them and ensure it is on " +
      "your PATH.",
  );
}

/**
 * Resolve which compose CLI to use, honoring `runtime.compose_cli` override.
 * Always probes the chosen CLI so callers don't hit ENOENT later.
 */
export async function resolveComposeCli(
  override?: "docker" | "podman" | "nerdctl" | undefined,
): Promise<ComposeCli> {
  if (override === undefined) {
    return detectComposeCli();
  }
  const chosen = CANDIDATES.find((c) => c.kind === override);
  if (!chosen) {
    // Defensive: TypeScript narrows, but a runtime guard catches bad casts
    // from yaml parse code that might bypass the type.
    throw new Error(
      `Unknown compose CLI override: ${String(override)}. ` +
        `Expected one of: docker, podman, nerdctl.`,
    );
  }
  if (!(await _probe.current(chosen.cmd, chosen.args))) {
    throw new Error(
      `runtime.compose_cli is set to '${override}' but \`${chosen.cmd} ` +
        `${chosen.args.join(" ")} version --short\` did not succeed. ` +
        `Install ${override} or change runtime.compose_cli.`,
    );
  }
  return chosen;
}
