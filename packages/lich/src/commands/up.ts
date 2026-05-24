/**
 * `lich up` — the top-level orchestrator (Plan 1 Task 23).
 *
 * Wires every Plan-1 subsystem together. Sequence:
 *
 *   1. Parse + schema-validate the yaml (`config/parse.ts`).
 *   2. Detect the worktree (`worktree/detect.ts`).
 *   3. Build the dependency graph + topo-sort (`deps/`).
 *   4. Allocate host ports atomically for every service that needs them
 *      (`ports/allocator.ts`).
 *   5. Resolve top-level env for lifecycle hooks (`env/resolve.ts`).
 *   6. Init the per-stack state directory + write a starting state.json
 *      (`state/`).
 *   7. Generate the compose override file (`compose/override.ts`).
 *   8. Detect the compose CLI (`compose/detect.ts`).
 *   9. Run `lifecycle.before_up` (`lifecycle/executor.ts`).
 *  10. For each level in the topo order, start services in parallel:
 *        - run `lifecycle.before_start` (per-service)
 *        - owned: spawn via supervisor (oneshot via runOneshot; multi-port
 *          via ports map; stop_cmd preserved on handle for later)
 *        - compose: invoke compose up (detached) for that service name
 *        - wait for `ready_when` to pass
 *        - run `lifecycle.after_ready`
 *        - update state.json as the service transitions
 *  11. Run `lifecycle.after_up`.
 *  12. Mark stack `status: up` in state.json.
 *  13. Emit a summary via `output/`.
 *
 * Failure handling (Plan 1 surface — Plan 4 will add capture, fail_when,
 * rollback UX, ready timeouts):
 *
 *   - Any failure marks state.json `status: failed` and the offending
 *     service `state: failed`, prints an error block, returns exit code 1.
 *   - We do NOT auto-tear-down what's already running. The user/agent
 *     runs `lich down` to clean up. (Auto-rollback comes in Plan 4.)
 */

import { runLifecycle } from "../lifecycle/executor.js";
import { runPerServiceLifecycle } from "../lifecycle/per-service.js";
import { resolveEnvGroup } from "../groups/resolve.js";
import { parseConfig } from "../config/parse.js";
import { detectWorktree, type Worktree } from "../worktree/detect.js";
import { allocate, release } from "../ports/allocator.js";
import { resolveComposeCli, type ComposeCli } from "../compose/detect.js";
import { up as composeUp, type RunnerCtx } from "../compose/runner.js";
import { writeComposeOverride } from "../compose/override.js";
import {
  resolveEnvForService,
  resolveTopLevelEnv,
} from "../env/resolve.js";
import {
  ensureStackDir,
  serviceLogPath,
  stackDir,
} from "../state/directory.js";
import {
  readSnapshot,
  writeSnapshot,
  type ServiceSnapshot,
  type ServiceState,
  type StackSnapshot,
  type StackStatus,
} from "../state/snapshot.js";
// LEV-387 (Plan 3 Task 13): profile resolution imports.
import { pickDefaultProfile } from "../profiles/default.js";
import {
  resolveProfile,
  ProfileResolveError,
  ProfileCycleError,
  type ResolvedProfile,
} from "../profiles/resolve.js";
import {
  startOwnedService,
  runOneshot,
  type OwnedHandle,
  type OwnedServiceSpec,
} from "../owned/supervisor.js";
import { appendStarted } from "../state/started-log.js";
import { waitForHttpReady } from "../ready/http-get.js";
import { waitForTcpReady } from "../ready/tcp.js";
import {
  interpolateString,
  type InterpolationContext,
} from "../config/interpolation.js";
import { waitForLogMatch } from "../ready/log-match.js";
import { LogTail } from "../logs/tail.js";
import { withTimeout, parseDuration, ReadyTimeoutError } from "../ready/timeout.js";
import { runCapture, CaptureMissError } from "../ready/capture.js";
import { watchFailWhen, FailWhenMatchedError } from "../failure/fail-when.js";
import {
  ProcessExitWatcher,
  type LifecycleStage,
} from "../failure/process-exit.js";
import {
  formatFailure,
  type FailureInput,
} from "../failure/formatter.js";
import {
  buildGraph,
  validateGraph,
  DependencyError,
  type NodeDecl,
} from "../deps/graph.js";
import { topoLevels, CycleError } from "../deps/sort.js";
import {
  createOutput,
  type Output,
  type OutputMode,
  type SummaryBlock,
  type SummaryHint,
  type SummaryService,
  type SummaryUrl,
} from "../output/index.js";
import type {
  ComposeService,
  LichConfig,
  OwnedService,
  PortDescriptor,
} from "../config/types.js";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunUpInput {
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Output mode for the CLI surface. Defaults to 'pretty'. */
  outputMode?: OutputMode;
  /** Output sink; defaults to process.stdout. */
  out?: NodeJS.WritableStream;
  /** AbortSignal for cancellation (Ctrl-C handler in real CLI). */
  signal?: AbortSignal;
  /**
   * LEV-387 (Plan 3 Task 13): name of the profile to activate. When
   * omitted, falls back to the single profile declared with `default: true`
   * (errors if none / multiple exist). When the yaml has no `profiles`
   * section at all, this argument must be omitted — the behavior is
   * unchanged from Plan 1.
   */
  profile?: string;
}

export interface RunUpResult {
  exitCode: number;
  stackId?: string;
  services?: Array<{ name: string; state: string }>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PORT_RANGE: [number, number] = [9000, 9999];

/**
 * Default `ready_when.timeout` per the Plan 4 spec: 60s when the field is
 * unset on an owned service's ready_when block. The orchestrator (not the
 * `withTimeout` primitive) owns this default so a future change can pick a
 * different default per evaluator without touching the timeout primitive.
 *
 * Compose services don't get the default — their ready_when fields, when
 * present, run via the compose runner's own healthcheck/wait policy and
 * lich just polls log/http/tcp around them. Wrapping compose's ready
 * evaluator with our timeout would inject lich-side semantics into a flow
 * where compose's own readiness contract is already in play.
 */
const DEFAULT_OWNED_READY_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Per-stack mutable state tracked during the up sequence — service snapshots
 * the orchestrator updates as services transition through states, plus the
 * handles to running owned processes (so the caller could in theory query
 * them or pass them to a future shutdown path).
 *
 * Plan 4 (Task 14) adds:
 *
 *   - `logTails`: per-owned-service `LogTail` instances, kept in a stack-
 *     level registry so the orchestrator can fan them out to ready_when,
 *     fail_when, capture (and eventually the dashboard) without re-opening
 *     the log file once per consumer. The catch-all + cancellation paths
 *     stop every entry on teardown so a failed/cancelled up doesn't leak
 *     poll timers past the function's return.
 *
 *   - `capturedValues`: per-owned-service `ready_when.capture` results.
 *     Populated as each service becomes ready, then threaded into every
 *     downstream service's env resolution so a service in a LATER level can
 *     reference `${owned.<earlier>.captured.<key>}` in its env. Mutable
 *     between services in the same up: services in level N see captures
 *     from levels 0..N-1.
 *
 *   - `exitWatchers`: per-owned-service `ProcessExitWatcher`. The
 *     orchestrator races it against ready_when so a process that exits
 *     while we're polling for readiness short-circuits the wait instead of
 *     us hanging on a dead service's ready probe.
 *
 *   - `stageRefs`: mutable lifecycle-stage variable per owned service. The
 *     `ProcessExitWatcher`'s `readSignal()` closure samples this at the
 *     moment of exit to label whether the death happened during startup,
 *     while waiting for ready, or after ready. The orchestrator flips the
 *     stage as the service progresses; the watcher reads it lazily.
 */
interface UpState {
  worktree: Worktree;
  services: Map<string, ServiceSnapshot>;
  ownedHandles: Map<string, OwnedHandle>;
  status: StackStatus;
  startedAt: string;
  /**
   * Per-owned-service LogTail registry. Indexed by service name; entries are
   * inserted in `startOwned` after the supervisor spawns the process and the
   * LogTail starts polling its log file. Removed only on stop (cancellation
   * cleanup, catch-all error path, or — once Plan 5 introduces the
   * daemon — explicit `lich down`). On the happy path these tails stay
   * RUNNING after `lich up` returns so a service that emits `EADDRINUSE`
   * five minutes post-startup still trips its `fail_when` and the failure
   * lands in `state.json` for the dashboard to render.
   */
  logTails: Map<string, LogTail>;
  /**
   * Per-owned-service `ready_when.capture` results. Populated as each
   * service becomes ready; consumed by every downstream service's env
   * resolution so `${owned.<name>.captured.<key>}` resolves correctly.
   */
  capturedValues: Record<string, Record<string, string>>;
  /**
   * Per-owned-service `ProcessExitWatcher`. The orchestrator races each
   * service's ready evaluator against its exit watcher; a non-zero exit
   * before ready short-circuits the wait. Kept in the state so the cleanup
   * paths can let them fall out of scope without holding refs to dead handles.
   */
  exitWatchers: Map<string, ProcessExitWatcher>;
  /**
   * Per-owned-service mutable lifecycle stage. The `ProcessExitWatcher`'s
   * `readSignal` closure captures `() => stageRefs.get(name) ?? 'after_ready'`
   * — at exit time, that closure returns whatever stage the orchestrator
   * most recently wrote. The orchestrator flips stages as services progress:
   *
   *   `during_startup` (default at spawn)
   *     → `before_ready` (right before `waitReady` begins polling)
   *     → `after_ready` (right after `waitReady` resolves successfully)
   *
   * A service that exits while we never even reached `waitReady` (e.g. crashed
   * inside `startOwned` between spawn and the registry insertion) carries
   * the default `during_startup` label, which is the correct categorization.
   */
  stageRefs: Map<string, LifecycleStage>;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export async function runUp(input: RunUpInput): Promise<RunUpResult> {
  const cwd = input.cwd ?? process.cwd();
  const outputMode = input.outputMode ?? "pretty";
  const sink = input.out ?? process.stdout;
  // LEV-301: opt into per-phase elapsed timing + elapsed_ms on summary so
  // the user sees how long each step took (`✓ start 1/3 (supabase) — 91.2s`).
  const output = createOutput({
    mode: outputMode,
    stream: sink,
    showTiming: true,
  });
  const signal = input.signal;
  // Wall-clock anchor for the overall summary's elapsed timing.
  const runStartedAtMs = Date.now();

  // The state needs to be visible to the failure path so we can write a
  // failed snapshot. Built incrementally as steps complete.
  let state: UpState | null = null;
  let configPath: string | null = null;

  // Cancellation wiring — LEV-302.
  //
  // The bin layer ties its SIGINT handler to an AbortController and passes
  // the signal in via `input.signal`. When that fires (Ctrl-C) we need to:
  //   1. Mark `cancelled` so the catch-all path labels the failure as
  //      "cancelled by user" rather than a generic crash.
  //   2. Stop every owned process we've already spawned (best-effort —
  //      `handle.stop()` does SIGTERM → SIGKILL escalation).
  //   3. Release the ports we reserved so a follow-up `lich up` doesn't
  //      hit a stale reservation.
  //
  // The in-flight awaits (ready evaluators, runOneshot, etc.) already
  // honor the signal directly; their rejections bubble out through the
  // usual error path. The catch-all at the bottom of this function then
  // calls `markStackFailed`, which produces the persisted failed state.
  let cancelled = false;
  let cancelledCleanup: Promise<void> | null = null;
  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    // Run cleanup in parallel with the orchestrator unwinding. We keep a
    // reference so the catch-all can await it before returning, ensuring
    // the function doesn't resolve while children are still being killed.
    //
    // Ordering note (Plan 4 Task 15): stop LogTails BEFORE stopping owned
    // handles. The supervisor's write fd lives in the spawned process; if
    // we let the supervisor close it while a LogTail tick is mid-read we'd
    // be racing the kernel on a torn-down fd. Stopping the tail first
    // halts any in-flight poll and prevents new ones from being scheduled
    // before the corresponding write fd disappears.
    cancelledCleanup = (async () => {
      const tasks: Array<Promise<void>> = [];
      if (state) {
        for (const tail of state.logTails.values()) {
          tasks.push(tail.stop().catch(() => {}));
        }
      }
      if (state) {
        for (const handle of state.ownedHandles.values()) {
          tasks.push(handle.stop().catch(() => {}));
        }
      }
      if (state?.worktree.stack_id) {
        // release() is idempotent on a missing entry, so calling it even
        // when allocation never happened is safe.
        tasks.push(release(state.worktree.stack_id).catch(() => {}));
      }
      await Promise.all(tasks);
    })();
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    // ---- Step 1: parse + validate the yaml ---------------------------------
    const parsePhase = output.phase("parse");
    configPath = join(cwd, "lich.yaml");
    const parsed = await parseConfig(configPath);
    if (!parsed.ok) {
      parsePhase.end("fail");
      const detail = parsed.errors
        .map((e) => `${e.location}: ${e.message}`)
        .join("\n");
      output.error({
        title: "invalid lich.yaml",
        detail,
        hint: "Run `lich validate` for a focused report.",
      });
      await output.close();
      return { exitCode: 1 };
    }
    const config = parsed.config;
    parsePhase.end("ok");

    // ---- LEV-387 (Plan 3 Task 13) BEGIN: resolve active profile -----------
    // Determine which profile (if any) this `up` invocation targets. The
    // resolution decides the rest of Plan 3's downstream behavior (Task 14:
    // service filtering; Task 15: env layering, lifecycle composition,
    // snapshot writes), but THIS task only does the lookup + validation;
    // downstream wiring lands in subsequent tasks.
    //
    // Three input cases:
    //   (a) no input.profile, no profiles section in yaml → no profile
    //       active; preserve Plan 1 behavior.
    //   (b) no input.profile, yaml HAS profiles → pick the single default;
    //       error if there is no default or multiple defaults.
    //   (c) input.profile set → require the named profile to exist.
    let resolvedProfile: ResolvedProfile | null = null;
    {
      const profiles = config.profiles;
      const hasProfilesSection =
        profiles !== undefined && Object.keys(profiles).length > 0;

      let activeProfileName: string | null = null;

      if (input.profile === undefined) {
        if (!hasProfilesSection) {
          // Case (a): no profiles in yaml, no profile arg → unchanged Plan 1.
          activeProfileName = null;
        } else {
          // Case (b): defer to the default-picker.
          const pick = pickDefaultProfile(config);
          if (pick.name === null) {
            const detail = pick.error
              ? pick.error
              : "no default profile set in lich.yaml; either declare a profile with default: true or run lich up <profile>";
            output.error({
              title: "no active profile",
              detail,
            });
            await output.close();
            return { exitCode: 1 };
          }
          activeProfileName = pick.name;
        }
      } else {
        // Case (c): name supplied — must exist.
        if (!profiles || profiles[input.profile] === undefined) {
          const available = profiles ? Object.keys(profiles).sort() : [];
          const list =
            available.length === 0 ? "<none>" : available.join(", ");
          output.error({
            title: "unknown profile",
            detail: `no profile named '${input.profile}' (available: ${list})`,
          });
          await output.close();
          return { exitCode: 1 };
        }
        activeProfileName = input.profile;
      }

      // Realize the resolved profile (only when we picked a name). Surface
      // resolver errors via the same `output.error` channel so the CLI
      // remains structured even when something downstream of name lookup
      // (cycle / unknown parent) trips.
      if (activeProfileName !== null) {
        try {
          resolvedProfile = resolveProfile(activeProfileName, config);
        } catch (err) {
          const title =
            err instanceof ProfileCycleError
              ? "profile extends cycle"
              : err instanceof ProfileResolveError
                ? "profile resolution failed"
                : "profile resolution failed";
          output.error({
            title,
            detail: (err as Error).message,
          });
          await output.close();
          return { exitCode: 1 };
        }
      }
    }
    // ---- LEV-387 (Plan 3 Task 13) END --------------------------------------

    // ---- Step 2: detect worktree ------------------------------------------
    const worktreePhase = output.phase("worktree");
    const worktree = detectWorktree(cwd);
    state = {
      worktree,
      services: new Map(),
      ownedHandles: new Map(),
      status: "starting",
      startedAt: new Date().toISOString(),
      logTails: new Map(),
      capturedValues: {},
      exitWatchers: new Map(),
      stageRefs: new Map(),
    };
    worktreePhase.step(`stack_id=${worktree.stack_id}`);
    worktreePhase.end("ok");

    // ---- LEV-387 (Plan 3 Task 13) BEGIN: refuse-mid-flight switch ---------
    // Before any state mutation (port allocation, override generation, etc.)
    // we check whether a prior `lich up` is already in flight or up for this
    // worktree. If so, and the prior run picked a DIFFERENT profile than the
    // one we're about to activate, refuse: profile-switching needs an
    // explicit `lich down` first. This protects against half-tearing-down a
    // dev stack when the user types `lich up dev:test-env` over the top.
    //
    // The check is best-effort: readSnapshot returns null when there's no
    // prior state, and any read error means "no usable prior state" (caller
    // can still proceed). We treat "stack is up under the SAME profile" as
    // an error too — Plan 1 has no idempotent re-up semantics, so neither
    // does Plan 3 — but the message is the simpler "already up; run lich
    // down" form rather than the cross-profile one.
    {
      const requested = resolvedProfile?.name ?? null;
      let priorSnap: StackSnapshot | null = null;
      try {
        priorSnap = await readSnapshot(worktree.stack_id);
      } catch {
        priorSnap = null;
      }
      if (
        priorSnap &&
        (priorSnap.status === "up" || priorSnap.status === "starting")
      ) {
        const prior = priorSnap.active_profile ?? null;
        const sameProfile = prior === requested;
        // If neither has a profile (both null), `sameProfile` is true →
        // hit the "already up" branch. Cross-profile switch produces the
        // explicit refuse-switch message.
        if (!sameProfile) {
          output.error({
            title: "stack already running under a different profile",
            detail: `stack is already up under profile '${prior ?? "<none>"}'; run 'lich down' before switching to profile '${requested ?? "<none>"}'`,
          });
          await output.close();
          return { exitCode: 1, stackId: worktree.stack_id };
        }
        output.error({
          title: "stack already running",
          detail:
            "stack is already up; run 'lich down' first (lich up has no re-run semantics in v1)",
        });
        await output.close();
        return { exitCode: 1, stackId: worktree.stack_id };
      }
    }
    // ---- LEV-387 (Plan 3 Task 13) END --------------------------------------

    // ---- LEV-388 (Plan 3 Task 14) BEGIN: filter config to active profile --
    // When a profile is active, narrow the working `LichConfig` to only the
    // compose services + owned processes the profile includes. Every
    // downstream step (dep graph, port plan, env resolution, compose
    // override generation, per-level startup, snapshot) consumes
    // `effectiveConfig` instead of the raw `config`, so a service declared
    // in `services:` / `owned:` but excluded from the active profile is
    // NEVER started — it never becomes a graph node, never gets a port
    // allocated, never appears in the snapshot.
    //
    // When no profile is active (no `profiles:` section OR Plan-1 fallback),
    // `effectiveConfig === config` and behavior is unchanged.
    //
    // Lifecycle hooks (top-level `before_up` / `after_up`) are NOT filtered
    // out — they run regardless of the start-set being empty. That matches
    // the spec ("profile with empty services and owned lists still completes
    // the up; lifecycle hooks still run") and the unit-test contract for
    // this task.
    const effectiveConfig: LichConfig = resolvedProfile
      ? filterConfigToProfile(config, resolvedProfile)
      : config;
    // ---- LEV-388 (Plan 3 Task 14) END --------------------------------------

    // ---- Step 3: build dep graph + topo levels ----------------------------
    const graphPhase = output.phase("dependency-graph");
    const decls = buildNodeDecls(effectiveConfig);
    let levels: string[][];
    try {
      const graph = buildGraph(decls);
      validateGraph(graph);
      levels = topoLevels(graph);
    } catch (err) {
      graphPhase.end("fail");
      // LEV-388 (Plan 3 Task 14): when a profile is active, surface
      // missing-dep errors with profile-scoping context. The underlying
      // `DependencyError` lists each offender as
      //   "service '<a>' depends_on '<b>', which is not in the profile"
      // — same shape as Plan 1's missing-target message, but each line
      // names the active profile so the user knows WHY the target is
      // missing (it's defined in the yaml, just not selected by this
      // profile). Cycle errors keep their original wording.
      const msg = formatGraphError(err, resolvedProfile);
      output.error({
        title: "invalid dependency graph",
        detail: msg,
      });
      await markFailed(state, "<graph>");
      await output.close();
      return { exitCode: 1, stackId: worktree.stack_id };
    }
    graphPhase.end("ok", `${levels.length} level${levels.length === 1 ? "" : "s"}`);

    // Seed service snapshots in starting state.
    for (const decl of decls) {
      state.services.set(decl.name, {
        name: decl.name,
        kind: decl.kind,
        state: "starting",
      });
    }

    // ---- Step 4: allocate ports -------------------------------------------
    // LEV-388 (Plan 3 Task 14): `effectiveConfig` carries the profile-filtered
    // `services` / `owned` records, so the port plan only allocates for
    // services in the active profile. `pickPortRange` reads
    // `config.runtime.port_range` — preserved untouched by the filter, so
    // either binding works; we use `effectiveConfig` for consistency.
    const portsPhase = output.phase("allocate-ports");
    const portPlan = buildPortPlan(effectiveConfig);
    const range = pickPortRange(effectiveConfig);

    let portMap: Record<string, number> = {};
    if (Object.keys(portPlan.logicalPorts).length > 0) {
      portMap = await allocate({
        stackId: worktree.stack_id,
        logicalPorts: portPlan.logicalPorts,
        range,
      });
    }
    const allocatedPorts = decodeAllocations(portMap, portPlan);
    // Attach allocated ports to per-service snapshots so state.json reflects them.
    for (const [composeName, ports] of Object.entries(allocatedPorts.compose)) {
      const snap = state.services.get(composeName);
      if (snap) snap.allocated_ports = ports;
    }
    for (const [ownedName, entry] of Object.entries(allocatedPorts.owned)) {
      const snap = state.services.get(ownedName);
      if (!snap) continue;
      const m: Record<string, number> = {};
      if (entry.port !== undefined) m.default = entry.port;
      if (entry.ports) Object.assign(m, entry.ports);
      if (Object.keys(m).length > 0) snap.allocated_ports = m;
    }
    portsPhase.end("ok", `${Object.keys(portMap).length} port${Object.keys(portMap).length === 1 ? "" : "s"}`);

    // ---- Step 5: resolve top-level env -------------------------------------
    // LEV-388 (Plan 3 Task 14): pass `effectiveConfig` so per-service env
    // resolution downstream operates on the filtered service set. Top-level
    // env / env_files / env_from are preserved untouched by the filter.
    // Profile-layer env wiring (passing `profile: resolvedProfile`) is Task
    // 15's job; this task only narrows the structural service set.
    const envPhase = output.phase("resolve-env");
    const topLevelEnv = await resolveTopLevelEnv({
      config: effectiveConfig,
      worktree,
      allocatedPorts,
      projectRoot: worktree.path,
    });
    envPhase.end("ok");

    // Build a closure over the active config + worktree + allocatedPorts so
    // lifecycle entries with long-form `{ cmd, env_group }` can resolve the
    // requested group on demand. Plan 1 wired the seam (executor.ts /
    // per-service.ts both accept this callback); Plan 2 Task 13 fills it in.
    //
    // Passing the bare {@link resolveEnvGroup} export directly wouldn't work:
    // the lifecycle executor's contract is `(name: string) => Promise<env>`,
    // so we close over the surrounding context once and hand back a
    // single-arg callback. The result type is `Record<string, string>`,
    // which satisfies `NodeJS.ProcessEnv` (the latter is a record of
    // optional strings — every string is also an "optional string").
    const lifecycleResolveEnvGroup = (
      name: string,
    ): Promise<NodeJS.ProcessEnv> =>
      resolveEnvGroup({
        name,
        // LEV-388: env_groups themselves are top-level and untouched by the
        // profile filter, but resolution may reference services for
        // interpolation — `effectiveConfig` keeps that reference set in
        // sync with what's actually being started.
        config: effectiveConfig,
        worktree,
        allocatedPorts,
        projectRoot: worktree.path,
      });

    // ---- Step 6: state dir + initial state.json ---------------------------
    await ensureStackDir(worktree.stack_id);
    await writeStateSnapshot(state);

    // ---- Step 7: compose override -----------------------------------------
    // Resolve per-compose-service env up-front so the override can embed it
    // into the file. (Compose services don't have per-service env layers in
    // Plan 1 — `resolveEnvForService` just returns the top-level layer for
    // them — but we go through the same path so any future per-service env
    // is automatically picked up.)
    //
    // LEV-388 (Plan 3 Task 14): iterate the FILTERED config so a compose
    // service excluded from the active profile gets neither an env resolution
    // nor an entry in the generated override file. `writeComposeOverride`
    // walks `input.config.services`; passing `effectiveConfig` ensures the
    // override only declares profile-included services.
    const composeNames = Object.keys(effectiveConfig.services ?? {});
    const resolvedComposeEnv: Record<string, NodeJS.ProcessEnv> = {};
    for (const name of composeNames) {
      resolvedComposeEnv[name] = await resolveEnvForService({
        config: effectiveConfig,
        service: { kind: "compose", name },
        worktree,
        allocatedPorts,
        projectRoot: worktree.path,
      });
    }

    let composeFiles: string[] = [];
    let composeCli: ComposeCli | null = null;
    let composeProject: string | null = null;
    if (composeNames.length > 0) {
      const overridePhase = output.phase("compose-override");
      const overridePath = await writeComposeOverride({
        config: effectiveConfig,
        allocatedPorts: { compose: allocatedPorts.compose },
        resolvedEnv: resolvedComposeEnv,
        stackId: worktree.stack_id,
      });
      // Compose needs the user's compose file(s) too. Plan 1 reads them off
      // the per-service `compose_file:` field. The dogfood stack pattern is
      // a single shared file referenced by every service.
      const userFiles = collectComposeFiles(effectiveConfig, worktree.path);
      composeFiles = [...userFiles, overridePath];
      overridePhase.end("ok");

      const detectPhase = output.phase("compose-detect");
      const composeOverride = pickComposeOverride(effectiveConfig);
      composeCli = await resolveComposeCli(composeOverride);
      composeProject = `lich-${worktree.stack_id}`;
      detectPhase.end("ok", composeCli.kind);
    }

    // ---- Step 9: before_up lifecycle --------------------------------------
    if (config.lifecycle?.before_up && config.lifecycle.before_up.length > 0) {
      const phase = output.phase("before_up");
      try {
        await runLifecycle({
          phase: "before_up",
          entries: config.lifecycle.before_up,
          cwd: worktree.path,
          env: topLevelEnv,
          resolveEnvGroup: lifecycleResolveEnvGroup,
        });
      } catch (err) {
        phase.end("fail");
        output.error({
          title: "lifecycle.before_up failed",
          detail: (err as Error).message,
        });
        await markFailed(state, "<before_up>");
        await output.close();
        return { exitCode: 1, stackId: worktree.stack_id };
      }
      phase.end("ok");
    }

    // ---- Step 10: per-level startup ---------------------------------------
    // Per-level phase name (LEV-301): `start N/total (svc, svc)` — gives the
    // user a progress counter + the names being started. `start-level-N` was
    // implementation jargon; this reads as plain English for both single- and
    // multi-service levels.
    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      const level = levels[levelIdx];
      const phaseName = `start ${levelIdx + 1}/${levels.length} (${level.join(", ")})`;
      const phase = output.phase(phaseName);

      // Throwing inside startOne signals a fatal startup failure for the
      // stack. Use Promise.allSettled-style accumulation so all parallel
      // failures are surfaced, not just the first one to reject.
      const results = await Promise.allSettled(
        level.map((name) =>
          startOneService({
            name,
            // LEV-388 (Plan 3 Task 14): per-service start consumes the
            // filtered config so `config.services[name]` / `config.owned[name]`
            // lookups inside `startOwned` / `startCompose` only see profile-
            // included services. Defensive — the topo levels were already
            // built from `effectiveConfig`, but threading the filtered config
            // keeps the contract consistent end-to-end.
            config: effectiveConfig,
            worktree,
            allocatedPorts,
            topLevelEnv,
            composeCtx: composeCli && composeProject
              ? {
                  cli: composeCli,
                  project: composeProject,
                  files: composeFiles,
                  cwd: worktree.path,
                  env: topLevelEnv,
                }
              : null,
            state: state!,
            output,
            signal,
            resolveEnvGroup: lifecycleResolveEnvGroup,
          }),
        ),
      );

      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (failures.length > 0) {
        phase.end("fail");
        // If the abort handler fired during this level (LEV-302), surface
        // as "cancelled" rather than the per-service "aborted" rejection
        // messages — they're noisy and they all mean the same thing.
        if (cancelled) {
          output.error({
            title: "lich up cancelled",
            detail: "cancelled by user (SIGINT)",
          });
          // Re-bind via cast so TS sees the closure-assigned value.
          const cleanup = cancelledCleanup as Promise<void> | null;
          if (cleanup !== null) {
            await cleanup.catch(() => {});
          }
        } else {
          // Plan 4 Task 14: the per-service failure block has already been
          // rendered by `startOneService` via `output.failure(block)` —
          // service name, reason, log tail, hint, all the rich context.
          // The per-level summary now just names which services failed in
          // which step (so the user gets the coordinate), without dumping
          // raw error messages on top of the rich block.
          const failedNames = level.filter((n) => {
            const snap = state!.services.get(n);
            return snap?.state === "failed";
          });
          // Fallback: if we somehow can't identify the failed services from
          // the snapshot (e.g. a defensive throw inside startOneService
          // before snap.state was flipped to "failed"), surface the raw
          // error count so the user knows something fired in this level.
          const detail =
            failedNames.length > 0
              ? `failed services: ${failedNames.join(", ")}`
              : `${failures.length} service${failures.length === 1 ? "" : "s"} failed in this step`;
          output.error({
            title: `failed to start services in step ${levelIdx + 1}/${levels.length} (${level.join(", ")})`,
            detail,
          });
        }
        // Plan 4 Task 15: stop every running LogTail on the per-level
        // failure path. The per-service failure has already rendered its
        // block; we no longer need the tails ticking. Best-effort.
        for (const tail of state.logTails.values()) {
          await tail.stop().catch(() => {});
        }
        // markFailed has already been called per-service inside startOne.
        await markStackFailed(state);
        await output.close();
        if (signal) signal.removeEventListener("abort", onAbort);
        return {
          exitCode: 1,
          stackId: worktree.stack_id,
          services: snapshotServiceStates(state),
        };
      }
      phase.end("ok");

      // Persist state at each level boundary so a crash mid-up leaves a
      // useful trail behind.
      await writeStateSnapshot(state);
    }

    // ---- Step 11: after_up lifecycle --------------------------------------
    if (config.lifecycle?.after_up && config.lifecycle.after_up.length > 0) {
      const phase = output.phase("after_up");
      try {
        await runLifecycle({
          phase: "after_up",
          entries: config.lifecycle.after_up,
          cwd: worktree.path,
          env: topLevelEnv,
          resolveEnvGroup: lifecycleResolveEnvGroup,
        });
      } catch (err) {
        phase.end("fail");
        output.error({
          title: "lifecycle.after_up failed",
          detail: (err as Error).message,
        });
        await markStackFailed(state);
        await output.close();
        return {
          exitCode: 1,
          stackId: worktree.stack_id,
          services: snapshotServiceStates(state),
        };
      }
      phase.end("ok");
    }

    // ---- Step 12 + 13: mark stack up + summary ----------------------------
    state.status = "up";
    await writeStateSnapshot(state);

    // LEV-301: emit a structured success summary — services with their
    // allocated ports, reachable URLs (raw `http://localhost:<port>`),
    // and "what now?" hints. Pretty renders this as a tidy table; json
    // surfaces the same data as an extended summary event.
    output.summary(
      buildSuccessSummary({
        stackId: worktree.stack_id,
        worktreeName: worktree.name,
        services: [...state.services.values()],
        elapsedMs: Date.now() - runStartedAtMs,
      }),
    );
    await output.close();

    // Plan 4 Task 15 — INTENTIONAL: we do NOT stop the per-stack LogTails
    // on the happy-path return. The success path is the ONLY place in the
    // orchestrator where the LogTail registry survives the function exit
    // — every failure / cancellation branch above tears them down.
    //
    // Why keep them running? `fail_when.log_match` is not a one-shot
    // startup check; it stays armed for the entire stack lifetime. A
    // service that emits `EADDRINUSE` five minutes after a successful
    // `lich up` still trips its `fail_when`, the formatter records the
    // failure to `state.json`, and the dashboard (Plan 5) renders it.
    // Stopping the tails here would silently disarm that surface and
    // break the contract documented on `UpState.logTails`.
    //
    // The tails are stopped instead on `lich down` (the supervisor's
    // stop_cmd terminates the writing child and the OS reclaims the
    // file fds) and, once Plan 5's daemon owns the long-running state,
    // by the daemon's per-stack teardown.
    //
    // Future agent looking to "clean up": don't. The leaving-running is
    // load-bearing for the post-startup failure surface. The Plan 5
    // dashboard work will further extend the LogTail lifetime by
    // subscribing a third consumer (live log streaming to the web UI) —
    // the API is already shaped for that.
    if (signal) signal.removeEventListener("abort", onAbort);
    return {
      exitCode: 0,
      stackId: worktree.stack_id,
      services: snapshotServiceStates(state),
    };
  } catch (err) {
    // Catch-all for any unexpected synchronous/asynchronous throw we didn't
    // route above (parse errors and friends are handled inline).
    //
    // If the cancellation handler fired before we landed here, surface the
    // failure as "cancelled by user" rather than the underlying abort error
    // (which is whatever raced first: an "aborted" string from
    // ready/http-get, an early-exit from a killed oneshot, etc.). None of
    // those messages are useful to the user; "cancelled" is.
    if (cancelled) {
      output.error({
        title: "lich up cancelled",
        detail: "cancelled by user (SIGINT)",
      });
      // Wait for the cleanup tasks the abort handler kicked off — stopping
      // children, releasing ports — so we don't return while resources are
      // still being torn down. The cancelledCleanup local is captured by
      // `onAbort`; TS doesn't track that closure's assignment back to the
      // outer flow, so we coerce its read type explicitly.
      const cleanup = cancelledCleanup as Promise<void> | null;
      if (cleanup !== null) {
        await cleanup.catch(() => {});
      }
    } else {
      output.error({
        title: "lich up failed",
        detail: describeError(err),
      });
    }
    if (state) {
      // Plan 4 Task 15: stop every running LogTail on the catch-all path.
      // The per-service failure path (`startOneService` → `formatFailure` →
      // `output.failure`) has already rendered the rich per-service failure
      // block by the time we reach here; the LogTails are no longer
      // needed for ready/fail_when polling and we don't want them ticking
      // past the function's return. Best-effort: a tail that fails to stop
      // shouldn't mask the underlying error.
      for (const tail of state.logTails.values()) {
        await tail.stop().catch(() => {});
      }
      await markStackFailed(state).catch(() => {});
    }
    await output.close();
    if (signal) signal.removeEventListener("abort", onAbort);
    return {
      exitCode: 1,
      stackId: state?.worktree.stack_id,
      services: state ? snapshotServiceStates(state) : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Per-service startup
// ---------------------------------------------------------------------------

interface StartOneInput {
  name: string;
  config: LichConfig;
  worktree: Worktree;
  allocatedPorts: AllocatedPorts;
  topLevelEnv: NodeJS.ProcessEnv;
  composeCtx: RunnerCtx | null;
  state: UpState;
  output: Output;
  signal: AbortSignal | undefined;
  /**
   * Closure that resolves a named env_group on demand (Plan 2 Task 13).
   * Threaded through so per-service `before_start` and `after_ready`
   * entries with long-form `{ cmd, env_group }` can pick up the requested
   * group's env instead of always inheriting `topLevelEnv`.
   */
  resolveEnvGroup: (name: string) => Promise<NodeJS.ProcessEnv>;
}

/**
 * Start a single service to "ready". Wraps per-service lifecycle hooks,
 * the kind-specific start path (owned vs compose), the ready_when wait,
 * and state.json updates. Throws on any failure — caller's
 * Promise.allSettled aggregates failures across a level.
 */
async function startOneService(input: StartOneInput): Promise<void> {
  const { name, config, state, output } = input;
  const snap = state.services.get(name);
  if (!snap) {
    // Defensive — every named node was seeded into the snapshot map after
    // graph build, so this is unreachable in practice.
    throw new Error(`internal: no snapshot for service "${name}"`);
  }

  const composeDef = config.services?.[name];
  const ownedDef = config.owned?.[name];
  if (!composeDef && !ownedDef) {
    throw new Error(
      `service "${name}" appears in the dep graph but isn't declared under \`services:\` or \`owned:\``,
    );
  }
  const isOwned = !!ownedDef;
  const lifecycle = (isOwned ? ownedDef!.lifecycle : composeDef!.lifecycle);

  try {
    // ---- before_start --------------------------------------------------
    if (lifecycle?.before_start && lifecycle.before_start.length > 0) {
      await runPerServiceLifecycle({
        serviceName: name,
        phase: "before_start",
        entries: lifecycle.before_start,
        cwd: input.worktree.path,
        env: input.topLevelEnv,
        resolveEnvGroup: input.resolveEnvGroup,
      });
    }

    // ---- start ---------------------------------------------------------
    if (isOwned) {
      await startOwned(input, ownedDef!);
    } else {
      await startCompose(input);
    }
    snap.state = "healthy" satisfies ServiceState;
    snap.started_at = new Date().toISOString();
    output.service(name, "healthy");

    // ---- ready_when ----------------------------------------------------
    await waitReady(input, isOwned ? ownedDef! : composeDef!, isOwned);

    // ---- after_ready ---------------------------------------------------
    // Plan 4 Task 17: race the after_ready lifecycle against the per-service
    // ProcessExitWatcher. Without this race, a service that exits between
    // becoming "ready" and finishing its post-ready hooks would let the
    // lifecycle run to completion (against a dead process) and we'd mark
    // the service `ready` anyway — `lich up` would falsely succeed. The
    // watcher's `wait()` rejects with a structured `Error.cause:
    // ProcessExitFailure` payload that `classifyFailure` in the catch
    // below recognizes and turns into a `kind: "exit"` failure block.
    //
    // Compose services don't have an exit watcher; `raceWithExitWatcher`
    // returns the bare promise unchanged in that case.
    if (lifecycle?.after_ready && lifecycle.after_ready.length > 0) {
      await raceWithExitWatcher(
        runPerServiceLifecycle({
          serviceName: name,
          phase: "after_ready",
          entries: lifecycle.after_ready,
          cwd: input.worktree.path,
          env: input.topLevelEnv,
          resolveEnvGroup: input.resolveEnvGroup,
        }),
        name,
        isOwned ? state.exitWatchers.get(name) : undefined,
      );
    }

    snap.state = "ready" satisfies ServiceState;
    output.service(name, "ready");
  } catch (err) {
    snap.state = "failed" satisfies ServiceState;
    output.service(name, "failed", describeError(err));

    // Plan 4 Task 14: render the rich per-service failure block AND
    // populate the snapshot's `failure_reason` / `failure_log_tail` fields
    // (Task 10 added the schema fields; this is where they get written).
    //
    // Steps:
    //   1. Classify the error into a FailureInput discriminated union.
    //      Errors come from many places — ProcessExitWatcher, withTimeout
    //      (ReadyTimeoutError), watchFailWhen (FailWhenMatchedError),
    //      runCapture (CaptureMissError), or a raw thrown Error from
    //      anywhere else (lifecycle hooks, env resolution failures, the
    //      100ms early-exit sentinel). The classifier maps each to the
    //      formatter's typed input.
    //   2. Format into a FailureBlock (title, reason, logTail, hint).
    //   3. Render via `output.failure(block)` — pretty mode prints a red
    //      banner with log tail; json/quiet emit a structured event.
    //   4. Persist `block.reason` and `block.logTail` onto the snapshot so
    //      state.json carries the failure context (downstream: dashboard
    //      in Plan 5, post-hoc `lich logs --failed` etc.).
    //
    // Best-effort: a failure classifier that itself throws shouldn't mask
    // the original error. We swallow secondary errors and fall back to
    // `describeError` on the raw err.
    try {
      const failureInput = classifyFailure({
        err,
        serviceName: name,
        logBuffer: isOwned
          ? input.state.logTails.get(name)?.buffer
          : undefined,
      });
      const block = formatFailure(failureInput);
      output.failure(block);
      // Persist on the snapshot — `writeSnapshot`'s sanitizer keeps these
      // fields ONLY for services in the `failed` state (which we just set
      // above), so a service that later recovers won't leave stale failure
      // metadata in state.json.
      snap.failure_reason = block.reason;
      snap.failure_log_tail = block.logTail;
    } catch {
      // Classifier/formatter blew up. Don't let that swallow the original
      // failure — fall back to the plain describeError on snap and re-throw
      // below. (The orchestrator's per-level error block in `runUp`
      // already provides a fallback summary if this happens.)
      snap.failure_reason = describeError(err);
    }

    throw err;
  }
}

/**
 * Classify a thrown error into the typed `FailureInput` the formatter
 * consumes. Recognizes the error types Plan 4 introduces:
 *
 *   - `ReadyTimeoutError`           → `kind: 'timeout'`
 *   - `FailWhenMatchedError`        → `kind: 'fail_when'`
 *   - `CaptureMissError`            → `kind: 'capture_miss'`
 *   - `Error.cause: ProcessExitFailure` → `kind: 'exit'` (the exitWatcher
 *      race wraps the raw failure in an Error.cause so the stack trace is
 *      preserved while still carrying the structured payload)
 *
 * Anything else falls back to a generic `kind: 'exit'` shape with a
 * `code: 1` placeholder — Plan 4 doesn't ship a "generic" failure kind, so
 * we squash unknown errors into the closest shape and let `describeError`
 * fill the reason string. Once Plan 5 introduces a richer set, this
 * fallback path can be revisited.
 */
function classifyFailure(opts: {
  err: unknown;
  serviceName: string;
  logBuffer: string | undefined;
}): FailureInput {
  const { err, serviceName, logBuffer } = opts;

  if (err instanceof ReadyTimeoutError) {
    const out: FailureInput = {
      kind: "timeout",
      service: serviceName,
      ms: err.ms,
    };
    if (err.phase !== undefined) out.phase = err.phase;
    if (logBuffer !== undefined) out.logBuffer = logBuffer;
    return out;
  }

  if (err instanceof FailWhenMatchedError) {
    const out: FailureInput = {
      kind: "fail_when",
      service: serviceName,
      matchedLine: err.matchedLine,
    };
    if (logBuffer !== undefined) out.logBuffer = logBuffer;
    return out;
  }

  if (err instanceof CaptureMissError) {
    const out: FailureInput = {
      kind: "capture_miss",
      service: serviceName,
      captureKey: err.key,
    };
    if (logBuffer !== undefined) out.logBuffer = logBuffer;
    return out;
  }

  // Error with a ProcessExitFailure-shaped `cause` (set by the exit-
  // watcher's racer in waitReady).
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (
      cause !== null &&
      typeof cause === "object" &&
      "kind" in cause &&
      "stage" in cause &&
      ((cause as { kind: unknown }).kind === "exit" ||
        (cause as { kind: unknown }).kind === "signal")
    ) {
      const out: FailureInput = {
        kind: "exit",
        service: serviceName,
        exit: cause as FailureInput extends { exit: infer T } ? T : never,
      };
      if (logBuffer !== undefined) out.logBuffer = logBuffer;
      return out;
    }
  }

  // Fallback: synthesize a placeholder `exit`-shaped failure so the user
  // sees the structured failure block even for non-Plan-4-typed errors.
  // The `exit` field carries a generic `code: 1` so the formatter renders
  // something useful; `describeError(err)` is encoded into the placeholder
  // failure's exit code label via a marker the formatter recognizes? No —
  // simpler: the formatter renders `formatProcessExitFailure` from the
  // ProcessExitFailure shape, so we synthesize one with stage=during_startup
  // and exitCode=1 (the conservative default — the actual error message
  // appears via the FAILURE block's title/reason, which the renderer prints
  // even when the exit-detail wording is generic).
  //
  // Future polish: introduce a `kind: 'other'` variant in FailureInput so
  // this fallback can carry the raw error message directly. For now, the
  // synthesized exit + the original err re-thrown by the caller keeps the
  // error surface honest.
  const fallback: FailureInput = {
    kind: "exit",
    service: serviceName,
    exit: {
      kind: "exit",
      exitCode: 1,
      signalName: null,
      stage: "during_startup",
    },
  };
  if (logBuffer !== undefined) fallback.logBuffer = logBuffer;
  return fallback;
}

// ---------------------------------------------------------------------------
// Owned start
// ---------------------------------------------------------------------------

async function startOwned(
  input: StartOneInput,
  def: OwnedService,
): Promise<void> {
  const { name, config, worktree, allocatedPorts, state } = input;

  // Resolve env for this owned service via the full pipeline (top-level +
  // owned overrides + interpolation).
  //
  // Plan 4 Task 14: thread captured values from earlier services into this
  // service's env-interpolation context. This is how the dogfood-stack's
  // `${owned.tunnel_demo.captured.listen_url}` flows from tunnel_demo's
  // capture extraction into a downstream service's env. `state.capturedValues`
  // is populated by `waitReady` as each owned service becomes ready, so
  // services in level N see captures from levels 0..N-1.
  //
  // Services in the SAME level can NOT see each other's captures: by
  // construction they start in parallel inside the level loop, and the
  // capture is only populated after ready fires. If a user needs that flow,
  // they declare a `depends_on` edge to push the consumer into a later
  // level.
  const env = await resolveEnvForService({
    config,
    service: { kind: "owned", name },
    worktree,
    allocatedPorts,
    projectRoot: worktree.path,
    capturedValues: state.capturedValues,
  });

  // Build the spec from the parsed config + allocated ports.
  const spec: OwnedServiceSpec = {
    name,
    cmd: def.cmd,
    cwd: resolveOwnedCwd(def, worktree.path),
    env,
    logPath: serviceLogPath(worktree.stack_id, name),
  };

  // Single-port shape: `port: { env: VAR }`.
  if (def.port !== undefined) {
    const envVar = portDescriptorEnv(def.port);
    const allocated = allocatedPorts.owned[name]?.port;
    if (envVar && allocated !== undefined) {
      spec.portEnvVar = envVar;
      spec.port = allocated;
    } else if (allocated !== undefined) {
      // Pinned port without env var — still allocate, just don't inject.
      spec.port = allocated;
    }
  }

  // Multi-port shape: `ports: { key: { env: VAR } }`.
  if (def.ports && Object.keys(def.ports).length > 0) {
    const ports: Record<string, { envVar: string; port: number }> = {};
    const allocatedForOwned = allocatedPorts.owned[name]?.ports ?? {};
    for (const [key, desc] of Object.entries(def.ports)) {
      const envVar = portDescriptorEnv(desc);
      const port = allocatedForOwned[key];
      if (envVar && port !== undefined) {
        ports[key] = { envVar, port };
      }
    }
    if (Object.keys(ports).length > 0) {
      spec.ports = ports;
    }
  }

  if (def.oneshot) spec.oneshot = true;
  if (def.stop_cmd) spec.stopCmd = def.stop_cmd;
  // Thread the cancellation signal through to runOneshot — supabase-style
  // setup CLIs can hang for tens of seconds; without a signal a Ctrl-C
  // during the oneshot would do nothing (the CLI ignores SIGTERM itself).
  if (input.signal) spec.signal = input.signal;

  if (def.oneshot) {
    // Oneshots run to completion as the "start" step — runOneshot throws
    // on non-zero exit, with the log tail in the message.
    await runOneshot(spec);
    // LEV-311: log the oneshot AFTER successful exit. The lich-spawned
    // child has already exited cleanly; the long-lived external state
    // (supabase containers, etc.) only cleans up via stop_cmd. We need
    // every piece a future `lich nuke --rescue` would need: the cmd
    // itself (for diagnostics), the stop_cmd, the cwd, and — critically
    // — the RESOLVED env (so SUPABASE_PROJECT_ID etc. round-trip).
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: worktree.stack_id,
      kind: "owned",
      service: name,
      cmd: def.cmd,
      stop_cmd: def.stop_cmd,
      cwd: spec.cwd,
      env: stringifyEnv(env),
    });
    return;
  }

  // Long-lived owned service: spawn and immediately check it didn't crash.
  const handle = await startOwnedService(spec);
  state.ownedHandles.set(name, handle);

  // Plan 4 Task 14: register a LogTail for this service in the per-stack
  // registry. One physical log file, many logical consumers — `ready_when.
  // log_match`, `fail_when.log_match`, `ready_when.capture`, and (Plan 5)
  // the dashboard live tail all subscribe to the same instance so the file
  // is read once per tick regardless of consumer count.
  //
  // The tail is given the orchestrator's cancellation signal so a Ctrl-C
  // tears every tail down at the same time as the supervised processes,
  // via a single AbortController fan-out (see `LogTail`'s constructor doc).
  // The tail starts polling immediately — the file may not exist yet, the
  // tail's poll loop tolerates that.
  const tail = new LogTail({
    logPath: spec.logPath,
    signal: input.signal,
  });
  await tail.start();
  state.logTails.set(name, tail);

  // Plan 4 Task 14: stage-aware exit watcher. The lifecycle stage starts
  // at `during_startup` and gets flipped by `waitReady`:
  //   - to `before_ready` right before the ready evaluator begins polling
  //   - to `after_ready` right after the ready evaluator resolves
  // The watcher samples this lazily — at the moment `handle.exited`
  // resolves — so an exit during ready polling is labeled `before_ready`,
  // an exit after ready is `after_ready`, etc. (`ProcessExitWatcher`'s
  // README has the full taxonomy.)
  state.stageRefs.set(name, "during_startup");
  const exitWatcher = new ProcessExitWatcher(handle, {
    // Default to `after_ready` if the entry's been deleted (defensive: the
    // map could be cleared by a future cleanup path while a stale watcher
    // is still resolving). `after_ready` is the most-conservative label —
    // it implies the service made it through ready.
    readSignal: () => state.stageRefs.get(name) ?? "after_ready",
  });
  state.exitWatchers.set(name, exitWatcher);

  // Record the spawned pid into the service snapshot so `lich down` can find
  // it. Without this, the snapshot ends up with no pid for the service,
  // `down.ts`'s `stopOwnedService` sees `pid === undefined` and short-
  // circuits without signaling anything — services leak past teardown.
  // (`appendStarted` already writes the pid to started.log for rescue
  // teardown, but the snapshot is the canonical path for normal `lich
  // down`.) Captured here so even if the child exits before becoming
  // ready — the `ProcessExitWatcher` registered above catches it inside
  // `waitReady` (Task 17) — the snapshot still has the pid for whatever
  // rescue path might want it.
  const snap = state.services.get(name);
  if (snap && typeof handle.pid === "number" && Number.isFinite(handle.pid)) {
    snap.pid = handle.pid;
  }

  // Plan 4 Task 17: the legacy 100ms `sentinelMs` early-exit race used to
  // live here as the only safety net for services that exited before the
  // ready evaluator could observe them. It has been removed — the
  // `ProcessExitWatcher` registered above is now the canonical source of
  // exit detection and runs across the entire `up` window, not just the
  // first 100ms after spawn.
  //
  // The watcher is raced inside `waitReady` against the ready evaluator
  // (when one is configured) AND via a "did the process already exit?"
  // probe when `ready_when` is omitted — see the "Plan 4 Task 17" block
  // at the top of `waitReady`. An immediate `cmd: exit 1` therefore still
  // aborts `lich up` without us having to poll for it. The watcher is
  // also raced around the per-service `after_ready` lifecycle in
  // `startOneService` via `raceWithExitWatcher`, so a service that
  // crashes between becoming ready and finishing its post-ready hooks
  // still fails the up.
  //
  // After `lich up` returns successfully, the watcher continues to live
  // in `state.exitWatchers` alongside its `LogTail` (per Task 15) — a
  // future dashboard tick (Plan 5) will surface post-up exits without
  // the user needing to be watching the terminal.

  // LEV-311: log the successful long-lived start. We emit TWO entries:
  //
  //   - `kind: pid` — direct-kill path. Rescue can SIGTERM/SIGKILL the
  //     PID without needing the lich.yaml at recovery time.
  //   - `kind: owned` — stop_cmd path. If the service declared one (rare
  //     for long-lived; common for tools that manage their own daemons),
  //     rescue invokes it with the resolved env captured here.
  //
  // Either alone would miss cases: pid-only loses stop_cmd-managed state,
  // owned-only loses orphan-pid cleanup. Both is cheap and idempotent.
  if (typeof handle.pid === "number" && Number.isFinite(handle.pid)) {
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: worktree.stack_id,
      kind: "pid",
      service: name,
      pid: handle.pid,
      cmd: def.cmd,
      cwd: spec.cwd,
    });
  }
  await appendStarted({
    ts: new Date().toISOString(),
    stack_id: worktree.stack_id,
    kind: "owned",
    service: name,
    cmd: def.cmd,
    stop_cmd: def.stop_cmd,
    cwd: spec.cwd,
    env: stringifyEnv(env),
  });
}

// ---------------------------------------------------------------------------
// Compose start
// ---------------------------------------------------------------------------

async function startCompose(input: StartOneInput): Promise<void> {
  const { name, composeCtx, worktree } = input;
  if (!composeCtx) {
    throw new Error(
      `internal: compose service "${name}" requested but compose context not built`,
    );
  }
  const result = await composeUp(composeCtx, { detach: true, services: [name] });
  if (result.exitCode !== 0) {
    throw new Error(
      `compose up ${name} exited ${result.exitCode}:\n${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  // LEV-311: log the compose project lich just brought up. We log per
  // invocation rather than per project — each `compose up` call appends
  // a row, even though multiple calls share the same `project` + `files`.
  // Idempotent at rescue time: `compose down -p <project>` is a no-op on
  // an already-down project, so duplicate entries reduce to a single
  // teardown action. (A per-project dedupe in this function would
  // require tracking what's already been logged, which adds state to a
  // hot path for no observable benefit.)
  await appendStarted({
    ts: new Date().toISOString(),
    stack_id: worktree.stack_id,
    kind: "compose",
    project: composeCtx.project,
    files: [...composeCtx.files],
    cwd: composeCtx.cwd,
    compose_cli: composeCtx.cli.kind,
  });
}

// ---------------------------------------------------------------------------
// ready_when dispatch
// ---------------------------------------------------------------------------

async function waitReady(
  input: StartOneInput,
  def: OwnedService | ComposeService,
  isOwned: boolean,
): Promise<void> {
  const ready = (def as OwnedService).ready_when;
  const { name, worktree, signal, state } = input;

  // Plan 4 Task 17: when an owned service has NO `ready_when`, the
  // orchestrator used to early-return here. That left a window where
  // `cmd: exit 1` would slip past the 100ms `sentinelMs` race (since
  // removed) and `lich up` would mark the service "ready" anyway. We now
  // give every owned service a brief exit-watcher probe even without a
  // ready_when, so an immediate exit still aborts the up. A long-lived
  // service that's still running stays alive and we proceed to the
  // post-ready stages as before. Compose services don't have an
  // `OwnedHandle`, so the exit-watcher path is owned-only — they keep
  // the original early-return behavior.
  if (!ready) {
    const exitWatcher = isOwned ? state.exitWatchers.get(name) : undefined;
    if (exitWatcher !== undefined) {
      const failure = await checkExitedNow(exitWatcher);
      if (failure !== null) {
        const err = new Error(
          `owned service "${name}" exited before becoming ready`,
        );
        (err as Error & { cause?: unknown }).cause = failure;
        throw err;
      }
    }
    // Stage stays at `during_startup` until we flip it here — there's no
    // ready evaluator to transition through. Setting it to `after_ready`
    // ensures any post-ready exit (e.g. during after_ready hooks) gets
    // labeled correctly by the watcher.
    if (state.stageRefs.has(name)) {
      state.stageRefs.set(name, "after_ready");
    }
    return;
  }

  // Build interpolation context for any ${...} refs inside ready_when fields.
  // The dogfood-stack uses this e.g. ready_when: { tcp: "localhost:${owned.supabase.ports.api}" }.
  //
  // Plan 4 Task 14: include captured values from earlier services so a
  // ready_when field could (in principle) reference `${owned.X.captured.Y}`.
  // No real config in v1 needs this — captures flow into env, not into other
  // services' ready probes — but threading them in is free and future-proof.
  const interpCtx: InterpolationContext = {
    worktree: {
      name: worktree.name,
      id: worktree.id,
      path: worktree.path,
    },
    services: Object.fromEntries(
      Object.entries(input.allocatedPorts.compose).map(([svc, ports]) => [
        svc,
        { host_port: Object.values(ports)[0] },
      ]),
    ),
    owned: Object.fromEntries(
      Object.entries(input.allocatedPorts.owned).map(([svc, entry]) => {
        const captured = state.capturedValues[svc];
        const ownedEntry: {
          port?: number;
          ports?: Record<string, number>;
          captured?: Record<string, string>;
        } = { port: entry.port, ports: entry.ports };
        if (captured !== undefined) ownedEntry.captured = captured;
        return [svc, ownedEntry];
      }),
    ),
  };

  // Plan 4 Task 14: race the ready evaluator against:
  //   - the per-service `fail_when.log_match` watcher (if configured)
  //   - the per-service `ProcessExitWatcher` (owned only — compose services
  //     don't have an OwnedHandle to watch)
  //
  // The watchers are constructed via small helpers that return promises that
  // either NEVER resolve (fail_when, by contract — it only rejects), or
  // resolve only on a NON-zero exit (the exit watcher converts a clean exit
  // to a never-resolving promise). That way whichever fires first wins the
  // race and the orchestrator gets one disposition.
  const failWhenAc = new AbortController();
  const racers: Promise<unknown>[] = [];

  // Wire fail_when first so a retroactive-match in the buffer can fire even
  // before the ready evaluator gets started. The watcher subscribes to the
  // SAME LogTail the orchestrator constructed in startOwned, so there's
  // exactly one read fd on the log per service. Compose services don't get
  // a LogTail (no supervisor-managed log file) so fail_when is a no-op for
  // them — which mirrors the spec ("fail_when is shape-accepted on compose
  // for symmetry but adds no behavior; compose has its own restart policy").
  const failPattern = readyFailWhenPattern(def);
  const tail = isOwned ? state.logTails.get(name) : undefined;
  if (failPattern !== null && tail !== undefined) {
    racers.push(
      watchFailWhen({
        tail,
        pattern: failPattern,
        signal: failWhenAc.signal,
      }),
    );
  }

  // Wire the exit watcher (owned services only). The watcher's `wait()`
  // promise resolves to `null` for a clean exit; we transform that into a
  // never-resolving promise here so a 0-exit during ready polling doesn't
  // unblock the race with a fulfilled-undefined that the orchestrator would
  // mis-interpret as ready. The only way the watcher contributes to the
  // race is via a NON-zero exit, which we re-throw as an error carrying the
  // raw failure shape for the catch path to format.
  const exitWatcher = isOwned ? state.exitWatchers.get(name) : undefined;
  if (exitWatcher !== undefined) {
    racers.push(
      exitWatcher.wait().then((failure) => {
        if (failure === null) {
          // Clean exit during ready polling — refuse to resolve so the
          // ready evaluator's outcome wins. This is rare (a service that
          // exits with code 0 before becoming ready is unusual) but the
          // semantic is "no failure to report; let ready_when win or
          // timeout."
          return new Promise<never>(() => {});
        }
        // Re-throw as a structured exit failure. We wrap it in an `Error`
        // whose `cause` carries the raw ProcessExitFailure for the
        // formatter to consume. Using `Error.cause` keeps the stack trace
        // available for debug builds while letting the formatter discriminate
        // via `cause instanceof` checks.
        const err = new Error(
          `owned service "${name}" exited during ready wait`,
        );
        (err as Error & { cause?: unknown }).cause = failure;
        throw err;
      }),
    );
  }

  // Now build the ready-evaluator promise. We always wrap it in withTimeout
  // (owned services: default 60s when ready.timeout is unset; compose
  // services: no default, but if the user wrote one we honor it).
  //
  // The phase label is forwarded into ReadyTimeoutError so the formatter
  // can render "did not become ready in 60s (http_get)" — gives the user a
  // hint about which evaluator was slow.
  const readyPromise = buildReadyEvaluator(input, def, isOwned, interpCtx);
  const timeoutMs = resolveReadyTimeoutMs(ready, isOwned);
  const phaseLabel = identifyReadyPhase(ready);
  const racedReady =
    timeoutMs !== null
      ? withTimeout(readyPromise, { ms: timeoutMs, phase: phaseLabel })
      : readyPromise;
  racers.push(racedReady);

  // Flip the stage from `during_startup` to `before_ready` so the exit
  // watcher labels any death during polling correctly. Only set when the
  // entry already exists (defensive: compose services don't have a stage
  // ref).
  if (state.stageRefs.has(name)) {
    state.stageRefs.set(name, "before_ready");
  }

  try {
    await Promise.race(racers);
  } finally {
    // Tear down fail_when's subscription regardless of which racer won.
    // If ready_when won, fail_when is still pending (it never resolves on
    // its own — see watchFailWhen's contract); we abort it so the
    // subscription is removed from the LogTail and the promise rejects
    // cleanly (and gets swallowed by the finally semantics here, since
    // we've already returned via the success path).
    //
    // If fail_when WON, this is a no-op — its cleanup already ran inside
    // the watcher when it fired. `failWhenAc.abort()` is idempotent.
    failWhenAc.abort();
  }

  // Plan 4 Task 14: capture extraction. After ready fires, run each
  // `ready_when.capture` regex against the service's accumulated log
  // buffer and stash the matches into `state.capturedValues` for
  // downstream services' env-interpolation context.
  //
  // Missing captures throw `CaptureMissError`; we let it propagate up so
  // the per-service catch in `startOneService` turns it into a structured
  // failure (the formatter has a dedicated `capture_miss` kind).
  //
  // Compose services don't have captures (no LogTail) — `runCapture`
  // requires a tail, so we skip it for them.
  if (ready.capture !== undefined && tail !== undefined) {
    const patterns = ready.capture;
    if (Object.keys(patterns).length > 0) {
      const captured = runCapture({ tail, patterns });
      state.capturedValues[name] = captured;
    }
  }

  // Flip the stage to `after_ready` so any post-ready exit is labeled
  // correctly. (The post-ready watcher continues to live in `state.
  // exitWatchers` even after this function returns; Plan 4 Task 15
  // documents the "LogTails stay running after up" semantic.)
  if (state.stageRefs.has(name)) {
    state.stageRefs.set(name, "after_ready");
  }
}

/**
 * Plan 4 Task 17: check whether an owned service has exited within a brief
 * detection window, without blocking on a long-running process.
 *
 * `ProcessExitWatcher.wait()` resolves once (and is cached thereafter) when
 * the underlying `handle.exited` resolves. For a still-running service,
 * `wait()` is pending indefinitely — so we can't just `await` it without
 * potentially hanging the orchestrator. Instead, we race the watcher
 * against a short timeout: if the watcher settles within the window we
 * observe the exit; otherwise we conclude "still alive" and continue.
 *
 * The window matches the legacy 100ms `sentinelMs` race this helper
 * replaces — see the "Plan 4 Task 17" comment block in `startOwned`. 100ms
 * is long enough for `cmd: exit 1` (and its sibling immediate-failure
 * patterns: `ENOENT` on a missing binary, `exit 127` from the shell, the
 * `error` event from a pre-fork failure) to propagate through the
 * supervisor's `child.once("exit", ...)` handler into the watcher's
 * cached promise. A healthy long-lived service stays alive past 100ms by
 * construction, so `lich up`'s perceived per-service overhead is unchanged.
 *
 * Returns the watcher's failure payload if the service has exited; null
 * if it's still alive (or exited cleanly with code 0).
 */
async function checkExitedNow(
  watcher: ProcessExitWatcher,
): Promise<Awaited<ReturnType<ProcessExitWatcher["wait"]>>> {
  const sentinel = Symbol("alive");
  const result = await Promise.race([
    watcher.wait(),
    // 100ms matches the legacy `sentinelMs` window — see the Plan 4
    // Task 17 doc-comment above and the corresponding block in
    // `startOwned`. Long enough for the supervisor's exit handler to
    // settle the cached `wait()` promise for an immediate-exit cmd;
    // short enough to be invisible in the overall up latency.
    new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), 100)),
  ]);
  if (result === sentinel) return null;
  return result;
}

/**
 * Plan 4 Task 17: race a promise against an owned service's
 * `ProcessExitWatcher`. If the watcher fires (non-zero exit) before the
 * promise settles, reject with the same `Error.cause: ProcessExitFailure`
 * shape `waitReady`'s race produces — `classifyFailure` in `startOneService`'s
 * catch recognizes the cause and renders a proper `kind: "exit"` failure block.
 *
 * Used to wrap the per-service `after_ready` lifecycle promise so a service
 * that crashes during its post-ready hooks still fails `lich up`. Without
 * this race, the lifecycle hook would either run against a freshly-dead
 * service (e.g. seeding a DB that just crashed) or report a confusing
 * "hook failed" instead of "service died."
 *
 * Compose services (and any owned service without a registered watcher —
 * defensive fallback) get the bare promise back without instrumentation.
 */
function raceWithExitWatcher<T>(
  promise: Promise<T>,
  serviceName: string,
  watcher: ProcessExitWatcher | undefined,
): Promise<T> {
  if (watcher === undefined) return promise;
  return Promise.race([
    promise,
    watcher.wait().then((failure) => {
      if (failure === null) {
        // Clean exit during the post-ready window — refuse to resolve so
        // the lifecycle promise's outcome wins. Mirrors the `null →
        // never-resolving` semantic in `waitReady`.
        return new Promise<never>(() => {});
      }
      const err = new Error(
        `owned service "${serviceName}" exited after becoming ready`,
      );
      (err as Error & { cause?: unknown }).cause = failure;
      throw err;
    }),
  ]);
}

/**
 * Build the ready-evaluator promise WITHOUT any timeout / fail_when / exit-
 * watcher wrapping. The caller composes those via Promise.race.
 *
 * Returns a never-resolving promise when `ready_when` is present but uses
 * only fields lich doesn't probe (e.g. `cmd:`, which isn't implemented).
 * The orchestrator's timeout race ensures we don't hang forever on those.
 */
function buildReadyEvaluator(
  input: StartOneInput,
  def: OwnedService | ComposeService,
  isOwned: boolean,
  interpCtx: InterpolationContext,
): Promise<void> {
  const ready = (def as OwnedService).ready_when;
  // Guaranteed non-null by caller — but defensive narrowing for clarity.
  if (!ready) return Promise.resolve();

  const { name, worktree, signal, state } = input;

  if (typeof ready.log_match === "string" && ready.log_match.length > 0) {
    // Compile the regex up front; validate has already done this but we
    // can't carry the compiled form across the parse boundary cheaply.
    const pattern = new RegExp(ready.log_match, "u");
    // For owned services, use the shared LogTail from the registry. For
    // compose (which doesn't have a tail), construct a just-in-time tail
    // — same observable behavior as Plan 1's pre-Task-14 wiring.
    let tail = isOwned ? state.logTails.get(name) : undefined;
    let stopAfter = false;
    if (tail === undefined) {
      // Compose services (or — defensively — owned services that somehow
      // didn't make it into the registry) get a single-use tail that's
      // stopped when the wait settles.
      const logPath = serviceLogPath(worktree.stack_id, name);
      tail = new LogTail({ logPath, signal });
      stopAfter = true;
      // start() returns immediately; await keeps the call shape uniform.
      void tail.start();
    }
    const tailNonNull = tail;
    return waitForLogMatch({ tail: tailNonNull, pattern, signal }).finally(
      () => {
        if (stopAfter) {
          // Best-effort stop; the await is necessary because tail.stop()
          // is async and we want the cleanup to complete before the
          // promise settles.
          void tailNonNull.stop().catch(() => {});
        }
      },
    );
  }

  if (typeof ready.http_get === "string" && ready.http_get.length > 0) {
    const resolved = interpolateString(
      ready.http_get,
      interpCtx,
      `${name}.ready_when.http_get`,
    );
    const url = buildHttpUrl(resolved, def, input);
    // LEV-301: surface the URL we're polling so the user can curl it
    // themselves while waiting (helpful when a service is slow to come up).
    input.output.service(name, "initializing", `waiting on ${url}`);
    return waitForHttpReady({ url, signal });
  }

  if (typeof ready.tcp === "string" && ready.tcp.length > 0) {
    const target = interpolateString(
      ready.tcp,
      interpCtx,
      `${name}.ready_when.tcp`,
    );
    // LEV-301: surface the tcp target we're probing for the same reason
    // as the http_get case above.
    input.output.service(name, "initializing", `waiting on tcp ${target}`);
    return waitForTcpReady({ target, signal });
  }

  // ready_when present but with only fields Plan 1/4 doesn't probe (cmd;
  // capture-only; timeout-only). Resolve immediately — same as the
  // pre-Plan-4 behavior for these shapes.
  return Promise.resolve();
}

/**
 * Compile `fail_when.log_match` to a RegExp, or return `null` if not
 * configured. Compose services accept the shape but the orchestrator only
 * wires the watcher for owned services (where the supervisor writes the
 * log file lich can tail).
 */
function readyFailWhenPattern(
  def: OwnedService | ComposeService,
): RegExp | null {
  const fw = (def as OwnedService).fail_when;
  if (!fw) return null;
  if (typeof fw.log_match !== "string" || fw.log_match.length === 0) return null;
  // Same `u` flag the rest of lich uses (validate, capture, log_match) — keep
  // semantics identical across the various regex callsites.
  return new RegExp(fw.log_match, "u");
}

/**
 * Resolve the effective timeout (in ms) for a ready evaluator.
 *
 *   - owned services: parse `ready.timeout` if set, else default 60s
 *   - compose services: parse `ready.timeout` if set, else no timeout
 *
 * Returns `null` to mean "no timeout" — the caller skips the `withTimeout`
 * wrap in that case. We don't apply the 60s default to compose because
 * compose has its own healthcheck / wait policy and adding lich-side
 * semantics on top can mask real timing issues at the compose layer.
 */
function resolveReadyTimeoutMs(
  ready: NonNullable<OwnedService["ready_when"]>,
  isOwned: boolean,
): number | null {
  if (ready.timeout !== undefined) {
    // Validate has already approved this value; parseDuration re-validates
    // at runtime as a defensive double-check. Throwing here surfaces as a
    // service failure, which is correct — a misconfigured timeout should
    // fail loudly rather than silently get ignored.
    return parseDuration(ready.timeout);
  }
  return isOwned ? DEFAULT_OWNED_READY_TIMEOUT_MS : null;
}

/**
 * Identify which evaluator a ready_when block declares, for the timeout
 * error's phase label. Returns one of `"http_get"`, `"tcp"`, `"log_match"`,
 * or `undefined` when no probe is configured.
 */
function identifyReadyPhase(
  ready: NonNullable<OwnedService["ready_when"]>,
): string | undefined {
  if (typeof ready.log_match === "string" && ready.log_match.length > 0) {
    return "log_match";
  }
  if (typeof ready.http_get === "string" && ready.http_get.length > 0) {
    return "http_get";
  }
  if (typeof ready.tcp === "string" && ready.tcp.length > 0) {
    return "tcp";
  }
  return undefined;
}

/**
 * Build the HTTP URL for a ready probe.
 *
 * Plan 1 supports two shapes (per spec section 4 examples + dogfood-stack):
 *   - A relative path like `/health`: prefixed with `http://localhost:<port>`
 *     where <port> is the service's primary allocated port.
 *   - An absolute URL: used verbatim. (Plan 1's interpolation pipeline does
 *     NOT touch ready_when fields — they're consumed raw from the parsed
 *     config — so an absolute URL must already be a literal address.)
 */
function buildHttpUrl(
  pathOrUrl: string,
  def: OwnedService | ComposeService,
  input: StartOneInput,
): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  // Relative path — synthesize against the service's primary port.
  const { name, allocatedPorts } = input;
  const port =
    allocatedPorts.owned[name]?.port ??
    Object.values(allocatedPorts.owned[name]?.ports ?? {})[0] ??
    Object.values(allocatedPorts.compose[name] ?? {})[0];
  if (port === undefined) {
    throw new Error(
      `ready_when.http_get for service "${name}" uses a relative path but no port is allocated`,
    );
  }
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `http://localhost:${port}${path}`;
}

// ---------------------------------------------------------------------------
// Helpers — dep decls, port plan, state
// ---------------------------------------------------------------------------

/**
 * LEV-388 (Plan 3 Task 14): produce a narrowed {@link LichConfig} whose
 * `services` and `owned` records are restricted to entries the resolved
 * profile selects. Every other top-level field (`runtime`, `env`,
 * `env_files`, `env_from`, `env_groups`, `lifecycle`, `commands`,
 * `profiles`, `version`) is preserved by reference — the filter only
 * narrows the start-set.
 *
 * Why a shallow clone with narrowed maps (vs deep clone, vs mutating in
 * place):
 *
 *   - Mutating `config` in place would surprise any caller that holds a
 *     reference to the parsed config (currently none, but the parsed
 *     object is the kind of thing that grows reference holders as the
 *     code evolves).
 *   - Deep cloning would unnecessarily duplicate every value across every
 *     service definition (cmd strings, port descriptors, lifecycle
 *     entries, env maps), all of which the downstream callers read
 *     read-only.
 *   - A shallow clone + narrowed two-key rebuild gives downstream code a
 *     drop-in replacement: `effectiveConfig.services[x]` returns the same
 *     `ComposeService` object the original config carried — same ports,
 *     same lifecycle, same depends_on — but the `services` map itself
 *     excludes profile-excluded names.
 *
 * A service excluded from the profile is not just hidden from iteration;
 * it's structurally absent — so `validateGraph` naturally fails when a
 * profile-INCLUDED service has a `depends_on` edge to a profile-EXCLUDED
 * name (the dep target isn't a declared node). The orchestrator wraps
 * that failure with profile-scoping context in `formatGraphError` so the
 * user gets a useful error message instead of a generic
 * "unknown nodes" report.
 *
 * @param config - the full parsed lich.yaml
 * @param profile - the resolved active profile (services + owned lists)
 * @returns a new LichConfig with services + owned narrowed to the profile
 */
function filterConfigToProfile(
  config: LichConfig,
  profile: ResolvedProfile,
): LichConfig {
  const includedServices = new Set(profile.services);
  const includedOwned = new Set(profile.owned);

  // Rebuild the maps with only the profile-included keys. Preserve declared
  // order from the original yaml (Object.entries iterates in insertion order)
  // so error messages and topo-sort tie-breaking remain deterministic and
  // user-facing-stable across reruns. The set membership check is O(1); the
  // overall filter is O(N) in the number of declared services + owned.
  const services: Record<string, (typeof config.services)[string]> = {};
  for (const [name, def] of Object.entries(config.services ?? {})) {
    if (includedServices.has(name) && def !== undefined) {
      services[name] = def;
    }
  }
  const owned: Record<string, (typeof config.owned)[string]> = {};
  for (const [name, def] of Object.entries(config.owned ?? {})) {
    if (includedOwned.has(name) && def !== undefined) {
      owned[name] = def;
    }
  }

  // Spread to preserve every other field (runtime, env, env_files, env_from,
  // env_groups, lifecycle, commands, profiles, version). Then assign the
  // narrowed services/owned maps explicitly. The result is a fresh object
  // (different identity than `config`) but every nested value is the same
  // reference — downstream readers see identical data structures.
  return {
    ...config,
    services,
    owned,
  };
}

/**
 * LEV-388 (Plan 3 Task 14): format the error message rendered when graph
 * construction / validation fails. When a profile is active, missing-target
 * errors get profile-scoping context so the user understands WHY a
 * `depends_on` reference is unresolved: the target IS declared in the yaml,
 * but the active profile doesn't include it.
 *
 * Two error shapes are recognized:
 *
 *   - {@link DependencyError} — at least one `depends_on` target isn't a
 *     declared node. When a profile is active, each line is reformatted to
 *     read
 *       service '<a>' (in active profile '<p>') depends_on '<b>', which is
 *       not in the profile
 *     so the user can either add `<b>` to the profile's services/owned list
 *     or drop the depends_on edge. Without an active profile, the original
 *     `DependencyError` message is used as-is.
 *
 *   - {@link CycleError} — original message ("dependency cycle: a → b → a").
 *     Profile context doesn't help here; cycles are configuration bugs
 *     orthogonal to profile selection.
 *
 * Any other error reaches us only by misuse; fall back to its message text.
 */
function formatGraphError(
  err: unknown,
  profile: ResolvedProfile | null,
): string {
  if (err instanceof CycleError) {
    return `dependency cycle: ${err.cycle.join(" → ")}`;
  }
  if (err instanceof DependencyError) {
    if (profile === null) {
      return err.message;
    }
    const profileName = profile.name;
    // `err.missing` is already sorted (DependencyError's constructor sorts
    // by from-name then target-name); preserve that order so the rendered
    // output stays deterministic for tests.
    const lines = err.missing.map(
      (m) =>
        `service '${m.from}' (in active profile '${profileName}') depends_on '${m.target}', which is not in the profile`,
    );
    return lines.join("\n");
  }
  return (err as Error).message;
}

function buildNodeDecls(config: LichConfig): NodeDecl[] {
  const decls: NodeDecl[] = [];
  for (const [name, def] of Object.entries(config.services ?? {})) {
    decls.push({
      name,
      kind: "compose",
      depends_on: def?.depends_on ?? [],
    });
  }
  for (const [name, def] of Object.entries(config.owned ?? {})) {
    decls.push({
      name,
      kind: "owned",
      depends_on: def?.depends_on ?? [],
    });
  }
  return decls;
}

/**
 * AllocatedPorts is the shape passed to env-resolve and override-generation.
 * Mirrors the shape those modules already expect.
 */
interface AllocatedPorts {
  compose: Record<string, Record<string, number>>;
  owned: Record<string, { port?: number; ports?: Record<string, number> }>;
}

/**
 * Port plan: encodes every logical port across compose + owned into the flat
 * `logicalPorts` map the allocator expects, with a key scheme that lets us
 * decode the result back into the per-service structure.
 *
 * Key scheme:
 *   compose:<serviceName>:<portKey>
 *   owned-single:<serviceName>
 *   owned-multi:<serviceName>:<portKey>
 *
 * `null` value means "allocator picks a free port"; a number means "honor
 * the user's pin".
 */
interface PortPlan {
  logicalPorts: Record<string, number | null>;
}

function buildPortPlan(config: LichConfig): PortPlan {
  const logicalPorts: Record<string, number | null> = {};

  for (const [name, def] of Object.entries(config.services ?? {})) {
    if (!def?.ports) continue;
    if (Array.isArray(def.ports)) {
      for (let i = 0; i < def.ports.length; i++) {
        const entry = def.ports[i];
        if (!entry) continue;
        const pinned = typeof entry.host_port === "number" ? entry.host_port : null;
        // Only allocate when there's a container port to bind to OR an env
        // var to inject — otherwise there's nothing for the allocator to do.
        if (typeof entry.container === "number" || typeof entry.env === "string") {
          logicalPorts[`compose:${name}:${i}`] = pinned;
        }
      }
    } else {
      for (const [portKey, desc] of Object.entries(def.ports)) {
        const pinned = pinnedFromDescriptor(desc);
        logicalPorts[`compose:${name}:${portKey}`] = pinned;
      }
    }
  }

  for (const [name, def] of Object.entries(config.owned ?? {})) {
    if (def?.port !== undefined) {
      logicalPorts[`owned-single:${name}`] = pinnedFromDescriptor(def.port);
    }
    if (def?.ports) {
      for (const [portKey, desc] of Object.entries(def.ports)) {
        logicalPorts[`owned-multi:${name}:${portKey}`] = pinnedFromDescriptor(desc);
      }
    }
  }

  return { logicalPorts };
}

function pinnedFromDescriptor(desc: PortDescriptor): number | null {
  if (typeof desc === "number") return desc;
  if (typeof desc === "object" && desc !== null && typeof desc.host_port === "number") {
    return desc.host_port;
  }
  return null;
}

function portDescriptorEnv(desc: PortDescriptor): string | undefined {
  if (typeof desc === "number") return undefined;
  if (typeof desc === "object" && desc !== null && typeof desc.env === "string") {
    return desc.env;
  }
  return undefined;
}

/**
 * Decode the flat allocator result back into a per-service structure.
 */
function decodeAllocations(
  portMap: Record<string, number>,
  _plan: PortPlan,
): AllocatedPorts {
  const compose: AllocatedPorts["compose"] = {};
  const owned: AllocatedPorts["owned"] = {};

  for (const [key, port] of Object.entries(portMap)) {
    if (key.startsWith("compose:")) {
      // compose:<serviceName>:<portKey>
      const rest = key.slice("compose:".length);
      const idx = rest.indexOf(":");
      if (idx < 0) continue;
      const svc = rest.slice(0, idx);
      const portKey = rest.slice(idx + 1);
      (compose[svc] ??= {})[portKey] = port;
    } else if (key.startsWith("owned-single:")) {
      const svc = key.slice("owned-single:".length);
      (owned[svc] ??= {}).port = port;
    } else if (key.startsWith("owned-multi:")) {
      const rest = key.slice("owned-multi:".length);
      const idx = rest.indexOf(":");
      if (idx < 0) continue;
      const svc = rest.slice(0, idx);
      const portKey = rest.slice(idx + 1);
      const entry = (owned[svc] ??= {});
      entry.ports ??= {};
      entry.ports[portKey] = port;
    }
  }

  return { compose, owned };
}

function pickPortRange(config: LichConfig): [number, number] {
  const range = config.runtime?.port_range;
  if (Array.isArray(range) && range.length === 2) {
    return [range[0], range[1]];
  }
  return DEFAULT_PORT_RANGE;
}

function pickComposeOverride(
  config: LichConfig,
): "docker" | "podman" | "nerdctl" | undefined {
  const r = config.runtime;
  if (!r) return undefined;
  const v = r.compose_cli ?? r.compose;
  if (v === "auto" || v === undefined) return undefined;
  return v;
}

function collectComposeFiles(config: LichConfig, projectRoot: string): string[] {
  const seen = new Set<string>();
  for (const def of Object.values(config.services ?? {})) {
    const file = def?.compose_file;
    if (typeof file === "string" && file.length > 0) {
      const abs = file.startsWith("/") ? file : join(projectRoot, file);
      if (!seen.has(abs)) seen.add(abs);
    }
  }
  return [...seen];
}

function resolveOwnedCwd(def: OwnedService, projectRoot: string): string {
  if (!def.cwd || def.cwd === "." || def.cwd === "./") return projectRoot;
  if (def.cwd.startsWith("/")) return def.cwd;
  return join(projectRoot, def.cwd);
}

// ---------------------------------------------------------------------------
// Success summary builder (LEV-301)
// ---------------------------------------------------------------------------

interface BuildSummaryInput {
  stackId: string;
  worktreeName: string;
  services: ServiceSnapshot[];
  elapsedMs: number;
}

/**
 * Build the structured success summary block.
 *
 * Per LEV-301, the success path should match the failure path's quality:
 * give the user one tidy block they can read end-to-end without scrolling
 * back to find what ports got allocated. We surface:
 *
 *   - title with stack id + total wall-clock elapsed
 *   - per-service final state + allocated ports
 *   - per-service raw URLs (when we can infer one — services with a
 *     `default` owned port or a single compose port get a
 *     `http://localhost:<port>` line). Plan 5 will add friendly URLs
 *     alongside; for now the raw URL is what users actually paste.
 *   - "what now?" hints: the two most useful next commands.
 */
function buildSuccessSummary(input: BuildSummaryInput): SummaryBlock {
  const services: SummaryService[] = input.services.map((s) => {
    const out: SummaryService = {
      name: s.name,
      state: s.state as SummaryService["state"],
    };
    if (s.allocated_ports && Object.keys(s.allocated_ports).length > 0) {
      out.ports = s.allocated_ports;
    }
    return out;
  });

  // Infer a single user-facing URL per service:
  //   - owned single-port (`default` key) → `http://localhost:<port>`
  //   - any service with exactly one allocated port → that port
  //   - services with multiple ports (e.g. supabase with 6 ports) get
  //     omitted because there's no "the" port — the user already sees
  //     the port map in the services table.
  const urls: SummaryUrl[] = [];
  for (const s of input.services) {
    const ports = s.allocated_ports;
    if (!ports) continue;
    const entries = Object.entries(ports);
    if (entries.length !== 1) continue;
    const [, port] = entries[0];
    urls.push({ service: s.name, url: `http://localhost:${port}` });
  }

  const next: SummaryHint[] = [
    { cmd: "lich logs", description: "follow stack logs" },
    { cmd: "lich down", description: "stop the stack" },
  ];

  return {
    title: "stack up",
    elapsedMs: input.elapsedMs,
    lines: [
      `stack_id: ${input.stackId}`,
      `worktree: ${input.worktreeName}`,
    ],
    services,
    urls: urls.length > 0 ? urls : undefined,
    next,
  };
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

async function writeStateSnapshot(state: UpState): Promise<void> {
  const snapshot: StackSnapshot = {
    stack_id: state.worktree.stack_id,
    worktree_name: state.worktree.name,
    worktree_path: state.worktree.path,
    status: state.status,
    started_at: state.startedAt,
    services: [...state.services.values()],
  };
  await writeSnapshot(snapshot);
  // Touch the stack dir to ensure it exists (writeSnapshot does this too,
  // but make it explicit so tests that read stackDir() without going through
  // the snapshot path still find it).
  await ensureStackDir(state.worktree.stack_id).catch(() => {});
  // Reference stackDir so the import isn't elided by tree shaking.
  void stackDir;
}

async function markFailed(state: UpState, serviceName: string): Promise<void> {
  state.status = "failed";
  const snap = state.services.get(serviceName);
  if (snap) snap.state = "failed";
  await writeStateSnapshot(state).catch(() => {});
}

async function markStackFailed(state: UpState): Promise<void> {
  state.status = "failed";
  await writeStateSnapshot(state).catch(() => {});
}

function snapshotServiceStates(
  state: UpState,
): Array<{ name: string; state: string }> {
  return [...state.services.values()].map((s) => ({
    name: s.name,
    state: s.state,
  }));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Coerce a `NodeJS.ProcessEnv` (string | undefined values) into the plain
 * `Record<string, string>` shape `StartedEntry`'s env field expects.
 *
 * Why this exists: `resolveEnvForService` returns `NodeJS.ProcessEnv`,
 * whose values are `string | undefined`. Undefined values can show up
 * when a parent env had an entry explicitly cleared. The started-log
 * entry shape is strict `Record<string, string>` — JSON has no `undefined`
 * representation, so leaking those through would serialize as missing
 * keys, then deserialize as missing keys, and any rescue stop_cmd that
 * referenced them would silently see "" instead of the original value.
 * Dropping them at the boundary keeps the on-disk log faithful to what
 * we actually intend to round-trip.
 */
function stringifyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
