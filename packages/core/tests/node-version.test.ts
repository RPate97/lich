import { describe, it, expect, vi } from 'vitest';
import {
  MIN_NODE_VERSION,
  checkNodeVersion,
  formatNodeVersionError,
  isNodeVersionAtLeast,
  parseNodeVersion,
  type NodeVersionCheckProcess,
} from '../src/node-version';

describe('LEV-114 — node-version', () => {
  describe('MIN_NODE_VERSION', () => {
    it('is set to Node 20 (the floor declared in every workspace package.json)', () => {
      // If you bump this, sweep every package.json#engines.node in the repo to
      // match — the constant is the single source of truth but the engines
      // fields are independently committed JSON.
      expect(MIN_NODE_VERSION).toBe('20.0.0');
    });
  });

  describe('parseNodeVersion', () => {
    it('parses a bare semver as produced by process.versions.node', () => {
      expect(parseNodeVersion('20.20.2')).toEqual({
        major: 20,
        minor: 20,
        patch: 2,
      });
    });

    it('tolerates a leading "v" (e.g. tooling output like `node -v`)', () => {
      expect(parseNodeVersion('v22.5.0')).toEqual({
        major: 22,
        minor: 5,
        patch: 0,
      });
    });

    it('strips pre-release / build metadata suffixes', () => {
      // `parseInt` stops at the first non-digit, so "0-nightly20230101" → 0.
      expect(parseNodeVersion('20.0.0-nightly20230101')).toEqual({
        major: 20,
        minor: 0,
        patch: 0,
      });
    });

    it('returns null for non-semver strings rather than throwing', () => {
      expect(parseNodeVersion('not-a-version')).toBeNull();
      expect(parseNodeVersion('20.20')).toBeNull(); // missing patch
      expect(parseNodeVersion('')).toBeNull();
    });
  });

  describe('isNodeVersionAtLeast', () => {
    it('accepts an equal version', () => {
      expect(isNodeVersionAtLeast('20.0.0', '20.0.0')).toBe(true);
    });

    it('accepts a newer major', () => {
      expect(isNodeVersionAtLeast('22.5.0', '20.0.0')).toBe(true);
    });

    it('accepts a newer minor at the same major', () => {
      expect(isNodeVersionAtLeast('20.20.2', '20.0.0')).toBe(true);
    });

    it('accepts a newer patch at the same major.minor', () => {
      expect(isNodeVersionAtLeast('20.0.5', '20.0.0')).toBe(true);
    });

    it('rejects the historical pain point — Node 18.18.0', () => {
      // This is the version on which subagents repeatedly hit
      // ERR_UNKNOWN_BUILTIN_MODULE; the entire ticket exists to surface a
      // clear error instead of letting them hit that.
      expect(isNodeVersionAtLeast('18.18.0', '20.0.0')).toBe(false);
    });

    it('rejects an older major even if minor/patch are large', () => {
      expect(isNodeVersionAtLeast('18.99.99', '20.0.0')).toBe(false);
    });

    it('rejects a malformed actual version (defensive — should never happen in practice)', () => {
      expect(isNodeVersionAtLeast('garbage', '20.0.0')).toBe(false);
    });
  });

  describe('formatNodeVersionError', () => {
    it('mentions both the required and the actual versions', () => {
      const msg = formatNodeVersionError('18.18.0');
      expect(msg).toContain('20.0.0');
      expect(msg).toContain('18.18.0');
      // Must be actionable, not just descriptive.
      expect(msg.toLowerCase()).toContain('nvm');
    });

    it('respects an explicit required-version override', () => {
      const msg = formatNodeVersionError('18.18.0', '22.0.0');
      expect(msg).toContain('22.0.0');
      expect(msg).not.toContain('20.0.0');
    });
  });

  describe('checkNodeVersion', () => {
    function makeFakeProcess(version: string) {
      const stderr: string[] = [];
      const exits: number[] = [];
      const fake: NodeVersionCheckProcess = {
        versions: { node: version },
        stderr: {
          write(s: string) {
            stderr.push(s);
            return true;
          },
        },
        // Throw rather than actually exiting so the test can assert that
        // production code halts on a bad version — `process.exit` is typed
        // `never` and we don't want to leak that into the test process.
        exit(code: number): never {
          exits.push(code);
          throw new Error(`__exit_${code}__`);
        },
      };
      return { fake, stderr, exits };
    }

    it('returns silently on a Node version at or above the minimum', () => {
      const { fake, stderr, exits } = makeFakeProcess('20.20.2');
      expect(() => checkNodeVersion(fake)).not.toThrow();
      expect(stderr).toEqual([]);
      expect(exits).toEqual([]);
    });

    it('returns silently on a future Node version (e.g. 22.x)', () => {
      const { fake, stderr, exits } = makeFakeProcess('22.5.0');
      expect(() => checkNodeVersion(fake)).not.toThrow();
      expect(stderr).toEqual([]);
      expect(exits).toEqual([]);
    });

    it('writes a clear error and exits 1 on Node 18.18.0', () => {
      const { fake, stderr, exits } = makeFakeProcess('18.18.0');
      expect(() => checkNodeVersion(fake)).toThrow('__exit_1__');
      expect(exits).toEqual([1]);
      expect(stderr.join('')).toMatch(/requires Node 20\.0\.0\+/);
      expect(stderr.join('')).toMatch(/18\.18\.0/);
    });

    it('defaults to the real `process` when no override is supplied', () => {
      // Smoke check — the test process is running on Node 20+ (otherwise
      // vitest wouldn't have started), so this must not throw or exit.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`real-exit-${code ?? 0}`);
      }) as never);
      try {
        expect(() => checkNodeVersion()).not.toThrow();
      } finally {
        exitSpy.mockRestore();
      }
    });
  });
});
