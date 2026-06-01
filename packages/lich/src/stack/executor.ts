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

export function pickExecutor(snap: StackSnapshot, deps: ExecutorDeps): StackExecutor {
  const ref = deriveRef(snap);
  if (ref.kind === "local") return new LocalStackExecutor();
  if (ref.kind === "sandbox-tart") {
    const runtime = new SandboxRuntime({ backend: "tart" });
    return new SandboxStackExecutor(runtime, {
      worktreeId: deps.worktree.id,
      worktreePath: deps.worktree.path,
      lichYamlPath: deps.lichYamlPath,
      profileName: snap.active_profile ?? "default",
    });
  }
  throw new Error(`unknown executor kind: ${(ref as { kind: string }).kind}`);
}
