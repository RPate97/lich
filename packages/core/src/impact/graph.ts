import { Project } from 'ts-morph';
import { isAbsolute, resolve } from 'node:path';

export interface ImpactOptions {
  /** Project root that contains tsconfig.json. */
  projectRoot: string;
  /** Whether to walk transitively (default true). */
  transitive?: boolean;
}

/**
 * Returns the set of TS files that import `target` (absolute path).
 * Result paths are absolute. Excludes the target itself.
 */
export async function reverseDeps(target: string, opts: ImpactOptions): Promise<string[]> {
  const targetAbs = isAbsolute(target) ? target : resolve(opts.projectRoot, target);
  const project = new Project({
    tsConfigFilePath: resolve(opts.projectRoot, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: false,
  });
  const transitive = opts.transitive ?? true;
  const visited = new Set<string>();
  const stack: string[] = [targetAbs];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const referencingFiles = project.getSourceFile(current)?.getReferencingSourceFiles() ?? [];
    for (const sf of referencingFiles) {
      const p = sf.getFilePath();
      if (p === targetAbs) continue;
      if (visited.has(p)) continue;
      visited.add(p);
      if (transitive) stack.push(p);
    }
  }
  return [...visited].sort();
}
