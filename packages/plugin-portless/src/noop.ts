import type { PortlessAdapter, URLEntry } from './types';

/**
 * Fallback PortlessAdapter used when no real portless backend is installed.
 *
 * All mutating operations are no-ops, `available()` reports false, and `list()`
 * returns an empty array. Callers can safely treat this adapter as a drop-in
 * replacement when checking for portless availability before performing work.
 */
export const noopPortlessAdapter: PortlessAdapter = {
  name: 'noop',
  async available(): Promise<boolean> {
    return false;
  },
  async register(_input: { host: string; target: string }): Promise<void> {
    // intentionally empty
  },
  async unregister(_host: string): Promise<void> {
    // intentionally empty
  },
  async list(): Promise<URLEntry[]> {
    return [];
  },
};
