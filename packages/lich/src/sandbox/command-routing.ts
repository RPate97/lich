import { isSandboxStack } from './marker.js';
import type { StackSnapshot } from '../state/snapshot.js';
import type { Worktree } from '../worktree/detect.js';
import type { ExecResult } from './backend.js';

export type RouteKind = 'down' | 'exec' | 'logs' | 'stacks';

export interface SandboxRuntimeLike {
  down(ctx: import('./runtime.js').RuntimeContext, opts?: { purge?: boolean }): Promise<void>;
  exec(ctx: import('./runtime.js').RuntimeContext, args: ReadonlyArray<string>, opts?: import('./backend.js').ExecOptions): Promise<ExecResult>;
}

export interface RouteContext {
  kind: RouteKind;
  snapshot: StackSnapshot | null | undefined;
  worktree: Worktree;
  lichYamlPath: string;
  argv?: unknown;
  runtime?: SandboxRuntimeLike;
}

export interface RouteResult {
  exitCode: number;
  message?: string;
}

// TODO(T3): when runtime is absent and marker is present, parse the config to get
// runtime.sandbox block and construct a real SandboxRuntime. Deferred until first
// branch (T3) actually needs it; skeleton always throws before reaching construction.
export async function maybeRouteToSandbox(ctx: RouteContext): Promise<RouteResult | null> {
  if (!isSandboxStack(ctx.snapshot)) return null;

  throw new Error(`sandbox routing for kind '${ctx.kind}' not yet implemented (Task T3-T6)`);
}
