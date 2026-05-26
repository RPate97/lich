// paths.ts — single source of truth for filesystem paths the e2e suite
// needs. Centralizing the math here means individual test files don't
// have to know how deep they are in the tree (the bug that broke every
// test when packages/e2e moved was exactly this — each test computed
// `resolve(__dirname, "../..")` and got it wrong by one level).
//
// helpers/paths.ts lives at `<repo>/packages/e2e/helpers/paths.ts`, so
// the repo root is exactly three levels up. Tests import the resolved
// constants — they never compute paths themselves, so moving a test
// file around inside packages/e2e/ can't break the path math.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root (the directory that owns `package.json`). */
export const REPO_ROOT = resolve(here, "../../..");

/** Absolute path to the lich package directory (`<repo>/packages/lich`). */
export const LICH_PACKAGE = resolve(REPO_ROOT, "packages/lich");

/**
 * Absolute path to the compiled `lich` CLI binary. Built by
 * `cd packages/lich && bun run build` — tests spawn this directly.
 */
export const LICH_BINARY = resolve(LICH_PACKAGE, "dist/lich");

/**
 * Absolute path to the compiled `lich-daemon` binary. Spawned via the
 * CLI's auto-start path, but tests sometimes spawn it directly to
 * exercise the daemon lifecycle.
 */
export const LICH_DAEMON_BINARY = resolve(LICH_PACKAGE, "dist/lich-daemon");

/**
 * Absolute path to the e2e fixtures directory. Stack fixtures live as
 * subdirectories (`packages/e2e/fixtures/<name>/`) and are copied to a
 * tmpdir per-run via `helpers/tmpdir.ts`'s `copyFixtureToTmpdir`.
 */
export const FIXTURES_DIR = resolve(here, "../fixtures");

/**
 * Absolute path to the dogfood-stack fixture — the load-bearing
 * end-to-end stack the e2e suite uses for the bulk of its scenarios.
 * Also referenced by some packages/lich unit tests that parse the yaml
 * as test data.
 */
export const DOGFOOD_STACK = resolve(FIXTURES_DIR, "dogfood-stack");
