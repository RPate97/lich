import type { Command } from '@levelzero/core';
import { redisCacheAdapter } from './adapter';

/**
 * `redis.ping` — sends PING to the running redis instance, expects PONG.
 *
 * Port resolution precedence:
 *   1. `--port <n>` flag
 *   2. `REDIS_PORT` env var
 *   3. `6379` fallback (the container-internal port — only useful if you've
 *      wired a host port mapping in `levelzero dev` or are running Redis on
 *      the host directly).
 *
 * In a production plugin you'd read the active stack's allocated port from
 * the registry (see `tools/cli/src/registry.ts` `StackEntry.ports[redis]`).
 * The example keeps the dependency surface narrow — a flag + env var is
 * enough to demonstrate the command-contribution pattern without coupling
 * to internal CLI modules.
 */
export const redisPingCommand: Command = {
  name: 'redis.ping',
  describe: 'Ping the Redis instance contributed by @levelzero/example-plugin-redis',
  async run({ flags, format }) {
    const host = pickString(flags.host) ?? process.env.REDIS_HOST ?? '127.0.0.1';
    const port = pickNumber(flags.port) ?? envNumber('REDIS_PORT') ?? 6379;

    const reply = await redisCacheAdapter.ping({ host, port });

    if (format === 'json') {
      return { ok: reply === 'PONG', host, port, reply };
    }
    // text-format: just the reply, like `redis-cli ping`.
    return reply;
  },
};

function pickString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickNumber(value: string | boolean | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
