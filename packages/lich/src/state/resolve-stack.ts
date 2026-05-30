import { detectWorktree, type Worktree } from "../worktree/detect.js";
import { listStacks } from "./directory.js";
import { readSnapshot, type StackSnapshot } from "./snapshot.js";

export interface ResolveStackOptions {
  /** Value of `--worktree`, when present. */
  worktreeArg?: string;
  cwd: string;
}

export interface ResolvedStack {
  stackId: string;
  /**
   * Snapshot loaded during resolution when `--worktree` was supplied; null
   * otherwise. Callers that fell through to cwd detection re-read as needed.
   */
  snapshot: StackSnapshot | null;
  /** Worktree derived from cwd; only set when no `--worktree` was given. */
  worktree?: Worktree;
}

/**
 * Stack-targeting precedence: explicit `--worktree` against the on-disk
 * catalog first, then cwd-derived worktree as the default. The cwd path
 * preserves today's behavior so commands keep working without the flag.
 *
 * Throws on unknown / ambiguous `--worktree` values with a message naming
 * the candidates and pointing at `lich stacks`.
 */
export async function resolveStackId(
  opts: ResolveStackOptions,
): Promise<ResolvedStack> {
  if (opts.worktreeArg && opts.worktreeArg.length > 0) {
    return resolveFromArg(opts.worktreeArg);
  }
  const worktree = detectWorktree(opts.cwd);
  return { stackId: worktree.stack_id, snapshot: null, worktree };
}

async function resolveFromArg(arg: string): Promise<ResolvedStack> {
  const ids = await listStacks();
  if (ids.length === 0) {
    throw new Error(
      `no stack found with ID/name '${arg}'; try \`lich stacks\``,
    );
  }

  const catalog: Array<{ stackId: string; snapshot: StackSnapshot | null; worktreeName: string | null }> = [];
  for (const id of ids) {
    const snap = await readSnapshot(id).catch(() => null);
    catalog.push({
      stackId: id,
      snapshot: snap,
      worktreeName: snap?.worktree_name ?? null,
    });
  }

  const idMatch = catalog.find((entry) => entry.stackId === arg);
  if (idMatch) {
    return { stackId: idMatch.stackId, snapshot: idMatch.snapshot };
  }

  const nameMatches = catalog.filter((entry) => entry.worktreeName === arg);
  if (nameMatches.length === 1) {
    const m = nameMatches[0]!;
    return { stackId: m.stackId, snapshot: m.snapshot };
  }
  if (nameMatches.length > 1) {
    const lines = nameMatches.map((m) => `  ${m.stackId}`);
    throw new Error(
      `worktree name '${arg}' matches ${nameMatches.length} stacks; pass the stack ID instead:\n${lines.join("\n")}`,
    );
  }

  throw new Error(
    `no stack found with ID/name '${arg}'; try \`lich stacks\``,
  );
}
