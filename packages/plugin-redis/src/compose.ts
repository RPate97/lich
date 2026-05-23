import type { ComposeServiceDef } from '@lich/core';

/**
 * Compose service definition for Redis.
 *
 * Highlights for plugin authors:
 *
 *  - **Image is pinned to a minor + variant** (`redis:7-alpine`) so behaviour
 *    is reproducible across machines without dragging in a full Debian base.
 *  - **Port string uses the `${PORT_redis}` placeholder.** The compose emitter
 *    substitutes a stack-allocated host port at render time, so multiple
 *    Lich stacks can run side-by-side without colliding on 6379.
 *    Container side stays fixed at `6379` (the image's listening port).
 *  - **Healthcheck is required for any service another service may wait on.**
 *    Without it, a downstream `depends_on: { condition: service_healthy }`
 *    consumer can never reach a clean `Up (healthy)` state.
 */
export const redisComposeService: ComposeServiceDef = {
  image: 'redis:7-alpine',
  ports: ['${PORT_redis}:6379'],
  healthcheck: {
    test: ['CMD', 'redis-cli', 'ping'],
    interval: '5s',
    timeout: '3s',
    retries: 5,
    start_period: '2s',
  },
};
