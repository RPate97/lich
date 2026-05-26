#!/usr/bin/env bun
/**
 * Lich daemon entry point (LEV-406, Plan 5 Task 4).
 *
 * This is the binary that `lich up`'s auto-start logic (Task 5) spawns
 * with `detached: true` + `unref()` so the daemon outlives the parent
 * CLI invocation. The shim itself does almost nothing — it parses two
 * env vars (LICH_HOME for state isolation in tests, LICH_PROXY_PORT
 * for the reverse-proxy bind port — see LEV-479 for the precedence
 * order vs. lich.yaml's `runtime.proxy_port`) and delegates to
 * `runDaemon` from `src/daemon/daemon.ts`.
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
 *
 * SPA assets ship embedded in the compiled binary (see
 * `scripts/embed-ui.ts` + `daemon/dashboard/embedded-ui.generated.ts`).
 * No sidecar `ui/dist/` directory is required at runtime. Setting
 * `LICH_UI_DIR=<path>` overrides the embedded bundle — useful for
 * iterating on the dashboard UI without rebuilding the daemon.
 */

import { runDaemon } from "../daemon/daemon.js";
import {
  getEmbeddedAsset,
  hasEmbeddedAssets,
} from "../daemon/dashboard/embedded-ui.generated.js";

const lichHome = process.env.LICH_HOME;
const proxyPortRaw = process.env.LICH_PROXY_PORT;
// Parse the env var only when present; an empty/unset value falls
// through to `runDaemon`'s default — which (post-LEV-479) is a stable
// worktree-derived port in 30000-50000, NOT the legacy hardcoded 3300.
// parseInt with NaN-guard so a bogus value (`LICH_PROXY_PORT=foo`)
// doesn't silently coerce to 0.
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

// LICH_UI_DIR is the dev/test override — when set, the dashboard server
// serves files from that directory instead of the embedded bundle. No
// existsSync check so a deliberately-missing path surfaces as a load
// error rather than silently falling back to the embedded SPA (the
// override should win loudly).
const uiDir =
  process.env.LICH_UI_DIR && process.env.LICH_UI_DIR.length > 0
    ? process.env.LICH_UI_DIR
    : undefined;

// Only forward the embedded source when it actually contains assets.
// During pre-build dev (or if `scripts/embed-ui.ts` ran against an
// empty ui/dist), `hasEmbeddedAssets()` is false and the dashboard
// falls back to the placeholder HTML — which is the right "you didn't
// build the UI" signal for that case.
const embeddedUi = hasEmbeddedAssets() ? { get: getEmbeddedAsset } : undefined;

const { exitCode } = await runDaemon({
  lichHome,
  proxyPort,
  uiDir,
  embeddedUi,
});
process.exit(exitCode);
