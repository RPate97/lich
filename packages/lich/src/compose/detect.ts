/**
 * Compose CLI detection.
 *
 * lich supports three compose CLIs interchangeably: `docker compose`,
 * `podman compose`, and `nerdctl compose`. All three accept the same
 * `-p <project> -f <file> <subcommand>` shape we use throughout the
 * runner, so the only thing that varies is the binary + leading args.
 *
 * `detectComposeCli()` probes them in order — docker first (most common
 * in our target environments), then podman, then nerdctl — and returns
 * the first one whose `<cmd> compose version --short` exits 0. That
 * probe is the canonical "is compose installed and wired up" check.
 *
 * `resolveComposeCli(override)` honors the user's `runtime.compose_cli`
 * setting from `lich.yaml` (passed in here as a string), falling back
 * to detection when the override is unset. The chosen CLI is always
 * probed before being returned so we surface a useful error rather than
 * letting a later `up`/`down` fail with a confusing ENOENT.
 *
 * Both functions are pure logic on top of a single I/O seam (`_probe`)
 * so unit tests can drive them without invoking docker.
 */

import { execFile } from "node:child_process";

export type ComposeCli =
  | { kind: "docker"; cmd: "docker"; args: ["compose"] }
  | { kind: "podman"; cmd: "podman"; args: ["compose"] }
  | { kind: "nerdctl"; cmd: "nerdctl"; args: ["compose"] };

/**
 * Ordered list of candidates; detection walks this in order and the
 * resolve override looks values up by kind.
 */
const CANDIDATES: readonly ComposeCli[] = [
  { kind: "docker", cmd: "docker", args: ["compose"] },
  { kind: "podman", cmd: "podman", args: ["compose"] },
  { kind: "nerdctl", cmd: "nerdctl", args: ["compose"] },
] as const;

/**
 * Probe a CLI by running `<cmd> <args...> version --short`. Returns
 * true iff the process exits with code 0. Any error (missing binary,
 * non-zero exit, signal) returns false — callers treat false uniformly
 * as "this CLI is not usable".
 *
 * Implemented via `execFile` (no shell) so a missing binary surfaces
 * as an ENOENT we catch, not a shell error message.
 */
function realProbe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, [...args, "version", "--short"], (err) => {
      resolve(!err);
    });
  });
}

/**
 * Indirection seam so tests can override the probe without touching
 * child_process. Production code uses `_probe.current` everywhere; tests
 * swap it out for a function that returns deterministic results.
 */
export const _probe: {
  current: (cmd: string, args: string[]) => Promise<boolean>;
} = { current: realProbe };

/**
 * Detect the first available compose CLI in the order docker → podman →
 * nerdctl. Throws a useful error if none of the three respond to a
 * version probe.
 */
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
 * Resolve which compose CLI to use, honoring the override from the
 * lich.yaml `runtime.compose_cli` setting when provided. Always probes
 * the chosen CLI exists before returning so callers don't hit ENOENT
 * later.
 *
 * - `override === undefined`: full detection (same as `detectComposeCli`).
 * - `override === 'docker' | 'podman' | 'nerdctl'`: probe just that one;
 *   throw if not available.
 */
export async function resolveComposeCli(
  override?: "docker" | "podman" | "nerdctl" | undefined,
): Promise<ComposeCli> {
  if (override === undefined) {
    return detectComposeCli();
  }
  const chosen = CANDIDATES.find((c) => c.kind === override);
  if (!chosen) {
    // Defensive: TypeScript already narrows, but a runtime guard helps
    // catch bad casts from yaml parse code that might bypass the type.
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
