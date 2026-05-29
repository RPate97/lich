/**
 * `lich dashboard [--no-browser]` — open `http://lich.localhost:<proxy-port>/`.
 * Auto-starts the daemon. Honors `LICH_NO_BROWSER=1`. Always opens (unlike
 * `lich up`'s fresh-spawn-only auto-open) — the user typed this for a reason.
 */

import { ensureDaemonRunning } from "../daemon/auto-start.js";
import { openInBrowser } from "../daemon/open-browser.js";
import { readDaemonProxyUrl } from "../daemon/pid-file.js";

export interface RunDashboardInput {
  noBrowser?: boolean;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export interface RunDashboardResult {
  exitCode: number;
}

export async function runDashboard(
  input: RunDashboardInput = {},
): Promise<RunDashboardResult> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const noBrowser =
    input.noBrowser === true ||
    process.env.LICH_NO_BROWSER === "1" ||
    process.env.LICH_NO_BROWSER === "true";

  // openBrowser: false — we handle it ourselves below so this command
  // always opens, not only on fresh daemon spawn.
  try {
    await ensureDaemonRunning({ openBrowser: false, out });
  } catch (e) {
    err.write(
      `lich dashboard: daemon failed to start: ${(e as Error).message}\n`,
    );
    return { exitCode: 1 };
  }

  // null means proxy bind failed (e.g. EADDRINUSE); daemon is still up
  // at its direct URL but no friendly proxy URL to advertise.
  let url: string | null;
  try {
    url = await readDaemonProxyUrl();
  } catch (e) {
    err.write(
      `lich dashboard: failed to read daemon proxy URL: ${(e as Error).message}\n`,
    );
    return { exitCode: 1 };
  }

  if (url === null) {
    err.write(
      "lich dashboard: the daemon is running but its reverse proxy is not " +
        "(bind failure?). Use `lich routing` to inspect the routing state.\n",
    );
    return { exitCode: 1 };
  }

  out.write(`${url}\n`);

  if (noBrowser) {
    return { exitCode: 0 };
  }

  try {
    openInBrowser(url);
  } catch (e) {
    err.write(
      `lich dashboard: could not open browser: ${(e as Error).message}\n` +
        `  URL is printed above; open it manually.\n`,
    );
    // Non-fatal — URL is printed; user can copy/paste.
    return { exitCode: 0 };
  }

  return { exitCode: 0 };
}
