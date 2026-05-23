import type { Service } from './types';

/**
 * The default service list `dev`/`stop`/`reset` inject when the caller doesn't
 * provide one. Now empty — every previously built-in service has been moved
 * into a plugin:
 *
 *  - postgres → `@lich/plugin-postgres` (LEV-148)
 *  - web      → `@lich/plugin-next` (LEV-154)
 *  - api      → `@lich/plugin-hono` (LEV-187)
 *
 * Consumers pick up these services via `getPluginOwnedServices()` /
 * `getPluginCompose()` rather than `getBuiltinServices()`. The function is
 * kept (returning `[]`) so existing call sites that compose
 * `[...getBuiltinServices(), ...pluginServices]` keep working without
 * conditional branches; Plan 17 may inline the empty array directly.
 */
export function getBuiltinServices(): Service[] {
  return [];
}
