// Heavy-pool tests run singleFork (sequential) but each leaves behind a fat
// Tart VM (4GB+) and/or docker compose containers. macOS's compressed
// memory + asynchronous compose teardown means the next test sometimes
// starts before the previous test's resources have actually released —
// new VM boots then fail with "got no IP" (memory pressure) or "port 5432
// already in use" (docker container half-gone).
//
// These helpers exist to:
//   1. Sweep any orphan `lich-run-*` VMs from previous test crashes
//      before a test starts. (Goldens are preserved — they're the point of
//      warm-fork.)
//   2. Force-remove any docker containers with lich's compose project
//      naming so port 5432 et al are actually free.
//   3. Wait, with a polling deadline, for a specific stack's resources to
//      be gone after `lich down`. Until the poll succeeds, the next test
//      shouldn't start.
//
// Best-effort: a failure inside any helper is logged but never throws,
// so a missing `tart` or `docker` binary in some environment doesn't
// break tests that don't actually need them.

import { spawnSync } from "node:child_process";

const TEN_SECONDS = 10_000;
const THIRTY_SECONDS = 30_000;

function run(cmd: string, args: string[], timeoutMs = TEN_SECONDS): { stdout: string; status: number | null } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  return { stdout: r.stdout ?? "", status: r.status };
}

function tartList(): string[] {
  const r = run("tart", ["list", "--format", "json"]);
  if (r.status !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => (typeof v === "object" && v !== null && "Name" in v ? String((v as { Name: unknown }).Name) : null))
      .filter((s): s is string => s !== null);
  } catch {
    return [];
  }
}

function tartDelete(name: string): void {
  run("tart", ["stop", name], TEN_SECONDS);
  run("tart", ["delete", name], TEN_SECONDS);
}

/**
 * Destroy every `lich-run-*` Tart VM on the host. Goldens (`lich-golden-*`)
 * are preserved — they're the warm-fork cache and should outlive tests.
 * Returns the number of run VMs removed.
 */
export function sweepLichRunVms(): number {
  const all = tartList();
  const runs = all.filter((n) => n.startsWith("lich-run-"));
  for (const n of runs) tartDelete(n);
  return runs.length;
}

/**
 * Force-remove docker containers whose name matches lich's compose project
 * naming. Lich's compose project = stack_id (`<name>-<8-hex>`); each service
 * inside it gets a name like `<name>-<8-hex>-<service>-<index>`. We also catch
 * the `lich-*` prefix used by some internal containers. Tight regex to avoid
 * eating unrelated containers the developer happens to have on the host.
 */
export function sweepLichComposeContainers(): number {
  const r = run("docker", ["ps", "-a", "--format", "{{.Names}}"], TEN_SECONDS);
  if (r.status !== 0) return 0;
  const names = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((n) => /^lich-/.test(n) || /^(workspace|stack)-[a-f0-9]{4,}/.test(n));
  for (const n of names) {
    run("docker", ["rm", "-f", n], TEN_SECONDS);
  }
  return names.length;
}

/**
 * Composite pre-test sweep. Call from `beforeAll`. Logs a single line
 * summary so test output stays readable.
 */
export function sweepStaleLichResources(): void {
  const runs = sweepLichRunVms();
  const containers = sweepLichComposeContainers();
  if (runs > 0 || containers > 0) {
    // eslint-disable-next-line no-console
    console.log(`[heavy-cleanup] swept ${runs} stale lich-run VM(s) and ${containers} docker container(s)`);
  }
}

interface WaitForTeardownOpts {
  /** Run VM names (Tart) to wait for absence of. */
  runVmNames?: string[];
  /** Docker container names to wait for removal of. */
  composeContainerNames?: string[];
  /** Total deadline. Default 30s — enough for compose down to settle. */
  timeoutMs?: number;
}

/**
 * Poll until every named Tart VM and docker container is gone. Returns
 * true on clean teardown, false on timeout. Never throws.
 *
 * Use from `afterAll` after `lich down --purge`, *before* the next test
 * starts, so the next test sees a clean host.
 */
export async function waitForStackTeardown(opts: WaitForTeardownOpts): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? THIRTY_SECONDS);
  const runVms = opts.runVmNames ?? [];
  const containers = opts.composeContainerNames ?? [];

  while (Date.now() < deadline) {
    const present = new Set(tartList());
    const remainingVms = runVms.filter((n) => present.has(n));

    const dockerNames = (() => {
      const r = run("docker", ["ps", "-a", "--format", "{{.Names}}"], 5_000);
      if (r.status !== 0) return new Set<string>();
      return new Set(r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0));
    })();
    const remainingContainers = containers.filter((n) => dockerNames.has(n));

    if (remainingVms.length === 0 && remainingContainers.length === 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }

  return false;
}

/**
 * Free pages × page size. macOS Mach `vm_stat` parser. Returns null if the
 * binary isn't there (Linux CI). Used to skip / pause tests when the host
 * is too pressured to safely spin a new 4GB VM.
 */
export function freeMemoryMb(): number | null {
  const r = run("vm_stat", [], 3_000);
  if (r.status !== 0) return null;
  const pageSize = (() => {
    const m = r.stdout.match(/page size of (\d+) bytes/);
    return m ? Number(m[1]) : 4096;
  })();
  const free = (() => {
    const m = r.stdout.match(/Pages free:\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  })();
  const inactive = (() => {
    const m = r.stdout.match(/Pages inactive:\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  })();
  // Inactive pages are reclaimable on demand; count half as headroom.
  return Math.round(((free + inactive / 2) * pageSize) / 1024 / 1024);
}

/**
 * Block until at least `minMb` of memory headroom is available. Times out
 * silently — caller should still attempt the work; better a real error
 * from the operation than a synthetic skip.
 */
export async function waitForFreeMemoryHeadroom(minMb: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = freeMemoryMb();
    if (free === null) return; // not on macOS, nothing to gate
    if (free >= minMb) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
