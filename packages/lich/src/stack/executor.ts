import type { RunUpInput, RunUpResult } from "../commands/up.js";
import type { RunDownInput, RunDownResult } from "../commands/down.js";
import type { RunExecInput, RunExecResult } from "../commands/exec.js";
import type { RunLogsInput, RunLogsResult } from "../commands/logs.js";
import type { StackSnapshot } from "../state/snapshot.js";
import type { Worktree } from "../worktree/detect.js";
import type { ExecutorRef } from "./types.js";
import { LocalStackExecutor } from "./executors/local.js";
import { SandboxStackExecutor } from "./executors/sandbox-tart.js";
import { SandboxRuntime } from "../sandbox/runtime.js";
import { parseConfig } from "../config/parse.js";

export interface StackExecutor {
  up(input: RunUpInput): Promise<RunUpResult>;
  down(input: RunDownInput): Promise<RunDownResult>;
  exec(input: RunExecInput): Promise<RunExecResult>;
  logs(input: RunLogsInput): RunLogsResult;
}

export interface ExecutorDeps {
  worktree: Worktree;
  lichYamlPath: string;
}

function deriveRef(snap: StackSnapshot): ExecutorRef {
  if (snap.executor) return snap.executor;
  if (snap.sandbox === true && typeof snap.sandbox_vm === "string") {
    return { kind: "sandbox-tart", vm_name: snap.sandbox_vm };
  }
  return { kind: "local" };
}

export async function pickExecutor(snap: StackSnapshot, deps: ExecutorDeps): Promise<StackExecutor> {
  const ref = deriveRef(snap);
  if (ref.kind === "local") return new LocalStackExecutor();
  if (ref.kind === "sandbox-tart") {
    // Parse the lich.yaml so the runtime gets the real sandbox config —
    // critically including bake_inputs, which content-addresses the
    // golden. A placeholder empty array makes every worktree hash to
    // the same key and breaks fork divergence.
    const parsed = await parseConfig(deps.lichYamlPath);
    if (!parsed.ok) {
      throw new Error(
        `sandbox executor selected but lich.yaml at ${deps.lichYamlPath} failed to parse`,
      );
    }
    const sandboxConfig = parsed.config.runtime?.sandbox;
    if (!sandboxConfig) {
      throw new Error(
        `sandbox executor selected but lich.yaml at ${deps.lichYamlPath} has no runtime.sandbox block`,
      );
    }
    const runtime = new SandboxRuntime(sandboxConfig);
    return new SandboxStackExecutor(runtime, {
      worktreeId: deps.worktree.id,
      worktreePath: deps.worktree.path,
      lichYamlPath: deps.lichYamlPath,
      profileName: snap.active_profile ?? "default",
    }, { worktree: deps.worktree });
  }
  throw new Error(`unknown executor kind: ${(ref as { kind: string }).kind}`);
}
