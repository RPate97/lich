#!/usr/bin/env bun
/**
 * Lich daemon entry point (LEV-406, Plan 5 Task 4).
 *
 * This is the binary that `lich up`'s auto-start logic (Task 5) spawns
 * with `detached: true` + `unref()` so the daemon outlives the parent
 * CLI invocation. The shim itself does almost nothing — it parses two
 * env vars (LICH_HOME for state isolation in tests, LICH_PROXY_PORT
 * for the reverse-proxy bind port) and delegates to `runDaemon` from
 * `src/daemon/daemon.ts`.
 *
 * The daemon's own signal handlers (SIGTERM/SIGINT, installed inside
 * `runDaemon`) drive the graceful shutdown path; this shim doesn't
 * install its own. Once `runDaemon` resolves we exit with its returned
 * code (0 for clean shutdown, non-zero if startup failed because
 * another daemon already owned the PID file).
 *
 * Built via the `build:daemon` script in `packages/lich/package.json` —
 * this lands as a separate binary alongside the main `lich` binary for
 * now. Task 30 (LEV-432) merges them into a single binary with a
 * `__main` branch on argv[0], but until then we keep them split so the
 * daemon's lifecycle is independently testable.
 */

import { runDaemon } from "../daemon/daemon.js";

const lichHome = process.env.LICH_HOME;
const proxyPortRaw = process.env.LICH_PROXY_PORT;
// Parse the env var only when present; an empty/unset value falls
// through to `runDaemon`'s default (3300). parseInt with NaN-guard so
// a bogus value (`LICH_PROXY_PORT=foo`) doesn't silently coerce to 0.
let proxyPort: number | undefined;
if (proxyPortRaw && proxyPortRaw.length > 0) {
  const parsed = parseInt(proxyPortRaw, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) {
    proxyPort = parsed;
  } else {
    process.stderr.write(
      `lich-daemon: invalid LICH_PROXY_PORT '${proxyPortRaw}'; using default\n`,
    );
  }
}

const { exitCode } = await runDaemon({ lichHome, proxyPort });
process.exit(exitCode);
