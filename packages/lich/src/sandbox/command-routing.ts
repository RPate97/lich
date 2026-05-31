import { SandboxError } from './errors.js';
import { isSandboxStack, sandboxCtxFromSnapshot } from './marker.js';
import { SandboxRuntime } from './runtime.js';
import type { StackSnapshot } from '../state/snapshot.js';
import type { Worktree } from '../worktree/detect.js';
import type { ExecResult } from './backend.js';
import type { SandboxRuntime as SandboxRuntimeConfig } from '../config/types.js';

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
  sandboxConfig?: SandboxRuntimeConfig;
}

export interface RouteResult {
  exitCode: number;
  message?: string;
}

export async function maybeRouteToSandbox(ctx: RouteContext): Promise<RouteResult | null> {
  if (!isSandboxStack(ctx.snapshot)) return null;

  const snap = ctx.snapshot!;
  const rtCtx = sandboxCtxFromSnapshot(ctx.worktree, snap, ctx.lichYamlPath);
  const runtime: SandboxRuntimeLike = ctx.runtime ?? new SandboxRuntime(ctx.sandboxConfig!);

  if (ctx.kind === 'down') {
    const purge = (ctx.argv as { purge?: boolean } | undefined)?.purge ?? false;
    await runtime.down(rtCtx, { purge });
    return { exitCode: 0, message: purge ? 'sandbox VM destroyed' : 'sandbox VM stopped' };
  }

  throw new SandboxError(`sandbox routing for kind '${ctx.kind}' not yet implemented (Task T4-T6)`);
}
