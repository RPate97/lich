/**
 * E2e helper for hitting the lich daemon's dashboard JSON API
 * (Plan 5 Task 24, LEV-426).
 *
 * Reads the daemon's advertised URL from `<LICH_HOME>/daemon.url` (the
 * file the daemon writes after `Bun.serve` binds — see
 * `packages/lich/src/daemon/pid-file.ts`'s `writeDaemonUrl`), fetches a
 * path off it, and returns parsed JSON. Reused across the Plan 5 dashboard
 * e2e suite (`dashboard-stack-list`, `dashboard-stack-detail`,
 * `dashboard-failed-service`, `dashboard-stop-action`).
 *
 * Why a helper rather than inline `fetch`? Two reasons:
 *
 *   1. The dashboard URL is dynamic — `Bun.serve({ port: 0 })` picks an
 *      ephemeral port, so every test must discover the URL at runtime.
 *      Centralizing the read keeps tests focused on their assertions
 *      instead of the discovery dance.
 *   2. Two kinds of failure get distinct messages: missing `daemon.url`
 *      (daemon never started, or LICH_HOME is wrong) vs HTTP non-2xx
 *      (daemon up but route mis-handled). Both regressed in early Plan 5
 *      development; distinct errors mean a regression is one line in the
 *      output instead of a debugging session.
 *
 * The helper assumes `waitForDaemonRunning(lichHome)` has already
 * resolved — i.e. the URL file is guaranteed to be present and stable.
 * If callers skip that step they'll get the "No daemon.url" error and
 * know exactly what they forgot.
 */

import { readDaemonUrl } from "./daemon.js";

/**
 * Fetch the given JSON path off the daemon's dashboard server and parse
 * the body as JSON. The path is resolved against the daemon URL via the
 * standard `URL` constructor — so both leading-slash (`"/api/stacks"`)
 * and protocol-relative paths work as a caller would expect.
 *
 * Throws on:
 *   - Missing `daemon.url` (no daemon ever started, or wrong LICH_HOME).
 *   - HTTP non-2xx response (the route handler returned an error).
 *
 * Returns the parsed JSON body cast to `T`. The cast is unverified — tests
 * are responsible for asserting the shape they expect, not just trusting
 * the type parameter.
 */
export async function fetchDashboardJson<T>(
  lichHome: string,
  path: string,
): Promise<T> {
  const url = readDaemonUrl(lichHome);
  if (!url) {
    throw new Error(
      `No daemon.url in ${lichHome} — did you waitForDaemonRunning first?`,
    );
  }
  const res = await fetch(new URL(path, url).toString());
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${path}`);
  }
  return (await res.json()) as T;
}
