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
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDaemon } from "../daemon/daemon.js";

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

/**
 * Resolve the dashboard UI's built `dist/` directory (LEV-460). Without
 * this, `runDaemon` invokes `startDashboardServer({ uiDir: undefined })`
 * and the dashboard server falls back to the LEV-415 placeholder HTML
 * ("UI components land in Task 14") instead of serving the real UI from
 * LEV-416. The UI build itself ALWAYS lives at
 * `<package-root>/src/daemon/dashboard/ui/dist/` (per `build:ui` in
 * package.json); we just need to locate `<package-root>` at runtime.
 *
 * Three strategies in order:
 *
 *  1. `LICH_UI_DIR` env override — escape hatch for tests and unusual
 *     deploys. Honored verbatim if set (no existsSync check) so a
 *     deliberately-missing path surfaces as a load error rather than
 *     silently falling through to the placeholder.
 *
 *  2. Compiled-binary mode: `process.execPath` is the daemon binary
 *     itself (e.g. `<repo>/packages/lich/dist/lich-daemon`). The UI dist
 *     is at `<repo>/packages/lich/src/daemon/dashboard/ui/dist`, which
 *     is `../src/daemon/dashboard/ui/dist` relative to `dist/`.
 *
 *  3. Source mode (`bun run dev`): `import.meta.dir` is the source
 *     `src/bin/` directory; UI dist is at
 *     `../daemon/dashboard/ui/dist` relative to it.
 *
 * If neither candidate exists on disk, leave `uiDir` undefined — the
 * placeholder render is then the informative "you didn't build the UI"
 * signal, which is the right behavior for that case.
 */
function resolveUiDir(): string | undefined {
  if (process.env.LICH_UI_DIR && process.env.LICH_UI_DIR.length > 0) {
    return process.env.LICH_UI_DIR;
  }

  const compiledCandidate = resolve(
    dirname(process.execPath),
    "..",
    "src",
    "daemon",
    "dashboard",
    "ui",
    "dist",
  );
  if (existsSync(join(compiledCandidate, "index.html"))) {
    return compiledCandidate;
  }

  const sourceCandidate = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "daemon",
    "dashboard",
    "ui",
    "dist",
  );
  if (existsSync(join(sourceCandidate, "index.html"))) {
    return sourceCandidate;
  }

  return undefined;
}

const uiDir = resolveUiDir();

const { exitCode } = await runDaemon({ lichHome, proxyPort, uiDir });
process.exit(exitCode);
