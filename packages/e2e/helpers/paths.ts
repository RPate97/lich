// Centralized filesystem paths for the e2e suite. Tests import the resolved
// constants so moving a test file inside packages/e2e/ can't break path math.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root. */
export const REPO_ROOT = resolve(here, "../../..");

/** Absolute path to `<repo>/packages/lich`. */
export const LICH_PACKAGE = resolve(REPO_ROOT, "packages/lich");

/** Absolute path to the compiled `lich` CLI binary. */
export const LICH_BINARY = resolve(LICH_PACKAGE, "dist/lich");

/** Absolute path to the compiled `lich-daemon` binary. */
export const LICH_DAEMON_BINARY = resolve(LICH_PACKAGE, "dist/lich-daemon");

/** Absolute path to the e2e fixtures directory. */
export const FIXTURES_DIR = resolve(here, "../fixtures");

/** Absolute path to the dogfood-stack fixture. */
export const DOGFOOD_STACK = resolve(FIXTURES_DIR, "dogfood-stack");
