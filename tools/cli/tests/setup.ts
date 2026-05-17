// Vitest global setup. Node 18.x ships the Web Crypto API under `node:crypto`
// but doesn't expose it as a global by default. Better Auth's random/ID helpers
// reference `crypto.getRandomValues` / `crypto.randomUUID` as globals, so we
// install it here before any module under test loads.
import { webcrypto } from 'node:crypto';

if (typeof (globalThis as any).crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}
