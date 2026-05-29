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

let tmp: string;
let homeDir: string;
let prevHome: string | undefined;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  // realpath resolves /var → /private/var on macOS so paths compare cleanly
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lich-env-cmd-test-")));
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
    // # is a trailing comment marker in the unquoted-parse path
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

describe("serializeDotenv round-trip via env/shell-out parseDotenv", () => {
  it("round-trips an env map containing every quoting branch", async () => {
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
    const file = join(tmp, ".env.roundtrip");
    writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const parsed = await loadEnvFromShellOut({
      entries: [`cat ${JSON.stringify(file)}`],
    });

    expect(parsed).toEqual(original);
  });
});

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
    expect(stderr.join("\n")).toContain('env_group "ghost"');
  });

  it("exits 1 when lich.yaml is missing", async () => {
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

describe("runEnvCmd output round-trips through parseDotenv", () => {
  it("emits parseable dotenv: round-trips through the env/shell-out dotenv parser", async () => {
    // load-bearing: if this fails `source <(lich env stack)` doesn't work
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

describe("runEnvCmd — active_profile from snapshot", () => {
  it("layers profile env over top-level env for the stack group", async () => {
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

  it("uses only top-level env when snapshot has no active_profile", async () => {
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
    writeYaml(`
version: "1"
`);
    await seedSnapshot(undefined);

    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).not.toMatch(/^LICH_PROFILE=/m);
  });

  it("falls back to top-level-only when active_profile in snapshot no longer exists in yaml", async () => {
    writeYaml(`
version: "1"
env:
  DATABASE_URL: top
profiles:
  dev: {}
`);
    await seedSnapshot("dev:env-override");

    const res = await run({ groupName: "stack" });
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).toMatch(/^DATABASE_URL=top$/m);
    expect(stdout.join("\n")).not.toMatch(/^LICH_PROFILE=/m);
  });
});
