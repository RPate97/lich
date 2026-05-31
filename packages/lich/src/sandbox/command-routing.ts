import { SandboxError } from './errors.js';
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

export async function maybeRouteToSandbox(ctx: RouteContext): Promise<RouteResult | null> {
  if (!isSandboxStack(ctx.snapshot)) return null;

  throw new SandboxError(`sandbox routing for kind '${ctx.kind}' not yet implemented (Task T3-T6)`);
}
