import { routeRequest, type ServerConfig } from './server';

export interface StartOptions {
  /** Absolute path to ~/.levelzero/registry.json. */
  registryPath: string;
  /** Directory holding the built SPA. Defaults to the package's dist/web. */
  webDir?: string;
  /** Port to bind. 0 = pick a free port. Default 0. */
  port?: number;
}

export interface DashboardHandle {
  /** Base URL the server is listening on, e.g. http://127.0.0.1:54123. */
  url: string;
  /** Stop the server and release the port. */
  stop(): Promise<void>;
}

/**
 * Start the dashboard HTTP/SSE server, bound to 127.0.0.1 only (local-machine
 * tool — no remote surface, see the design doc). Returns once it is listening.
 */
export async function startDashboardServer(opts: StartOptions): Promise<DashboardHandle> {
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const defaultWebDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

  const cfg: ServerConfig = {
    registryPath: opts.registryPath,
    webDir: opts.webDir ?? defaultWebDir,
  };

  // `Bun.serve` is the runtime target — the CLI runs under Bun. Typed loosely
  // here so the package typechecks without @types/bun in the server tsconfig.
  const Bun = (globalThis as unknown as { Bun: {
    serve(o: {
      port: number; hostname: string;
      fetch(req: Request): Promise<Response> | Response;
    }): { port: number; stop(): void };
  } }).Bun;

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    fetch: (req) => routeRequest(cfg, req),
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      server.stop();
    },
  };
}

export type { ServerConfig } from './server';
