import { spawn } from "node:child_process";

import { runLifecycle } from "../lifecycle/executor.js";
import { runPerServiceLifecycle } from "../lifecycle/per-service.js";
import { resolveEnvGroup } from "../groups/resolve.js";
import { parseConfig } from "../config/parse.js";
import { ensureDaemonRunning } from "../daemon/auto-start.js";
import { detectWorktree, type Worktree } from "../worktree/detect.js";
import { allocate, release } from "../ports/allocator.js";
import { resolveComposeCli, type ComposeCli } from "../compose/detect.js";
import {
  up as composeUp,
  down as composeDown,
  type RunnerCtx,
} from "../compose/runner.js";
import { writeComposeOverride } from "../compose/override.js";
import {
  resolveEnvForService,
  resolveTopLevelEnv,
} from "../env/resolve.js";
import {
  ensureStackDir,
  hooksDir,
  serviceLogPath,
  stackDir,
} from "../state/directory.js";
import {
  readSnapshot,
  writeSnapshot,
  type RoutingEntry,
  type ServiceSnapshot,
  type ServiceState,
  type SnapshotLifecycleEntry,
  type StackSnapshot,
  type StackStatus,
} from "../state/snapshot.js";
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
import { waitForCmdReady } from "../ready/cmd.js";
import {
  interpolateString,
  type InterpolationContext,
} from "../config/interpolation.js";
import { waitForLogMatch } from "../ready/log-match.js";
import { LogTail } from "../logs/tail.js";
import { withTimeout, parseDuration, ReadyTimeoutError } from "../ready/timeout.js";
import { runCapture, CaptureMissError } from "../ready/capture.js";
import { failOnExitDuringReady } from "../ready/process-exit-race.js";
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
import {
  DEFAULT_PROXY_PORT,
  buildFriendlyUrls,
  buildRawUrls,
} from "../urls/format.js";
import { join } from "node:path";

export interface RunUpInput {
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Output mode for the CLI surface. Defaults to 'pretty'. */
  outputMode?: OutputMode;
  /** Output sink; defaults to process.stdout. */
  out?: NodeJS.WritableStream;
  /** AbortSignal for cancellation (Ctrl-C handler in real CLI). */
  signal?: AbortSignal;
  /** Profile to activate. Omit to pick the `default: true` profile (errors on missing/ambiguous). */
  profile?: string;
  /** Suppress the daemon's browser-open side effect on first-spawn. */
  noBrowser?: boolean;
  /** Emit raw upstream URLs in the summary instead of friendly proxied URLs. */
  raw?: boolean;
}

export interface RunUpResult {
  exitCode: number;
  stackId?: string;
  services?: Array<{ name: string; state: string }>;
}

const DEFAULT_PORT_RANGE: [number, number] = [9000, 9999];

/** Last-resort default ready_when.timeout for owned services (spec: 60s). Compose services have no default — they have their own healthcheck/wait policy. */
const DEFAULT_OWNED_READY_TIMEOUT_MS = 60_000;

interface UpState {
  worktree: Worktree;
  services: Map<string, ServiceSnapshot>;
  ownedHandles: Map<string, OwnedHandle>;
  status: StackStatus;
  startedAt: string;
  activeProfile?: string;
  resolvedProfile?: ResolvedProfile;
  /** Per-owned-service LogTail registry. Stays RUNNING after a successful `lich up` returns so post-startup `fail_when` matches still fire — torn down by `lich down`. */
  logTails: Map<string, LogTail>;
  /** Per-owned-service `ready_when.capture` results; consumed by downstream services for `${owned.<name>.captured.<key>}`. */
  capturedValues: Record<string, Record<string, string>>;
  exitWatchers: Map<string, ProcessExitWatcher>;
  /** Per-owned-service lifecycle stage, sampled lazily by ProcessExitWatcher's readSignal. Transitions: during_startup → before_ready → after_ready. */
  stageRefs: Map<string, LifecycleStage>;
  /** Per-owned-service resolved env. Reused by `ready_when.cmd` so the probe shell sees the same env the service runs with. */
  ownedEnv: Map<string, Record<string, string>>;
  /** Per-owned-service resolved cwd. Reused by `ready_when.cmd` so the probe shell runs in the same directory as the service. */
  ownedCwd: Map<string, string>;
  /** Friendly-URL routing entries — undefined during startup/failure, set only on fully-ready stacks (and `[]` on `lich down` to evict). */
  routing?: RoutingEntry[];
  /** Top-level + profile before_down hooks with pre-resolved envs, snapshotted at up time. */
  stackBeforeDown?: SnapshotLifecycleEntry[];
  /** Top-level + profile after_down hooks with pre-resolved envs, snapshotted at up time. */
  stackAfterDown?: SnapshotLifecycleEntry[];
}

export async function runUp(input: RunUpInput): Promise<RunUpResult> {
  const cwd = input.cwd ?? process.cwd();
  const outputMode = input.outputMode ?? "pretty";
  const sink = input.out ?? process.stdout;
  const output = createOutput({
    mode: outputMode,
    stream: sink,
    showTiming: true,
  });
  const signal = input.signal;
  const runStartedAtMs = Date.now();

  // Visible to the failure path so it can write a failed snapshot. Built incrementally.
  let state: UpState | null = null;
  let configPath: string | null = null;
  // Lifted so the catch-all can read `config.runtime.kill_others_on_fail` without re-parsing.
  let config: LichConfig | null = null;

  let cancelled = false;
  let cancelledCleanup: Promise<void> | null = null;
  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    // Stop LogTails BEFORE owned handles — otherwise an in-flight tail read can race the kernel on the supervisor's write fd as it tears down.
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
    config = parsed.config;
    parsePhase.end("ok");

    // Resolve the active profile. Three cases: no profiles section (preserve unprofiled behavior), no arg + profiles present (pick default), explicit name (require exists).
    let resolvedProfile: ResolvedProfile | null = null;
    {
      const profiles = config.profiles;
      const hasProfilesSection =
        profiles !== undefined && Object.keys(profiles).length > 0;

      let activeProfileName: string | null = null;

      if (input.profile === undefined) {
        if (!hasProfilesSection) {
          activeProfileName = null;
        } else {
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
      ownedEnv: new Map(),
      ownedCwd: new Map(),
      activeProfile: resolvedProfile?.name,
      resolvedProfile: resolvedProfile ?? undefined,
    };
    worktreePhase.step(`stack_id=${worktree.stack_id}`);
    worktreePhase.end("ok");

    // Refuse mid-flight profile switch: if a prior `up` is in-flight or up under a different profile, require explicit `lich down` first.
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

    // Narrow services/owned to the active profile (top-level lifecycle hooks remain).
    const effectiveConfig: LichConfig = resolvedProfile
      ? filterConfigToProfile(config, resolvedProfile)
      : config;

    const graphPhase = output.phase("dependency-graph");
    const decls = buildNodeDecls(effectiveConfig);
    let levels: string[][];
    try {
      const graph = buildGraph(decls);
      validateGraph(graph);
      levels = topoLevels(graph);
    } catch (err) {
      graphPhase.end("fail");
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

    for (const decl of decls) {
      state.services.set(decl.name, {
        name: decl.name,
        kind: decl.kind,
        state: "starting",
      });
    }

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

    const envPhase = output.phase("resolve-env");
    const topLevelEnv = await resolveTopLevelEnv({
      config: effectiveConfig,
      worktree,
      allocatedPorts,
      projectRoot: worktree.path,
      profile: resolvedProfile ?? undefined,
    });
    envPhase.end("ok");

    // Closure for long-form lifecycle entries with `env_group: <name>`.
    const lifecycleResolveEnvGroup = (
      name: string,
    ): Promise<NodeJS.ProcessEnv> =>
      resolveEnvGroup({
        name,
        config: effectiveConfig,
        worktree,
        allocatedPorts,
        projectRoot: worktree.path,
        profile: resolvedProfile ?? undefined,
      });

    await ensureStackDir(worktree.stack_id);
    await writeStateSnapshot(state);

    const composeNames = Object.keys(effectiveConfig.services ?? {});
    const resolvedComposeEnv: Record<string, NodeJS.ProcessEnv> = {};
    for (const name of composeNames) {
      resolvedComposeEnv[name] = await resolveEnvForService({
        config: effectiveConfig,
        service: { kind: "compose", name },
        worktree,
        allocatedPorts,
        projectRoot: worktree.path,
        profile: resolvedProfile ?? undefined,
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
      const userFiles = collectComposeFiles(effectiveConfig, worktree.path);
      composeFiles = [...userFiles, overridePath];
      overridePhase.end("ok");

      const detectPhase = output.phase("compose-detect");
      const composeOverride = pickComposeOverride(effectiveConfig);
      composeCli = await resolveComposeCli(composeOverride);
      composeProject = `lich-${worktree.stack_id}`;
      detectPhase.end("ok", composeCli.kind);
    }

    // before_up / after_up compose top-level then profile entries (base first, then specialization).
    // before_down inverts this — see commands/down.ts.
    const beforeUpEntries = [
      ...(config.lifecycle?.before_up ?? []),
      ...(resolvedProfile?.lifecycle.before_up ?? []),
    ];
    // Lifecycle hooks never go through the supervisor, so per-port env vars need explicit injection here.
    const lifecycleEnv = enrichEnvWithOwnedPorts(
      topLevelEnv,
      config,
      allocatedPorts,
    );
    if (beforeUpEntries.length > 0) {
      const phase = output.phase("before_up");
      try {
        const beforeUpCtx = buildInterpCtx(worktree, allocatedPorts, state.capturedValues);
        await runLifecycle(
          {
            phase: "before_up",
            entries: interpolateLifecycleEntries(beforeUpEntries, beforeUpCtx, "lifecycle.before_up"),
            cwd: worktree.path,
            env: lifecycleEnv,
            resolveEnvGroup: lifecycleResolveEnvGroup,
            logDir: hooksDir(worktree.stack_id),
          },
          {
            onEntryStart: (start) => output.lifecycleEntryStart(start),
            onEntryComplete: (completion) =>
              output.lifecycleEntryComplete(completion),
          },
        );
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

    // Per-level startup: services in the same topo level run in parallel.
    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      const level = levels[levelIdx];
      const phaseName = `start ${levelIdx + 1}/${levels.length} (${level.join(", ")})`;
      const phase = output.phase(phaseName);

      // allSettled — surface every parallel failure, not just the first to reject.
      const results = await Promise.allSettled(
        level.map((name) =>
          startOneService({
            name,
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
        if (cancelled) {
          output.error({
            title: "lich up cancelled",
            detail: "cancelled by user (SIGINT)",
          });
          const cleanup = cancelledCleanup as Promise<void> | null;
          if (cleanup !== null) {
            await cleanup.catch(() => {});
          }
        } else {
          // Per-service failure block already rendered by startOneService; just name the failed services here.
          const failedNames = level.filter((n) => {
            const snap = state!.services.get(n);
            return snap?.state === "failed";
          });
          // cascade-kill in-flight siblings (default ON via `runtime.kill_others_on_fail`).
          // Cancellation branch above already tore children down via `cancelledCleanup`.
          let killedNames: string[] = [];
          if (killOthersEnabled(config.runtime)) {
            killedNames = await cascadeKillSiblings({
              ownedHandles: state.ownedHandles,
              services: state.services,
              failedNames: new Set(failedNames),
              composeCtx: composeCli && composeProject
                ? {
                    cli: composeCli,
                    project: composeProject,
                    files: composeFiles,
                    cwd: worktree.path,
                    env: topLevelEnv,
                  }
                : null,
              oneshotStopCmds: buildOneshotStopCmds(effectiveConfig, state),
            });
          }
          const baseDetail =
            failedNames.length > 0
              ? `failed services: ${failedNames.join(", ")}`
              : `${failures.length} service${failures.length === 1 ? "" : "s"} failed in this step`;
          const detail =
            killedNames.length > 0
              ? `${baseDetail}; killed: ${killedNames.join(", ")}`
              : baseDetail;
          output.error({
            title: `failed to start services in step ${levelIdx + 1}/${levels.length} (${level.join(", ")})`,
            detail,
          });
        }
        for (const tail of state.logTails.values()) {
          await tail.stop().catch(() => {});
        }
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

      // Persist between levels so a crash mid-up leaves a useful trail.
      await writeStateSnapshot(state);
    }

    const afterUpEntries = [
      ...(config.lifecycle?.after_up ?? []),
      ...(resolvedProfile?.lifecycle.after_up ?? []),
    ];
    if (afterUpEntries.length > 0) {
      const phase = output.phase("after_up");
      try {
        const afterUpCtx = buildInterpCtx(worktree, allocatedPorts, state.capturedValues);
        await runLifecycle(
          {
            phase: "after_up",
            entries: interpolateLifecycleEntries(afterUpEntries, afterUpCtx, "lifecycle.after_up"),
            cwd: worktree.path,
            env: lifecycleEnv,
            resolveEnvGroup: lifecycleResolveEnvGroup,
            logDir: hooksDir(worktree.stack_id),
          },
          {
            onEntryStart: (start) => output.lifecycleEntryStart(start),
            onEntryComplete: (completion) =>
              output.lifecycleEntryComplete(completion),
          },
        );
      } catch (err) {
        phase.end("fail");
        // after_up runs after all services are ready but before the stack is marked up — cascade-kill since no siblings remain useful.
        let killedNames: string[] = [];
        if (killOthersEnabled(config.runtime)) {
          killedNames = await cascadeKillSiblings({
            ownedHandles: state.ownedHandles,
            services: state.services,
            failedNames: new Set(),
            composeCtx: composeCli && composeProject
              ? {
                  cli: composeCli,
                  project: composeProject,
                  files: composeFiles,
                  cwd: worktree.path,
                  env: topLevelEnv,
                }
              : null,
            oneshotStopCmds: buildOneshotStopCmds(effectiveConfig, state),
          });
        }
        const baseDetail = (err as Error).message;
        const detail =
          killedNames.length > 0
            ? `${baseDetail}; killed: ${killedNames.join(", ")}`
            : baseDetail;
        output.error({
          title: "lifecycle.after_up failed",
          detail,
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

    state.status = "up";
    // Snapshot teardown lifecycle entries before the final write so `lich down` never needs to re-parse yaml.
    // before_down runs profile-first then top-level (LIFO); after_down mirrors that order.
    state.stackBeforeDown = await resolveSnapshotLifecycle(
      [
        ...(resolvedProfile?.lifecycle.before_down ?? []),
        ...(config.lifecycle?.before_down ?? []),
      ],
      lifecycleEnv,
      lifecycleResolveEnvGroup,
    );
    state.stackAfterDown = await resolveSnapshotLifecycle(
      [
        ...(resolvedProfile?.lifecycle.after_down ?? []),
        ...(config.lifecycle?.after_down ?? []),
      ],
      lifecycleEnv,
      lifecycleResolveEnvGroup,
    );
    // Populate routing BEFORE the final snapshot so the daemon's fs-watcher sees `routing` on its first read.
    state.routing = buildRoutingEntries(state);
    await writeStateSnapshot(state);

    // Daemon auto-start. Must come AFTER the success snapshot so the watcher sees freshly-written `routing` on first read.
    // Failures here NEVER fail the up — the stack is ready, the dashboard is a nicety.
    const envNoBrowser =
      process.env.LICH_NO_BROWSER === "1" ||
      process.env.LICH_NO_BROWSER === "true";
    const noBrowser = (input.noBrowser ?? false) || envNoBrowser;
    const configuredProxyPort = config.runtime?.proxy_port;
    try {
      const lichHomeEnv = process.env.LICH_HOME;
      const ensureOpts: Parameters<typeof ensureDaemonRunning>[0] = {
        openBrowser: !noBrowser,
      };
      if (lichHomeEnv !== undefined) ensureOpts.lichHome = lichHomeEnv;
      if (typeof configuredProxyPort === "number") {
        ensureOpts.proxyPort = configuredProxyPort;
      }
      const { url: rawDashboardUrl, alreadyRunning } =
        await ensureDaemonRunning(ensureOpts);
      // rawDashboardUrl is used for the /api/routing call below (not proxied); the user-facing line gets the friendly apex.
      const dashboardProxyPort = configuredProxyPort ?? DEFAULT_PROXY_PORT;
      const friendlyDashboardUrl = `http://lich.localhost:${dashboardProxyPort}/`;
      const suffix = alreadyRunning ? " (daemon was already running)" : "";
      output.info(`Dashboard: ${friendlyDashboardUrl}${suffix}`);

      // Wait for the daemon's routing table to reflect this stack's hostnames before returning,
      // so an immediate proxy probe doesn't 404 while the watcher's 100ms debounce settles.
      const expectedHostnames = (state.routing ?? []).map((r) =>
        r.hostname.toLowerCase(),
      );
      if (expectedHostnames.length > 0) {
        // LICH_ROUTING_WAIT_TIMEOUT_MS is undocumented — only used by tests.
        const overrideTimeout = process.env.LICH_ROUTING_WAIT_TIMEOUT_MS;
        const overrideTimeoutNum = overrideTimeout
          ? Number(overrideTimeout)
          : NaN;
        await waitForRoutingReady({
          dashboardUrl: rawDashboardUrl,
          expectedHostnames,
          warn: (msg) => output.info(`[lich] warning: ${msg}`),
          ...(Number.isFinite(overrideTimeoutNum)
            ? { timeoutMs: overrideTimeoutNum }
            : {}),
        });
      }
    } catch (err) {
      // Daemon failures never fail the up — the stack is ready, the dashboard is a nicety.
      output.info(
        `[lich] warning: daemon auto-start failed: ${(err as Error).message}`,
      );
    }

    const summaryProxyPort = configuredProxyPort ?? DEFAULT_PROXY_PORT;
    output.summary(
      buildSuccessSummary({
        stackId: worktree.stack_id,
        worktreeName: worktree.name,
        services: [...state.services.values()],
        elapsedMs: Date.now() - runStartedAtMs,
        routing: state.routing,
        proxyPort: summaryProxyPort,
        raw: input.raw === true,
      }),
    );
    await output.close();

    // INTENTIONAL: do NOT stop LogTails on the happy-path return.
    // `fail_when.log_match` stays armed for the entire stack lifetime — a service that emits EADDRINUSE five minutes
    // post-up still trips its fail_when and the failure lands in state.json. Tails are stopped on `lich down`.
    if (signal) signal.removeEventListener("abort", onAbort);
    return {
      exitCode: 0,
      stackId: worktree.stack_id,
      services: snapshotServiceStates(state),
    };
  } catch (err) {
    if (cancelled) {
      output.error({
        title: "lich up cancelled",
        detail: "cancelled by user (SIGINT)",
      });
      const cleanup = cancelledCleanup as Promise<void> | null;
      if (cleanup !== null) {
        await cleanup.catch(() => {});
      }
    } else {
      // Unexpected throws during the startup race cascade-kill in-flight siblings.
      // `state.status !== "up"` documents the startup-race gate (success path returns above; we never reach here once up).
      let killedNames: string[] = [];
      if (state && state.status !== "up" && killOthersEnabled(config?.runtime)) {
        killedNames = await cascadeKillSiblings({
          ownedHandles: state.ownedHandles,
          services: state.services,
          failedNames: new Set(),
          // composeCtx may not be built yet at this point — owned handles still get SIGTERM'd; compose cleanup falls to `lich down`.
          composeCtx: null,
          oneshotStopCmds: config ? buildOneshotStopCmds(config, state) : undefined,
        });
      }
      const baseDetail = describeError(err);
      const detail =
        killedNames.length > 0
          ? `${baseDetail}; killed: ${killedNames.join(", ")}`
          : baseDetail;
      output.error({
        title: "lich up failed",
        detail,
      });
    }
    if (state) {
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
  resolveEnvGroup: (name: string) => Promise<NodeJS.ProcessEnv>;
}

/** Start a single service to "ready". Throws on any failure — caller's Promise.allSettled aggregates failures across a level. */
async function startOneService(input: StartOneInput): Promise<void> {
  const { name, config, state, output } = input;
  const snap = state.services.get(name);
  if (!snap) {
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
  const interpCtxForService = buildInterpCtx(input.worktree, input.allocatedPorts, state.capturedValues);

  try {
    if (lifecycle?.before_start && lifecycle.before_start.length > 0) {
      await runPerServiceLifecycle({
        serviceName: name,
        phase: "before_start",
        entries: interpolateLifecycleEntries(lifecycle.before_start, interpCtxForService, `owned.${name}.lifecycle.before_start`),
        cwd: input.worktree.path,
        env: input.topLevelEnv,
        resolveEnvGroup: input.resolveEnvGroup,
      });
    }

    if (isOwned) {
      await startOwned(input, ownedDef!);
    } else {
      await startCompose(input);
    }
    snap.state = "healthy" satisfies ServiceState;
    snap.started_at = new Date().toISOString();
    output.service(name, "healthy");

    await waitReady(input, isOwned ? ownedDef! : composeDef!, isOwned);

    // Race after_ready against the exit watcher so a process that exits between ready and post-ready hooks fails the up.
    if (lifecycle?.after_ready && lifecycle.after_ready.length > 0) {
      await raceWithExitWatcher(
        runPerServiceLifecycle({
          serviceName: name,
          phase: "after_ready",
          entries: interpolateLifecycleEntries(lifecycle.after_ready, interpCtxForService, `owned.${name}.lifecycle.after_ready`),
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

    // Classify → format → render → persist on snapshot. Best-effort: a classifier throw shouldn't mask the original error.
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
      snap.failure_reason = block.reason;
      snap.failure_log_tail = block.logTail;
    } catch {
      snap.failure_reason = describeError(err);
    }

    throw err;
  }
}

/** Classify a thrown error into the typed FailureInput the formatter consumes. Unknown errors fall back to a synthesized exit-shape. */
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

  // Error.cause shaped as a ProcessExitFailure (set by the exit-watcher race in waitReady).
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

  // No matching variant — synthesize a generic exit failure so the user still sees a structured block.
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

/** Build an InterpolationContext from worktree + allocated ports + optional captures. */
function buildInterpCtx(
  worktree: import("../worktree/detect.js").Worktree,
  allocatedPorts: AllocatedPorts,
  capturedValues?: Record<string, Record<string, string>>,
): InterpolationContext {
  const services: InterpolationContext["services"] = {};
  for (const [svc, ports] of Object.entries(allocatedPorts.compose)) {
    const keys = Object.keys(ports);
    services[svc] = {
      host_port: keys.length > 0 ? ports[keys[0]] : undefined,
      ports: { ...ports },
    };
  }
  const owned: InterpolationContext["owned"] = {};
  for (const [svc, entry] of Object.entries(allocatedPorts.owned)) {
    const captured = capturedValues?.[svc];
    owned[svc] = {
      port: entry.port,
      ports: entry.ports,
      ...(captured !== undefined ? { captured } : {}),
    };
  }
  return {
    worktree: { name: worktree.name, id: worktree.id, path: worktree.path },
    services,
    owned,
  };
}

/** Interpolate lich `${...}` refs in each lifecycle entry's cmd; unknown shapes (plain shell vars) pass through. */
function interpolateLifecycleEntries(
  entries: Array<string | { cmd: string; env_group?: string }>,
  ctx: InterpolationContext,
  source: string,
): Array<string | { cmd: string; env_group?: string }> {
  return entries.map((entry, i) => {
    if (typeof entry === "string") {
      return interpolateString(entry, ctx, `${source}[${i}]`, true);
    }
    return { ...entry, cmd: interpolateString(entry.cmd, ctx, `${source}[${i}].cmd`, true) };
  });
}

async function startOwned(
  input: StartOneInput,
  def: OwnedService,
): Promise<void> {
  const { name, config, worktree, allocatedPorts, state } = input;

  // capturedValues threads `${owned.<earlier>.captured.<key>}` from earlier services into env interpolation.
  // Same-level services CAN'T see each other's captures — start in parallel; declare a depends_on edge to force ordering.
  const env = await resolveEnvForService({
    config,
    service: { kind: "owned", name },
    worktree,
    allocatedPorts,
    projectRoot: worktree.path,
    capturedValues: state.capturedValues,
    profile: state.resolvedProfile,
  });

  const interpCtx = buildInterpCtx(worktree, allocatedPorts, state.capturedValues);
  const resolvedCmd = interpolateString(def.cmd, interpCtx, `owned.${name}.cmd`, true);
  const resolvedStopCmd = def.stop_cmd
    ? interpolateString(def.stop_cmd, interpCtx, `owned.${name}.stop_cmd`, true)
    : undefined;

  const spec: OwnedServiceSpec = {
    name,
    cmd: resolvedCmd,
    cwd: resolveOwnedCwd(def, worktree.path),
    env,
    logPath: serviceLogPath(worktree.stack_id, name),
  };

  // Stash the resolved env + cwd so `ready_when.cmd` (run before the service is
  // ready) shells out against the same context the supervised process saw.
  state.ownedEnv.set(name, env);
  state.ownedCwd.set(name, spec.cwd);

  // Snapshot teardown fields so `lich down` never needs to re-parse yaml.
  const svcSnap = state.services.get(name);
  if (svcSnap) {
    svcSnap.cmd = resolvedCmd;
    if (resolvedStopCmd !== undefined) svcSnap.stop_cmd = resolvedStopCmd;
    svcSnap.resolved_env = stringifyEnv(env);
    svcSnap.depends_on = def.depends_on ?? [];
    svcSnap.service_cwd = spec.cwd;
    if (def.ready_when !== undefined) {
      svcSnap.ready_when = def.ready_when as Record<string, unknown>;
    }
    if (def.lifecycle?.before_down && def.lifecycle.before_down.length > 0) {
      svcSnap.before_down = def.lifecycle.before_down.map((entry) => ({
        cmd: typeof entry === "string" ? entry : entry.cmd,
        env: stringifyEnv(input.topLevelEnv),
      }));
    }
  }

  if (def.port !== undefined) {
    const envVar = portDescriptorEnv(def.port);
    const allocated = allocatedPorts.owned[name]?.port;
    if (envVar && allocated !== undefined) {
      spec.portEnvVar = envVar;
      spec.port = allocated;
    } else if (allocated !== undefined) {
      spec.port = allocated;
    }
  }

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
  if (resolvedStopCmd) spec.stopCmd = resolvedStopCmd;
  // Thread the abort signal — supabase-style setup CLIs ignore SIGTERM, so without it Ctrl-C during a oneshot is a no-op.
  if (input.signal) spec.signal = input.signal;

  if (def.oneshot) {
    await runOneshot(spec);
    // Log AFTER successful exit so a future `lich nuke --rescue` has stop_cmd + resolved env.
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: worktree.stack_id,
      kind: "owned",
      service: name,
      cmd: resolvedCmd,
      stop_cmd: resolvedStopCmd ?? def.stop_cmd,
      cwd: spec.cwd,
      env: stringifyEnv(env),
    });
    return;
  }

  const handle = await startOwnedService(spec);
  state.ownedHandles.set(name, handle);

  // One LogTail per service, shared by ready_when, fail_when, capture, and the dashboard live tail.
  // Start at the pre-spawn offset so prior-run content is invisible to fail_when/ready_when.
  const tail = new LogTail({
    logPath: spec.logPath,
    signal: input.signal,
    startOffset: handle.logStartOffset,
  });
  await tail.start();
  state.logTails.set(name, tail);

  // Stage-aware exit watcher: waitReady flips during_startup → before_ready → after_ready; the watcher samples lazily.
  state.stageRefs.set(name, "during_startup");
  const exitWatcher = new ProcessExitWatcher(handle, {
    // Default to `after_ready` if the entry's gone — most-conservative label.
    readSignal: () => state.stageRefs.get(name) ?? "after_ready",
  });
  state.exitWatchers.set(name, exitWatcher);

  // Record pid on the snapshot so `lich down`'s `stopOwnedService` has it.
  // Without this, the snapshot pid stays undefined, stopOwnedService short-circuits, and the service leaks past teardown.
  const snap = state.services.get(name);
  if (snap && typeof handle.pid === "number" && Number.isFinite(handle.pid)) {
    snap.pid = handle.pid;
  }

  // Two started.log entries: `pid` (rescue direct-kill) and `owned` (rescue stop_cmd path).
  // Either alone misses cases; both is cheap and idempotent at rescue time.
  if (typeof handle.pid === "number" && Number.isFinite(handle.pid)) {
    await appendStarted({
      ts: new Date().toISOString(),
      stack_id: worktree.stack_id,
      kind: "pid",
      service: name,
      pid: handle.pid,
      cmd: resolvedCmd,
      cwd: spec.cwd,
    });
  }
  await appendStarted({
    ts: new Date().toISOString(),
    stack_id: worktree.stack_id,
    kind: "owned",
    service: name,
    cmd: resolvedCmd,
    stop_cmd: resolvedStopCmd ?? def.stop_cmd,
    cwd: spec.cwd,
    env: stringifyEnv(env),
  });
}

async function startCompose(input: StartOneInput): Promise<void> {
  const { name, composeCtx, worktree, config, state } = input;
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
  // Snapshot depends_on for teardown ordering so down never needs to re-parse yaml.
  const svcSnap = state.services.get(name);
  if (svcSnap) {
    const def = config.services?.[name];
    svcSnap.depends_on = def?.depends_on ?? [];
    if (def?.lifecycle?.before_down && def.lifecycle.before_down.length > 0) {
      svcSnap.before_down = def.lifecycle.before_down.map((entry) => ({
        cmd: typeof entry === "string" ? entry : entry.cmd,
        env: {},
      }));
    }
  }
  // Logged per-invocation; idempotent at rescue time (`compose down -p` is a no-op on a down project).
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

async function waitReady(
  input: StartOneInput,
  def: OwnedService | ComposeService,
  isOwned: boolean,
): Promise<void> {
  const ready = (def as OwnedService).ready_when;
  const { name, worktree, signal, state } = input;

  // Owned services without ready_when still get an exit-watcher probe so `cmd: exit 1` aborts the up.
  // Compose services have no OwnedHandle — they keep the early-return behavior.
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
    // Flip stage so any after_ready hook exit gets labeled correctly.
    if (state.stageRefs.has(name)) {
      state.stageRefs.set(name, "after_ready");
    }
    return;
  }

  const interpCtx: InterpolationContext = {
    worktree: {
      name: worktree.name,
      id: worktree.id,
      path: worktree.path,
    },
    services: Object.fromEntries(
      Object.entries(input.allocatedPorts.compose).map(([svc, ports]) => [
        svc,
        {
          host_port: Object.values(ports)[0],
          ports: { ...ports },
        },
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

  // Race the ready evaluator against fail_when (if configured) and the exit watcher (owned only).
  const failWhenAc = new AbortController();
  const racers: Promise<unknown>[] = [];

  // Wire fail_when first so a retroactive buffer match can fire before the ready evaluator starts.
  // Compose services have no LogTail; fail_when is shape-accepted but is a no-op for them.
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

  const readyPromise = buildReadyEvaluator(input, def, isOwned, interpCtx);
  const timeoutMs = resolveReadyTimeoutMs(ready, isOwned, input.config.runtime);
  const phaseLabel = identifyReadyPhase(ready);
  const racedReady =
    timeoutMs !== null
      ? withTimeout(readyPromise, { ms: timeoutMs, phase: phaseLabel })
      : readyPromise;

  // Flip stage BEFORE wrapping with failOnExitDuringReady so readSignal returns `before_ready` at exit time.
  if (state.stageRefs.has(name)) {
    state.stageRefs.set(name, "before_ready");
  }

  // Owned services fail-fast on ANY exit during ready (zero or non-zero).
  // Compose has its own restart policy — no fail-fast race needed.
  const exitWatcher = isOwned ? state.exitWatchers.get(name) : undefined;
  const racedReadyWithExitFailFast =
    exitWatcher !== undefined
      ? failOnExitDuringReady({
          readyPromise: racedReady,
          exitWatcher,
          serviceName: name,
        })
      : racedReady;
  racers.push(racedReadyWithExitFailFast);

  try {
    await Promise.race(racers);
  } finally {
    // fail_when never resolves on its own (watchFailWhen contract) — abort to unsubscribe from the LogTail.
    failWhenAc.abort();
  }

  // capture extraction; CaptureMissError propagates to startOneService's catch.
  if (ready.capture !== undefined && tail !== undefined) {
    const patterns = ready.capture;
    if (Object.keys(patterns).length > 0) {
      const captured = runCapture({ tail, patterns });
      state.capturedValues[name] = captured;
    }
  }

  if (state.stageRefs.has(name)) {
    state.stageRefs.set(name, "after_ready");
  }
}

/**
 * Brief, non-blocking check that an owned service has exited.
 * 100ms window is long enough for the supervisor's exit handler to settle the cached `wait()` promise for an
 * immediate-exit cmd (`exit 1`, ENOENT, etc.) but short enough to be invisible in overall up latency.
 * Returns the failure payload on exit, null if still alive (or exited cleanly).
 */
async function checkExitedNow(
  watcher: ProcessExitWatcher,
): Promise<Awaited<ReturnType<ProcessExitWatcher["wait"]>>> {
  const sentinel = Symbol("alive");
  const result = await Promise.race([
    watcher.wait(),
    new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), 100)),
  ]);
  if (result === sentinel) return null;
  return result;
}

/**
 * Race a promise against an owned service's exit watcher.
 * Used to wrap after_ready lifecycle so a crash during post-ready hooks still fails `lich up`.
 * Compose services (no watcher) get the bare promise back.
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
        // Clean exit — refuse to resolve so the lifecycle promise wins. Mirrors waitReady's null→never semantic.
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
 * Build the ready-evaluator promise WITHOUT timeout/fail_when/exit-watcher wrapping — caller composes those via Promise.race.
 * Returns a resolved promise for ready_when shapes lich doesn't probe (cmd, capture-only, timeout-only).
 */
function buildReadyEvaluator(
  input: StartOneInput,
  def: OwnedService | ComposeService,
  isOwned: boolean,
  interpCtx: InterpolationContext,
): Promise<void> {
  const ready = (def as OwnedService).ready_when;
  if (!ready) return Promise.resolve();

  const { name, worktree, signal, state } = input;

  if (typeof ready.log_match === "string" && ready.log_match.length > 0) {
    const pattern = new RegExp(ready.log_match, "u");
    // Owned services share the registry's LogTail; compose gets a single-use tail.
    let tail = isOwned ? state.logTails.get(name) : undefined;
    let stopAfter = false;
    if (tail === undefined) {
      const logPath = serviceLogPath(worktree.stack_id, name);
      tail = new LogTail({ logPath, signal });
      stopAfter = true;
      void tail.start();
    }
    const tailNonNull = tail;
    return waitForLogMatch({ tail: tailNonNull, pattern, signal }).finally(
      () => {
        if (stopAfter) {
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
    input.output.service(name, "initializing", `waiting on ${url}`);
    return waitForHttpReady({ url, signal });
  }

  if (typeof ready.tcp === "string" && ready.tcp.length > 0) {
    const target = interpolateString(
      ready.tcp,
      interpCtx,
      `${name}.ready_when.tcp`,
    );
    input.output.service(name, "initializing", `waiting on tcp ${target}`);
    return waitForTcpReady({ target, signal });
  }

  if (typeof ready.cmd === "string" && ready.cmd.length > 0) {
    const shellCmd = interpolateString(
      ready.cmd,
      interpCtx,
      `${name}.ready_when.cmd`,
    );
    // Owned-only field per schema; env + cwd were stashed by startOwned.
    const env = state.ownedEnv.get(name) ?? {};
    const cwd = state.ownedCwd.get(name) ?? worktree.path;
    input.output.service(name, "initializing", `waiting on cmd`);
    return waitForCmdReady({ shellCmd, env, cwd, signal });
  }

  // ready_when present but no recognized probe field (capture-only / timeout-only) — resolve immediately.
  return Promise.resolve();
}

function readyFailWhenPattern(
  def: OwnedService | ComposeService,
): RegExp | null {
  const fw = (def as OwnedService).fail_when;
  if (!fw) return null;
  if (typeof fw.log_match !== "string" || fw.log_match.length === 0) return null;
  // `u` flag matches every other regex callsite (validate, capture, log_match).
  return new RegExp(fw.log_match, "u");
}

/**
 * Resolve the effective ready-evaluator timeout. For owned: per-service `ready.timeout` → `runtime.ready_when_timeout` →
 * 60s default. For compose: per-service `ready.timeout` only (compose has its own healthcheck policy).
 * Returns null to skip the timeout wrap.
 */
export function resolveReadyTimeoutMs(
  ready: NonNullable<OwnedService["ready_when"]>,
  isOwned: boolean,
  runtime: LichConfig["runtime"],
): number | null {
  if (ready.timeout !== undefined) {
    return parseDuration(ready.timeout);
  }
  if (!isOwned) return null;
  if (runtime?.ready_when_timeout !== undefined) {
    return parseDuration(runtime.ready_when_timeout);
  }
  return DEFAULT_OWNED_READY_TIMEOUT_MS;
}

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
  if (typeof ready.cmd === "string" && ready.cmd.length > 0) {
    return "cmd";
  }
  return undefined;
}

/** Build the HTTP URL for a ready probe — accepts an absolute URL or a relative path synthesized against the primary port. */
function buildHttpUrl(
  pathOrUrl: string,
  def: OwnedService | ComposeService,
  input: StartOneInput,
): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
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

/**
 * Shallow clone of {@link LichConfig} with `services` and `owned` narrowed to entries in the resolved profile.
 * Every other top-level field is preserved by reference. Profile-excluded services become structurally absent —
 * `validateGraph` then naturally fails on depends_on edges pointing at them, which `formatGraphError` re-words with
 * profile context.
 */
function filterConfigToProfile(
  config: LichConfig,
  profile: ResolvedProfile,
): LichConfig {
  const includedServices = new Set(profile.services);
  const includedOwned = new Set(profile.owned);

  const services: Record<string, NonNullable<typeof config.services>[string]> =
    {};
  for (const [name, def] of Object.entries(config.services ?? {})) {
    if (includedServices.has(name) && def !== undefined) {
      services[name] = def;
    }
  }
  const owned: Record<string, NonNullable<typeof config.owned>[string]> = {};
  for (const [name, def] of Object.entries(config.owned ?? {})) {
    if (includedOwned.has(name) && def !== undefined) {
      owned[name] = def;
    }
  }

  return {
    ...config,
    services,
    owned,
  };
}

/** Format graph errors with profile context when a profile is active — explains why a `depends_on` target is unresolved. */
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

interface AllocatedPorts {
  compose: Record<string, Record<string, number>>;
  owned: Record<string, { port?: number; ports?: Record<string, number> }>;
}

/**
 * Flat key scheme for the allocator. Decoded by {@link decodeAllocations}.
 *   compose:<serviceName>:<portKey>
 *   owned-single:<serviceName>
 *   owned-multi:<serviceName>:<portKey>
 * Values: null = allocator picks; number = user-pinned port.
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
        // Skip entries with neither a container port nor an env var — nothing to allocate for.
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
 * Layer per-owned-service port env vars onto a base env for lifecycle hooks.
 * Hooks bypass the supervisor, so without this they see `topLevelEnv` only and per-port vars (SUPABASE_DB_PORT etc.)
 * are absent — breaks tools that read config files referencing those vars.
 * Mirrors `injectOwnedPortEnv` in state/snapshot.ts but operates on the in-memory AllocatedPorts.
 */
function enrichEnvWithOwnedPorts(
  env: NodeJS.ProcessEnv,
  config: LichConfig,
  allocatedPorts: AllocatedPorts,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };

  for (const [svcName, svcDef] of Object.entries(config.owned ?? {})) {
    if (!svcDef) continue;
    const allocatedForOwned = allocatedPorts.owned[svcName];
    if (!allocatedForOwned) continue;

    if (svcDef.port !== undefined) {
      const envVar = portDescriptorEnv(svcDef.port);
      if (envVar && allocatedForOwned.port !== undefined) {
        out[envVar] = String(allocatedForOwned.port);
      }
    }

    if (svcDef.ports) {
      for (const [logical, desc] of Object.entries(svcDef.ports)) {
        const envVar = portDescriptorEnv(desc);
        const port = allocatedForOwned.ports?.[logical];
        if (envVar && port !== undefined) {
          out[envVar] = String(port);
        }
      }
    }
  }

  return out;
}

function decodeAllocations(
  portMap: Record<string, number>,
  _plan: PortPlan,
): AllocatedPorts {
  const compose: AllocatedPorts["compose"] = {};
  const owned: AllocatedPorts["owned"] = {};

  for (const [key, port] of Object.entries(portMap)) {
    if (key.startsWith("compose:")) {
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

/** Input for {@link buildSuccessSummary}. Exported for unit tests. */
export interface BuildSummaryInput {
  stackId: string;
  worktreeName: string;
  services: ServiceSnapshot[];
  elapsedMs: number;
  /** Friendly-URL routing — empty/undefined falls back to raw URLs. */
  routing?: readonly RoutingEntry[];
  /** Resolved proxy port (yaml `runtime.proxy_port` or default). Only consulted when routing is non-empty and raw is false. */
  proxyPort: number;
  /** True to emit raw `http://127.0.0.1:<port>` URLs instead of friendly proxied URLs. */
  raw: boolean;
}

/** Build the structured success summary block. URL formatters are shared with `lich urls` via urls/format.ts. */
export function buildSuccessSummary(input: BuildSummaryInput): SummaryBlock {
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

  // Default: friendly URLs. Fall back to raw when `--raw` is set OR routing is empty (stack with zero portful services).
  let urls: SummaryUrl[] = [];
  if (!input.raw && input.routing && input.routing.length > 0) {
    const friendlyUrls = buildFriendlyUrls(input.routing, input.proxyPort);
    urls = friendlyUrls.map((u) => ({ service: u.service, url: u.url }));
  } else {
    const rawUrls = buildRawUrls(input.services);
    urls = rawUrls.map((u) => ({ service: u.service, url: u.url }));
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

/** Minimum slice of {@link UpState} for {@link buildRoutingEntries}. Exported separately so unit tests can build synthetic input. */
export interface RoutingInput {
  worktree: { name: string };
  services: Map<string, ServiceSnapshot>;
}

/**
 * Compute friendly-URL routing entries for a fully-ready stack. The daemon's reverse proxy reads these from state.json.
 *
 * Hostname convention:
 *   single-port:  `<service>.<worktree>`            (e.g. `api.feature-x`)
 *   multi-port:   `<service>-<portkey>.<worktree>`  (e.g. `supabase-api.feature-x`)
 *
 * We use `-` (not `.`) between service and portkey because `*.lich.localhost` binds only one subdomain level.
 * Services with no allocated ports produce zero entries.
 */
export function buildRoutingEntries(state: RoutingInput): RoutingEntry[] {
  const worktreeName = state.worktree.name;
  const entries: RoutingEntry[] = [];

  for (const svc of state.services.values()) {
    const ports = svc.allocated_ports;
    if (!ports || Object.keys(ports).length === 0) continue;

    const portKeys = Object.keys(ports);
    if (portKeys.length === 1) {
      const port = ports[portKeys[0]];
      entries.push({
        hostname: `${svc.name}.${worktreeName}`,
        upstream_url: `http://127.0.0.1:${port}`,
        service: svc.name,
      });
      continue;
    }

    for (const portKey of portKeys) {
      const port = ports[portKey];
      entries.push({
        hostname: `${svc.name}-${portKey}.${worktreeName}`,
        upstream_url: `http://127.0.0.1:${port}`,
        service: svc.name,
      });
    }
  }

  return entries;
}

async function writeStateSnapshot(state: UpState): Promise<void> {
  const snapshot: StackSnapshot = {
    stack_id: state.worktree.stack_id,
    worktree_name: state.worktree.name,
    worktree_path: state.worktree.path,
    status: state.status,
    started_at: state.startedAt,
    services: [...state.services.values()],
    active_profile: state.activeProfile,
  };
  if (state.activeProfile !== undefined) {
    snapshot.active_profile = state.activeProfile;
  }
  // `state.routing` distinguishes undefined (mid-startup/failed — omit key) from [] (stack with zero routes — emit empty array).
  if (state.routing !== undefined) {
    snapshot.routing = state.routing;
  }
  if (state.stackBeforeDown !== undefined) {
    snapshot.before_down = state.stackBeforeDown;
  }
  if (state.stackAfterDown !== undefined) {
    snapshot.after_down = state.stackAfterDown;
  }
  await writeSnapshot(snapshot);
  await ensureStackDir(state.worktree.stack_id).catch(() => {});
  // Keep stackDir referenced so tree-shaking doesn't drop the import.
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

/** Input shape for {@link cascadeKillSiblings}. Exported separately for unit-test ergonomics. */
export interface CascadeKillInput {
  ownedHandles: Map<string, { stop: (graceMs?: number) => Promise<void> }>;
  services: Map<string, { name: string; kind: "compose" | "owned"; state: string }>;
  /** Already-failed services; excluded from the cascade (they're either dead or torn down by the per-kind failure path). */
  failedNames: Set<string>;
  /** Compose context for project-level `compose down`. Null when no compose services in the resolved profile. */
  composeCtx: RunnerCtx | null;
  oneshotStopCmds?: Map<string, { cmd: string; cwd: string; env: NodeJS.ProcessEnv }>;
}

/**
 * Cascade-kill siblings of a failed service during the startup race.
 * Owned: SIGTERM → 5s grace → SIGKILL via handle.stop(), in parallel.
 * Compose: project-level `compose down` (NOT `-v`; this is startup-race teardown, not `lich down`).
 *
 * Only fires during startup. Post-up failures route through the supervisor/restart/dashboard surface.
 * Best-effort — teardown errors are swallowed so one bad stop_cmd doesn't prevent stopping the others.
 */
export async function cascadeKillSiblings(
  input: CascadeKillInput,
): Promise<string[]> {
  const killed: string[] = [];

  const ownedTasks: Array<Promise<void>> = [];
  for (const [name, handle] of input.ownedHandles.entries()) {
    if (input.failedNames.has(name)) continue;
    killed.push(name);
    ownedTasks.push(handle.stop().catch(() => {}));
  }

  // Oneshot services have no handle (process already exited) but their stop_cmd must still fire
  // to tear down external side-effects (e.g. supabase containers).
  if (input.oneshotStopCmds) {
    for (const [name, { cmd, cwd, env }] of input.oneshotStopCmds.entries()) {
      if (input.failedNames.has(name)) continue;
      ownedTasks.push(
        new Promise<void>((resolve) => {
          const child = spawn("/bin/sh", ["-c", cmd], {
            cwd,
            env,
            stdio: "ignore",
            detached: false,
          });
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
        }).catch(() => {}),
      );
    }
  }

  // Project-level `compose down` is more robust than per-service down (which leaves the network + orphans behind).
  const composeServicesAffected: string[] = [];
  for (const snap of input.services.values()) {
    if (snap.kind !== "compose") continue;
    if (input.failedNames.has(snap.name)) continue;
    // Skip services that never started or are already terminal.
    if (
      snap.state === "starting" ||
      snap.state === "stopped" ||
      snap.state === "failed"
    ) {
      continue;
    }
    composeServicesAffected.push(snap.name);
    killed.push(snap.name);
  }

  let composeTask: Promise<void> = Promise.resolve();
  if (composeServicesAffected.length > 0 && input.composeCtx !== null) {
    composeTask = composeDown(input.composeCtx, {
      volumes: false,
      remove_orphans: false,
    })
      .then(() => undefined)
      .catch(() => undefined);
  }

  await Promise.all([...ownedTasks, composeTask]);

  killed.sort();
  return killed;
}

function buildOneshotStopCmds(
  config: LichConfig,
  state: UpState,
): Map<string, { cmd: string; cwd: string; env: NodeJS.ProcessEnv }> {
  const result = new Map<string, { cmd: string; cwd: string; env: NodeJS.ProcessEnv }>();
  for (const [name, def] of Object.entries(config.owned ?? {})) {
    if (!def?.oneshot || typeof def.stop_cmd !== "string" || def.stop_cmd.length === 0) continue;
    const env = state.ownedEnv.get(name);
    const cwd = state.ownedCwd.get(name);
    if (!env || !cwd) continue;
    result.set(name, { cmd: def.stop_cmd, cwd, env });
  }
  return result;
}

/** Read `runtime.kill_others_on_fail` with default-true semantics. */
export function killOthersEnabled(runtime: LichConfig["runtime"]): boolean {
  return runtime?.kill_others_on_fail !== false;
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

/** Drop undefined values so the JSON-serialized started-log entry round-trips faithfully (NodeJS.ProcessEnv → Record<string, string>). */
function stringifyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function resolveSnapshotLifecycle(
  entries: import("../lifecycle/executor.js").LifecycleEntry[],
  baseEnv: NodeJS.ProcessEnv,
  resolveEnvGroup: (name: string) => Promise<NodeJS.ProcessEnv>,
): Promise<SnapshotLifecycleEntry[]> {
  const out: SnapshotLifecycleEntry[] = [];
  for (const entry of entries) {
    let cmd: string;
    let envGroup: string | undefined;
    if (typeof entry === "string") {
      cmd = entry;
      envGroup = undefined;
    } else {
      cmd = entry.cmd;
      envGroup = entry.env_group;
    }
    let env: NodeJS.ProcessEnv = baseEnv;
    if (envGroup !== undefined) {
      try {
        env = await resolveEnvGroup(envGroup);
      } catch {
        env = baseEnv;
      }
    }
    out.push({ cmd, env: stringifyEnv(env) });
  }
  return out;
}

interface WaitForRoutingOpts {
  dashboardUrl: string;
  /** Lowercased friendly hostnames; each must appear in /api/routing before we return. Caller skips empty arrays. */
  expectedHostnames: string[];
  warn: (msg: string) => void;
  /** Default 5000ms. */
  timeoutMs?: number;
  /** Default 50ms — snappy enough that the daemon's 100ms debounce resolves in one or two polls. */
  pollIntervalMs?: number;
}

/**
 * Poll /api/routing until every expected hostname is present, then return.
 *
 * The daemon's chokidar watcher has a 100ms trailing-edge debounce. Without this helper, a fast stack's `lich up`
 * would return before the debounce fires and an immediate proxy probe would 404 on its own friendly URL.
 *
 * 1. POST /api/routing/reload to bypass the debounce (best-effort).
 * 2. GET /api/routing in a poll loop until every expected hostname appears or the deadline elapses.
 * 3. Timeout → warn and continue. The stack is already up; the proxy is a UX nicety, not a correctness gate.
 */
async function waitForRoutingReady(opts: WaitForRoutingOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const base = opts.dashboardUrl.replace(/\/$/, "");

  try {
    const reloadRes = await fetch(`${base}/api/routing/reload`, {
      method: "POST",
    });
    // 503 = daemon doesn't expose the routing API (older build / fake server). GET will never succeed; bail.
    if (reloadRes.status === 503) {
      await reloadRes.text().catch(() => {});
      opts.warn(
        "daemon does not expose /api/routing (older build?); skipping routing-ready wait",
      );
      return;
    }
    await reloadRes.text().catch(() => {});
  } catch {
    // Transport error — fall through to the poll loop.
  }

  const deadline = Date.now() + timeoutMs;
  const expected = new Set(opts.expectedHostnames.map((h) => h.toLowerCase()));

  let lastSeen: string[] = [];
  let lastErr: string | null = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/routing`);
      if (res.status === 200) {
        const body = (await res.json()) as Array<{ hostname?: unknown }>;
        const seen = new Set<string>();
        for (const entry of body) {
          if (typeof entry.hostname === "string") {
            seen.add(entry.hostname.toLowerCase());
          }
        }
        lastSeen = [...seen];

        let allPresent = true;
        for (const hostname of expected) {
          if (!seen.has(hostname)) {
            allPresent = false;
            break;
          }
        }
        if (allPresent) return;
      } else {
        if (res.status === 503) {
          await res.text().catch(() => {});
          opts.warn(
            "daemon does not expose /api/routing (older build?); skipping routing-ready wait",
          );
          return;
        }
        lastErr = `GET /api/routing returned ${res.status}`;
        await res.text().catch(() => {});
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const missing = [...expected].filter((h) => !lastSeen.includes(h));
  const detail = lastErr ? ` (last error: ${lastErr})` : "";
  opts.warn(
    `routing for this stack did not appear in daemon's table within ${timeoutMs}ms; ` +
      `missing: ${missing.join(", ")}${detail}. ` +
      `Friendly URLs may 404 until the daemon catches up — raw localhost URLs work immediately.`,
  );
}

