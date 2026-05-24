import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveStackGroup } from "../../../src/groups/built-in-stack.js";
import { resolveTopLevelEnv } from "../../../src/env/resolve.js";
import type { Worktree } from "../../../src/worktree/detect.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  // realpathSync resolves /var → /private/var on macOS so paths compare cleanly.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lich-stack-group-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const worktree: Worktree = {
  name: "feature-x",
  id: "abc123def456",
  path: "/tmp/feature-x",
  stack_id: "feature-x-abc123de",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveStackGroup", () => {
  it("returns the same env that resolveTopLevelEnv produces for a top-level env literal", async () => {
    // Two parallel resolutions with identical inputs must produce identical
    // output — the adapter is a pure delegate.
    const input = {
      config: { version: "1" as const, env: { TOP: "value" } },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {}, // empty so host env doesn't differ run-to-run
      projectRoot: tmp,
    };

    const viaAdapter = await resolveStackGroup(input);
    const viaDirect = await resolveTopLevelEnv(input);

    expect(viaAdapter).toEqual(viaDirect);
    expect(viaAdapter.TOP).toBe("value");
  });

  it("includes auto-injected LICH_WORKTREE and LICH_STACK_ID", async () => {
    const env = await resolveStackGroup({
      config: { version: "1" },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
    });

    expect(env.LICH_WORKTREE).toBe("feature-x");
    expect(env.LICH_STACK_ID).toBe("feature-x-abc123de");
  });

  it("interpolates ${owned.X.port} against the allocated-ports context", async () => {
    const env = await resolveStackGroup({
      config: {
        version: "1",
        env: { DATABASE_URL: "postgres://localhost:${owned.db.port}/app" },
      },
      worktree,
      allocatedPorts: {
        compose: {},
        owned: { db: { port: 5847 } },
      },
      processEnv: {},
      projectRoot: tmp,
    });

    expect(env.DATABASE_URL).toBe("postgres://localhost:5847/app");
  });
});
