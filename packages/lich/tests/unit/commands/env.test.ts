/**
 * Unit tests for `lich env <group>` (LEV-331 / Plan 2 Task 11).
 *
 * The handler is exercised end-to-end in a fresh tmpdir with a real
 * `lich.yaml`. We don't mock `resolveEnvGroup` — using the real resolver
 * keeps these tests faithful to the actual production path while staying
 * hermetic (no subprocess, no docker, no real state.json).
 *
 * The load-bearing assertion is the round-trip test: any output we emit
 * must parse cleanly back through the in-tree dotenv parser used by
 * `env_from` shell-out. That parser is in `env/shell-out.ts` and is not
 * directly exported, so the round-trip is done via `loadEnvFromShellOut`
 * with a `cat <tmpfile>` shell command — same parser, exercised through
 * its public entry point.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runEnvCmd,
  serializeDotenv,
  formatValue,
} from "../../../src/commands/env.js";
import { loadEnvFromShellOut } from "../../../src/env/shell-out.js";
import { writeSnapshot } from "../../../src/state/snapshot.js";
import { ensureStackDir } from "../../../src/state/directory.js";
import { detectWorktree } from "../../../src/worktree/detect.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

let tmp: string;
let homeDir: string;
let prevHome: string | undefined;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  // realpathSync resolves /var → /private/var on macOS so paths compare cleanly.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lich-env-cmd-test-")));
  // Per-test LICH_HOME so the snapshot-seeding tests below don't leak into
  // the real ~/.lich and don't collide across tests. Pre-LEV-454 these tests
  // didn't need state.json at all; the snapshot-driven profile tests added
  // here do — readSnapshot resolves the per-stack path relative to LICH_HOME.
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), "lich-env-home-")));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  stdout = [];
  stderr = [];
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(tmp, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(tmp, "lich.yaml"), body, "utf8");
}

async function run(opts: {
  groupName?: string;
  cwd?: string;
  processEnv?: NodeJS.ProcessEnv;
} = {}) {
  return runEnvCmd({
    groupName: opts.groupName,
    cwd: opts.cwd ?? tmp,
    processEnv: opts.processEnv ?? {},
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
}

// ---------------------------------------------------------------------------
// serializeDotenv / formatValue — pure quoting/escaping behavior
// ---------------------------------------------------------------------------

describe("formatValue", () => {
  it("emits an empty value bare", () => {
    expect(formatValue("")).toBe("");
  });

  it("emits bare-alnum values without quotes", () => {
    expect(formatValue("plain")).toBe("plain");
    expect(formatValue("VALUE_42")).toBe("VALUE_42");
    expect(formatValue("path/to/file.txt")).toBe("path/to/file.txt");
    expect(formatValue("user@host:5432")).toBe("user@host:5432");
    expect(formatValue("v1.2.3-rc.1+build")).toBe("v1.2.3-rc.1+build");
  });

  it("quotes values containing whitespace", () => {
    expect(formatValue("has space")).toBe('"has space"');
    expect(formatValue("tab\there")).toBe('"tab\\there"');
  });

  it("quotes values containing #", () => {
    // # would be treated as a trailing comment marker by the unquoted-parse path.
    expect(formatValue("color#123")).toBe('"color#123"');
  });

  it("quotes values containing quote characters", () => {
    expect(formatValue("has'quote")).toBe(`"has'quote"`);
    expect(formatValue('has"dq')).toBe(`"has\\"dq"`);
  });

  it("escapes backslash, double-quote, and $ inside quoted values", () => {
    expect(formatValue("a\\b")).toBe(`"a\\\\b"`);
    expect(formatValue('a"b')).toBe(`"a\\"b"`);
    expect(formatValue("$FOO")).toBe(`"\\$FOO"`);
  });

  it("escapes \\n, \\r, \\t inside quoted values", () => {
    expect(formatValue("line1\nline2")).toBe(`"line1\\nline2"`);
    expect(formatValue("a\rb")).toBe(`"a\\rb"`);
    expect(formatValue("a\tb")).toBe(`"a\\tb"`);
  });
});

describe("serializeDotenv", () => {
  it("prints KEY=VALUE for each env var in sorted order", () => {
    const lines = serializeDotenv({
      ZED: "last",
      ALPHA: "first",
      MIKE: "middle",
    });
    expect(lines).toEqual(["ALPHA=first", "MIKE=middle", "ZED=last"]);
  });

  it("returns an empty list for an empty map", () => {
    expect(serializeDotenv({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip — emitted dotenv parses back to the original via the in-tree parser
// ---------------------------------------------------------------------------

describe("serializeDotenv round-trip via env/shell-out parseDotenv", () => {
  it("round-trips an env map containing every quoting branch", async () => {
    // Cover the union of bare, whitespace, #, quotes, backslash, $, and
    // newline/tab escapes. The `parseDotenv` in `env/shell-out.ts` is not
    // directly exported, so we exercise it through `loadEnvFromShellOut` —
    // same parser, public entry point.
    const original: Record<string, string> = {
      BARE_ALNUM: "plain42",
      PATH_LIKE: "/usr/local/bin",
      URL_LIKE: "postgresql://user:pass@host:5432/db",
      SEMVER: "v1.2.3-rc.1+build",
      WITH_SPACE: "value with spaces",
      WITH_HASH: "value#hash",
      WITH_DOLLAR: "$FOO",
      WITH_DQ: 'has"dq',
      WITH_SQ: "has'sq",
      WITH_BS: "has\\backslash",
      WITH_NEWLINE: "line1\nline2",
      WITH_TAB: "tab\there",
      WITH_CR: "a\rb",
      EMPTY: "",
    };

    const lines = serializeDotenv(original);
    // Write to a tmpfile and cat it through the shell-out loader, which
    // pipes the bytes through the same parseDotenv used at runtime.
    const file = join(tmp, ".env.roundtrip");
    writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const parsed = await loadEnvFromShellOut({
      entries: [`cat ${JSON.stringify(file)}`],
    });

    expect(parsed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// runEnvCmd — end-to-end behavior
// ---------------------------------------------------------------------------

describe("runEnvCmd — usage + arg handling", () => {
  it("exits 2 with usage when no group name given", async () => {
    const res = await run({});
    expect(res.exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("usage: lich env <group>");
  });

  it("exits 1 with helpful error when group does not exist", async () => {
    writeYaml(`
version: "1"
env_groups:
  tools:
    env:
      A: "1"
`);
    const res = await run({ groupName: "ghost" });
    expect(res.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    // The resolver emits a "not declared" message; include the requested name.
    expect(stderr.join("\n")).toContain('env_group "ghost"');
  });

  it("exits 1 when lich.yaml is missing", async () => {
    // No yaml written — parseConfig returns an io error.
    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("lich.yaml not found");
  });
});

describe("runEnvCmd — emission", () => {
  it("prints KEY=VALUE for each env var in sorted order", async () => {
    writeYaml(`
version: "1"
env_groups:
  tools:
    env:
      ZED: "z"
      ALPHA: "a"
      MIKE: "m"
`);
    const res = await run({ groupName: "tools" });
    expect(res.exitCode).toBe(0);
    expect(stderr).toEqual([]);

    // Tools is isolated (no extends:stack), so we know exactly which keys
    // appear. Default process_env=true overlays the host's env onto a
    // user-defined group when there's no extends — to keep the assertion
    // exact, we pass processEnv: {} via the helper.
    expect(stdout).toEqual(["ALPHA=a", "MIKE=m", "ZED=z"]);
  });

  it("quotes values containing whitespace", async () => {
    writeYaml(`
version: "1"
env_groups:
  tools:
    env:
      WITH_SPACE: "two words"
`);
    const res = await run({ groupName: "tools" });
    expect(res.exitCode).toBe(0);
    expect(stdout).toEqual([`WITH_SPACE="two words"`]);
  });

  it("quotes values containing #", async () => {
    writeYaml(`
version: "1"
env_groups:
  tools:
    env:
      COLOR: "red#alert"
`);
    const res = await run({ groupName: "tools" });
    expect(res.exitCode).toBe(0);
    expect(stdout).toEqual([`COLOR="red#alert"`]);
  });

  it("escapes backslash, double quote, and dollar inside quoted values", async () => {
    // YAML double-quoted strings need explicit escape sequences; the
    // resolver should pass the literal characters through to formatValue.
    writeYaml(`
version: "1"
env_groups:
  tools:
    env:
      BS: "a\\\\b"
      DQ: "a\\"b"
      DOLLAR: "$FOO"
`);
    const res = await run({ groupName: "tools" });
    expect(res.exitCode).toBe(0);
    expect(stdout.sort()).toEqual(
      [`BS="a\\\\b"`, `DOLLAR="\\$FOO"`, `DQ="a\\"b"`].sort(),
    );
  });

  it("escapes \\n inside quoted values", async () => {
    writeYaml(`
version: "1"
env_groups:
  tools:
    env:
      MULTILINE: "line1\\nline2"
`);
    const res = await run({ groupName: "tools" });
    expect(res.exitCode).toBe(0);
    expect(stdout).toEqual([`MULTILINE="line1\\nline2"`]);
  });

  it("includes auto-injected LICH_WORKTREE and LICH_STACK_ID for the stack group", async () => {
    writeYaml(`
version: "1"
env:
  TOP: "v"
`);
    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(0);

    const out = stdout.join("\n");
    expect(out).toMatch(/^LICH_WORKTREE=/m);
    expect(out).toMatch(/^LICH_STACK_ID=/m);
    expect(out).toMatch(/^TOP=v$/m);
  });
});

// ---------------------------------------------------------------------------
// End-to-end round-trip through `lich env` + the in-tree parser
// ---------------------------------------------------------------------------

describe("runEnvCmd output round-trips through parseDotenv", () => {
  it("emits parseable dotenv: round-trips through the env/shell-out dotenv parser", async () => {
    // The single most-load-bearing test for this command. If this fails,
    // `source <(lich env stack)` doesn't work.
    writeYaml(`
version: "1"
env_groups:
  mix:
    env:
      BARE: "plain42"
      WITH_SPACE: "two words"
      WITH_HASH: "value#hash"
      WITH_DOLLAR: "$FOO"
      URL: "postgresql://u:p@h:5432/db"
`);
    const res = await run({ groupName: "mix" });
    expect(res.exitCode).toBe(0);

    const file = join(tmp, ".env.lich");
    writeFileSync(file, stdout.join("\n") + "\n", "utf8");

    const parsed = await loadEnvFromShellOut({
      entries: [`cat ${JSON.stringify(file)}`],
    });

    expect(parsed).toEqual({
      BARE: "plain42",
      WITH_SPACE: "two words",
      WITH_HASH: "value#hash",
      WITH_DOLLAR: "$FOO",
      URL: "postgresql://u:p@h:5432/db",
    });
  });
});

// ---------------------------------------------------------------------------
// LEV-454: active_profile from snapshot is threaded through to env resolver
// ---------------------------------------------------------------------------
// `lich env stack` must surface profile-scoped env overrides when the stack
// was started under a profile. Pre-LEV-454, `lich env` ignored
// `snap.active_profile` and printed only top-level values, which broke the
// e2e tests verifying profile env wiring. Each test seeds a snapshot, runs
// `lich env stack`, and asserts on the emitted dotenv lines.

/**
 * Seed `<LICH_HOME>/stacks/<stack_id>/state.json` for the per-test tmpdir
 * with the given active_profile (or no profile when undefined). Mirrors
 * what `lich up` writes after a successful start.
 */
async function seedSnapshot(activeProfile?: string): Promise<void> {
  const wt = detectWorktree(tmp);
  await ensureStackDir(wt.stack_id);
  await writeSnapshot({
    stack_id: wt.stack_id,
    worktree_name: wt.name,
    worktree_path: wt.path,
    status: "up",
    started_at: new Date().toISOString(),
    services: [],
    ...(activeProfile ? { active_profile: activeProfile } : {}),
  });
}

describe("runEnvCmd — active_profile from snapshot (LEV-454)", () => {
  it("layers profile env over top-level env for the stack group", async () => {
    // Top-level DATABASE_URL=top is overridden by `dev:env-override`'s
    // DATABASE_URL=from-profile. The emitted dotenv line must reflect the
    // profile value, not the top-level one.
    writeYaml(`
version: "1"
env:
  DATABASE_URL: top
profiles:
  dev:env-override:
    env:
      DATABASE_URL: from-profile
`);
    await seedSnapshot("dev:env-override");

    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).toMatch(/^DATABASE_URL=from-profile$/m);
    expect(stdout.join("\n")).not.toMatch(/^DATABASE_URL=top$/m);
  });

  it("uses only top-level env when snapshot has no active_profile (regression guard)", async () => {
    // No profile in the snapshot → no profile layer applied. Confirms the
    // pre-LEV-454 behavior still works when a stack was started without
    // a profile.
    writeYaml(`
version: "1"
env:
  DATABASE_URL: top
profiles:
  dev:env-override:
    env:
      DATABASE_URL: from-profile
`);
    await seedSnapshot(undefined);

    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).toMatch(/^DATABASE_URL=top$/m);
    expect(stdout.join("\n")).not.toMatch(/^DATABASE_URL=from-profile$/m);
  });

  it("emits LICH_PROFILE in the stack output when a profile is active", async () => {
    // The auto-inject must reach the dotenv output too — not just spawned
    // children. Mirrors the LICH_WORKTREE / LICH_STACK_ID assertions above.
    writeYaml(`
version: "1"
profiles:
  dev:env-override: {}
`);
    await seedSnapshot("dev:env-override");

    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).toMatch(/^LICH_PROFILE=dev:env-override$/m);
  });

  it("does NOT emit LICH_PROFILE in the stack output when no profile is active", async () => {
    // Symmetric guard: the spec treats LICH_PROFILE as "present iff a profile
    // is active", not "always present, possibly empty". Without an active
    // profile the key must be absent from the output entirely.
    writeYaml(`
version: "1"
`);
    await seedSnapshot(undefined);

    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).not.toMatch(/^LICH_PROFILE=/m);
  });

  it("falls back to top-level-only when active_profile in snapshot no longer exists in yaml", async () => {
    // Drift scenario mirroring the exec.test.ts case: user removed the
    // profile from yaml after `lich up`. `lich env` should silently fall
    // back to top-level-only output rather than failing — it's a discovery
    // surface, not a diagnostic one.
    writeYaml(`
version: "1"
env:
  DATABASE_URL: top
profiles:
  dev: {}
`);
    await seedSnapshot("dev:env-override"); // recorded profile no longer declared

    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).toMatch(/^DATABASE_URL=top$/m);
    // And LICH_PROFILE is absent — drift means we have no profile to inject.
    expect(stdout.join("\n")).not.toMatch(/^LICH_PROFILE=/m);
  });
});
