import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { honoBackendAdapter } from '../../adapters/backend/hono';
import type { Rule } from '../types';

const HONO_ENTRY = 'apps/api/src/index.ts';
const INTEGRATION_TESTS_DIR = 'tests/integration';

/**
 * Walk a directory recursively and return absolute paths of every `.ts` file
 * underneath it. Silently returns `[]` when the directory does not exist so
 * the rule can fall through to a clear "uncovered" failure rather than
 * throwing on a fresh scaffold.
 */
function collectTestFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (st.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

export const routeCoverageRule: Rule = {
  id: 'route-coverage',
  describe: 'every Hono route has an integration test',
  check: async ({ projectRoot }) => {
    const entryAbs = join(projectRoot, HONO_ENTRY);
    if (!existsSync(entryAbs)) {
      return { status: 'skip', message: 'no Hono app found' };
    }

    const manifest = await honoBackendAdapter.extractRoutes(projectRoot);
    if (manifest.routes.length === 0) {
      return { status: 'pass' };
    }

    const testFiles = collectTestFiles(join(projectRoot, INTEGRATION_TESTS_DIR));
    // Concatenate all integration test sources once; a simple substring search
    // on the joined haystack is faster than re-reading per route and is
    // sufficient because route paths are distinctive literals (e.g.
    // `/api/users`). False positives from unrelated comments are acceptable
    // here — the rule's role is to surface obviously-missing coverage.
    const haystack = testFiles
      .map((p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');

    const uncovered = manifest.routes
      .filter((r) => !haystack.includes(r.path))
      .map((r) => `${r.method} ${r.path}`);

    if (uncovered.length === 0) {
      return { status: 'pass' };
    }
    return {
      status: 'fail',
      message: `uncovered route(s): ${uncovered.join(', ')}`,
    };
  },
};
