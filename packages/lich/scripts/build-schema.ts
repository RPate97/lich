#!/usr/bin/env bun
/**
 * Emit `packages/lich/schema/v1.json` from the runtime Ajv schema in
 * `src/config/schema.ts`. `lich init` writes a `$schema` URL pointing at
 * the GitHub raw copy so yaml-language-server can validate lich.yaml in
 * editors. Runs as part of `bun run build`; round-trip is pinned by
 * `tests/unit/config/schema-roundtrip.test.ts`.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { schema } from "../src/config/schema.js";

const PUBLIC_SCHEMA_URL =
  "https://raw.githubusercontent.com/RPate97/lich/main/packages/lich/schema/v1.json";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = join(packageRoot, "schema/v1.json");

// Re-stamp `$id`: source uses `https://lich.sh/schema/v1.json` for
// documentation, but users fetch from the GitHub raw URL.
const emitted = {
  ...schema,
  $id: PUBLIC_SCHEMA_URL,
};

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(emitted, null, 2) + "\n", "utf8");

const sizeKb = Math.round((JSON.stringify(emitted).length / 1024) * 10) / 10;
console.log(`build-schema: wrote ${OUT_FILE} (${sizeKb} KB)`);
