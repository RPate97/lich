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
import { parseConfig } from "../config/parse.js";
import { detectWorktree, type Worktree } from "../worktree/detect.js";
import { allocate } from "../ports/allocator.js";
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
  writeSnapshot,
  type ServiceSnapshot,
  type ServiceState,
  type StackSnapshot,
  type StackStatus,
} from "../state/snapshot.js";
import {
  startOwnedService,
  runOneshot,
  type OwnedHandle,
  type OwnedServiceSpec,
} from "../owned/supervisor.js";
import { waitForHttpReady } from "../ready/http-get.js";
import { waitForTcpReady } from "../ready/tcp.js";
import {
  interpolateString,
  type InterpolationContext,
} from "../config/interpolation.js";
import { waitForLogMatch } from "../ready/log-match.js";
import { buildGraph, validateGraph, type NodeDecl } from "../deps/graph.js";
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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Per-stack mutable state tracked during the up sequence — service snapshots
 * the orchestrator updates as services transition through states, plus the
 * handles to running owned processes (so the caller could in theory query
 * them or pass them to a future shutdown path).
 */
interface UpState {
  worktree: Worktree;
  services: Map<string, ServiceSnapshot>;
  ownedHandles: Map<string, OwnedHandle>;
  status: StackStatus;
  startedAt: string;
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

    // ---- Step 2: detect worktree ------------------------------------------
    const worktreePhase = output.phase("worktree");
    const worktree = detectWorktree(cwd);
    state = {
      worktree,
      services: new Map(),
      ownedHandles: new Map(),
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    worktreePhase.step(`stack_id=${worktree.stack_id}`);
    worktreePhase.end("ok");

    // ---- Step 3: build dep graph + topo levels ----------------------------
    const graphPhase = output.phase("dependency-graph");
    const decls = buildNodeDecls(config);
    let levels: string[][];
    try {
      const graph = buildGraph(decls);
      validateGraph(graph);
      levels = topoLevels(graph);
    } catch (err) {
      graphPhase.end("fail");
      const msg = err instanceof CycleError
        ? `dependency cycle: ${err.cycle.join(" → ")}`
        : (err as Error).message;
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
    const portsPhase = output.phase("allocate-ports");
    const portPlan = buildPortPlan(config);
    const range = pickPortRange(config);

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
    const envPhase = output.phase("resolve-env");
    const topLevelEnv = await resolveTopLevelEnv({
      config,
      worktree,
      allocatedPorts,
      projectRoot: worktree.path,
    });
    envPhase.end("ok");

    // ---- Step 6: state dir + initial state.json ---------------------------
    await ensureStackDir(worktree.stack_id);
    await writeStateSnapshot(state);

    // ---- Step 7: compose override -----------------------------------------
    // Resolve per-compose-service env up-front so the override can embed it
    // into the file. (Compose services don't have per-service env layers in
    // Plan 1 — `resolveEnvForService` just returns the top-level layer for
    // them — but we go through the same path so any future per-service env
    // is automatically picked up.)
    const composeNames = Object.keys(config.services ?? {});
    const resolvedComposeEnv: Record<string, NodeJS.ProcessEnv> = {};
    for (const name of composeNames) {
      resolvedComposeEnv[name] = await resolveEnvForService({
        config,
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
        config,
        allocatedPorts: { compose: allocatedPorts.compose },
        resolvedEnv: resolvedComposeEnv,
        stackId: worktree.stack_id,
      });
      // Compose needs the user's compose file(s) too. Plan 1 reads them off
      // the per-service `compose_file:` field. The dogfood stack pattern is
      // a single shared file referenced by every service.
      const userFiles = collectComposeFiles(config, worktree.path);
      composeFiles = [...userFiles, overridePath];
      overridePhase.end("ok");

      const detectPhase = output.phase("compose-detect");
      const composeOverride = pickComposeOverride(config);
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
            config,
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
          }),
        ),
      );

      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (failures.length > 0) {
        phase.end("fail");
        const detail = failures.map((f) => describeError(f.reason)).join("\n");
        // LEV-301: surface the same friendly N/total coordinate the
        // success path uses, not the level index.
        output.error({
          title: `failed to start services in step ${levelIdx + 1}/${levels.length} (${level.join(", ")})`,
          detail,
        });
        // markFailed has already been called per-service inside startOne.
        await markStackFailed(state);
        await output.close();
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

    return {
      exitCode: 0,
      stackId: worktree.stack_id,
      services: snapshotServiceStates(state),
    };
  } catch (err) {
    // Catch-all for any unexpected synchronous/asynchronous throw we didn't
    // route above (parse errors and friends are handled inline).
    output.error({
      title: "lich up failed",
      detail: describeError(err),
    });
    if (state) {
      await markStackFailed(state).catch(() => {});
    }
    await output.close();
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
    if (lifecycle?.after_ready && lifecycle.after_ready.length > 0) {
      await runPerServiceLifecycle({
        serviceName: name,
        phase: "after_ready",
        entries: lifecycle.after_ready,
        cwd: input.worktree.path,
        env: input.topLevelEnv,
      });
    }

    snap.state = "ready" satisfies ServiceState;
    output.service(name, "ready");
  } catch (err) {
    snap.state = "failed" satisfies ServiceState;
    output.service(name, "failed", describeError(err));
    throw err;
  }
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
  const env = await resolveEnvForService({
    config,
    service: { kind: "owned", name },
    worktree,
    allocatedPorts,
    projectRoot: worktree.path,
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

  if (def.oneshot) {
    // Oneshots run to completion as the "start" step — runOneshot throws
    // on non-zero exit, with the log tail in the message.
    await runOneshot(spec);
    return;
  }

  // Long-lived owned service: spawn and immediately check it didn't crash.
  const handle = await startOwnedService(spec);
  state.ownedHandles.set(name, handle);

  // If the process exited within the first few ms (e.g. `cmd: exit 1`),
  // surface that as a startup failure rather than waiting on `ready_when`
  // (which would never resolve). Race the exited promise against a short
  // sentinel to detect immediate exits without blocking long-running cmds.
  const sentinelMs = 100;
  const earlyExit = await Promise.race([
    handle.exited.then((r) => ({ kind: "exited" as const, result: r })),
    new Promise<{ kind: "alive" }>((r) =>
      setTimeout(() => r({ kind: "alive" }), sentinelMs),
    ),
  ]);
  if (earlyExit.kind === "exited") {
    const r = earlyExit.result;
    const exitDesc = r.code !== null ? `exit ${r.code}` : `signal ${r.signal}`;
    throw new Error(
      `owned service "${name}" exited immediately (${exitDesc}) — check ${spec.logPath}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Compose start
// ---------------------------------------------------------------------------

async function startCompose(input: StartOneInput): Promise<void> {
  const { name, composeCtx } = input;
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
  if (!ready) return;

  const { name, worktree, signal } = input;

  // Build interpolation context for any ${...} refs inside ready_when fields.
  // The dogfood-stack uses this e.g. ready_when: { tcp: "localhost:${owned.supabase.ports.api}" }.
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
      Object.entries(input.allocatedPorts.owned).map(([svc, entry]) => [
        svc,
        { port: entry.port, ports: entry.ports },
      ]),
    ),
  };

  if (typeof ready.log_match === "string" && ready.log_match.length > 0) {
    // Compile the regex up front; validate has already done this but we
    // can't carry the compiled form across the parse boundary cheaply, so
    // recompile. A syntactically invalid pattern surfaces as an immediate
    // throw — but validate would have caught that already.
    const pattern = new RegExp(ready.log_match, "u");
    const logPath = isOwned
      ? serviceLogPath(worktree.stack_id, name)
      : serviceLogPath(worktree.stack_id, name);
    await waitForLogMatch({ logPath, pattern, signal });
    return;
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
    await waitForHttpReady({ url, signal });
    return;
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
    await waitForTcpReady({ target, signal });
    return;
  }

  // ready_when present but with only fields Plan 1 doesn't support (cmd,
  // capture, timeout in isolation). Treat as "no probe configured" rather
  // than failing — Plan 4 wires the missing surfaces.
}

/**
 * Build the HTTP URL for a ready probe.
 *
 * Plan 1 supports two shapes (per spec section 4 examples + dogfood-stack):
 *   - A relative path like `/health`: prefixed with `http://localhost:<port>`
 *     where <port> is the service's primary allocated port.
 *   - An absolute URL: used verbatim. (Plan 1's interpolation pipeline does
 *     NOT touch ready_when fields — they're consumed raw from the parsed
 *     config — so an absolute URL must already be a literal localhost URL.)
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
