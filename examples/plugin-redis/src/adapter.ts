import { Socket } from 'node:net';

/**
 * Shape of the minimal Redis cache adapter this plugin contributes.
 *
 * In a real plugin you'd model the full slot interface (`get`, `set`, `del`,
 * etc.). For this worked example we only expose `ping()` — enough to drive
 * the `redis.ping` command and demonstrate the adapter wiring end to end.
 *
 * The `slot: 'portless'` field is what `addAdapter` keys off — see
 * [`adapters/registry.ts`](../../../tools/cli/src/adapters/registry.ts)
 * `detectSlot()`. The portless slot is the only one that accepts
 * arbitrary shapes via the explicit-annotation escape hatch, so it's the
 * pragmatic choice for a plugin that wants to add a brand-new boundary
 * (here, a cache client) without forking the core slot list.
 *
 * `name` is required by the portless interface; it's the human-readable
 * label that shows up in `levelzero adapter list`.
 */
export interface RedisCacheAdapter {
  slot: 'portless';
  name: string;
  /** Send `PING` to the redis instance at `host:port`; resolves to `'PONG'`. */
  ping(input: { host: string; port: number }): Promise<string>;
}

/**
 * Tiny hand-rolled Redis client: opens a TCP socket, sends one inline
 * `PING\r\n`, reads the `+PONG\r\n` reply, closes. Deliberately avoids
 * pulling in a real `redis` / `ioredis` dependency so the example stays
 * self-contained and zero-deps.
 *
 * The 2-second timeout matches the compose healthcheck — if redis isn't
 * answering inside that window something's wrong with the stack, not the
 * client.
 */
export const redisCacheAdapter: RedisCacheAdapter = {
  slot: 'portless',
  name: 'redis-cache',

  ping({ host, port }) {
    return new Promise<string>((resolve, reject) => {
      const socket = new Socket();
      let buf = '';
      const done = (err: Error | null, value?: string) => {
        socket.destroy();
        if (err) reject(err);
        else resolve(value ?? '');
      };

      socket.setTimeout(2000);
      socket.once('timeout', () => done(new Error(`redis ping timed out after 2s (${host}:${port})`)));
      socket.once('error', (err) => done(err));
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        // RESP simple-string reply: `+PONG\r\n`.
        const m = /^\+([^\r\n]+)\r\n/.exec(buf);
        if (m) done(null, m[1]);
      });
      socket.connect(port, host, () => {
        socket.write('PING\r\n');
      });
    });
  },
};
