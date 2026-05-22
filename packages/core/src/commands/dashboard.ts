import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { Command } from './types';

/** Open `url` in the default browser, best-effort — never throws. */
function openBrowser(url: string): void {
  const cmd =
    platform() === 'darwin' ? 'open'
    : platform() === 'win32' ? 'start'
    : 'xdg-open';
  try {
    const child = spawn(cmd, [url], {
      stdio: 'ignore',
      detached: true,
      shell: platform() === 'win32',
    });
    child.unref();
  } catch {
    /* best-effort — the URL is printed regardless */
  }
}

// Local type declarations for the dashboard server so core's typecheck does
// not depend on `@levelzero/dashboard`'s built dist/ artifact existing.
interface DashboardHandle {
  url: string;
  stop(): Promise<void>;
}
type StartDashboardServer = (opts: {
  registryPath: string;
  port?: number;
}) => Promise<DashboardHandle>;

/**
 * `lich dashboard` — start the local monitoring dashboard server and open it
 * in the browser. Runs in the foreground until Ctrl-C.
 *
 * The dashboard server lives in `@levelzero/dashboard` and is lazy-imported so
 * `@levelzero/core` carries no load-time dependency on it.
 */
export function makeDashboardCommand(getRegistryPath: () => string): Command {
  return {
    name: 'dashboard',
    describe: 'Start the lich monitoring dashboard (live view of all stacks)',
    async run(ctx) {
      // `@levelzero/dashboard` is built lazily (its dist/ is produced by the
      // dashboard package's own build); type the dynamic import locally so
      // core's typecheck doesn't depend on that build artifact existing.
      const specifier = '@levelzero/dashboard';
      const { startDashboardServer } = (await import(specifier)) as {
        startDashboardServer: StartDashboardServer;
      };

      const handle = await startDashboardServer({
        registryPath: getRegistryPath(),
        port: 0,
      });

      // ProgressReporter has no plain-text `log` method (it only exposes
      // `step`, `group`, and `shutdown`). Write the URL directly to stderr
      // so it appears regardless of the reporter mode.
      process.stderr.write(`dashboard running at ${handle.url}\n`);
      openBrowser(handle.url);

      // Block until interrupted. The signal handler stops the server so the
      // port is released and any open SSE tailers are torn down.
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          void handle.stop().then(resolve);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });

      if (ctx.format === 'json') return { url: handle.url, stopped: true };
      return `dashboard stopped\n`;
    },
  };
}
