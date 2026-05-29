import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchUserCommand } from "../../../src/commands/dispatch.js";
import type { LichConfig } from "../../../src/config/types.js";
import type { Worktree } from "../../../src/worktree/detect.js";
import type { AllocatedPorts } from "../../../src/state/snapshot.js";

let tmp: string;

beforeEach(() => {
  // realpath resolves /var → /private/var on macOS so the `pwd` test's
  // string comparison doesn't trip on the symlink.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lich-dispatch-test-")));
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

const noPorts: AllocatedPorts = { compose: {}, owned: {} };

function baseInput(
  overrides: Partial<Parameters<typeof dispatchUserCommand>[0]> & {
    name: string;
  },
): Parameters<typeof dispatchUserCommand>[0] {
  return {
    name: overrides.name,
    extraArgv: overrides.extraArgv ?? [],
    config: overrides.config ?? { version: "1" },
    worktree: overrides.worktree ?? worktree,
    allocatedPorts: overrides.allocatedPorts ?? noPorts,
    projectRoot: overrides.projectRoot ?? tmp,
    envGroupOverride: overrides.envGroupOverride,
    signal: overrides.signal,
    stdio: overrides.stdio,
    stderr: overrides.stderr,
  };
}

describe("dispatchUserCommand — unknown command", () => {
  it("returns 127 with helpful stderr for unknown command name", async () => {
    const errLines: string[] = [];
    const result = await dispatchUserCommand(
      baseInput({
        name: "ghost",
        extraArgv: [],
        config: { version: "1" },
        worktree,
        allocatedPorts: noPorts,
        projectRoot: tmp,
        stderr: (s) => errLines.push(s),
      }),
    );
    expect(result.exitCode).toBe(127);
    expect(errLines.length).toBeGreaterThan(0);
    expect(errLines.join("\n")).toContain("unknown command 'ghost'");
    expect(errLines.join("\n")).toContain("lich --help");
  });

  it("returns 127 when config.commands is absent entirely", async () => {
    const errLines: string[] = [];
    const result = await dispatchUserCommand(
      baseInput({
        name: "anything",
        extraArgv: [],
        config: { version: "1" },
        worktree,
        allocatedPorts: noPorts,
        projectRoot: tmp,
        stderr: (s) => errLines.push(s),
      }),
    );
    expect(result.exitCode).toBe(127);
    expect(errLines.join("\n")).toContain("unknown command 'anything'");
  });
});

describe("dispatchUserCommand — env_group resolution", () => {
  it("runs the command with the stack group env by default", async () => {
    const marker = join(tmp, "stdout.txt");
    const config: LichConfig = {
      version: "1",
      env: { MY_VAR: "from-top-level" },
      commands: {
        "show-env": {
          cmd: `printenv MY_VAR > ${JSON.stringify(marker)}`,
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({
        name: "show-env",
        config,
      }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("from-top-level");
  });

  it("--env-group override changes which group is loaded", async () => {
    const markerA = join(tmp, "a.txt");
    const markerB = join(tmp, "b.txt");
    const config: LichConfig = {
      version: "1",
      env_groups: {
        groupA: { env: { MY_VAR: "from-A", OUT: markerA } },
        groupB: { env: { MY_VAR: "from-B", OUT: markerB } },
      },
      commands: {
        "show-env": {
          cmd: `printenv MY_VAR > "$OUT"`,
          env_group: "groupA",
        },
      },
    };

    const rA = await dispatchUserCommand(
      baseInput({ name: "show-env", config }),
    );
    expect(rA.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(markerA, "utf8").trim()).toBe("from-A");

    const rB = await dispatchUserCommand(
      baseInput({
        name: "show-env",
        config,
        envGroupOverride: "groupB",
      }),
    );
    expect(rB.exitCode).toBe(0);
    expect(readFileSync(markerB, "utf8").trim()).toBe("from-B");
  });

  it("per-command env overrides win over group env", async () => {
    const marker = join(tmp, "winner.txt");
    const config: LichConfig = {
      version: "1",
      env_groups: {
        base: { env: { SHARED: "from-group", OUT: marker } },
      },
      commands: {
        "show-env": {
          cmd: `printenv SHARED > "$OUT"`,
          env_group: "base",
          env: { SHARED: "from-per-command" },
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "show-env", config }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("from-per-command");
  });

  it("falls back to the built-in stack group when neither override nor per-command env_group is set", async () => {
    const marker = join(tmp, "stack.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        "show-stack-id": {
          cmd: `printenv LICH_STACK_ID > "$OUT"`,
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "show-stack-id", config }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe(worktree.stack_id);
  });
});

describe("dispatchUserCommand — argv forwarding", () => {
  it("extra argv is forwarded to the underlying cmd via \"$@\"", async () => {
    const marker = join(tmp, "argv.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        echo: {
          cmd: `echo "$@" > "$OUT"`,
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({
        name: "echo",
        config,
        extraArgv: ["--filter", "foo", "bar"],
      }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("--filter foo bar");
  });

  it("empty extra argv leaves $@ empty", async () => {
    const marker = join(tmp, "empty.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        echo: { cmd: `echo "got:[$@]" > "$OUT"` },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "echo", config, extraArgv: [] }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("got:[]");
  });

  it("preserves flag-like extras that would otherwise be parsed by sh", async () => {
    // dispatcher's `--` separator ensures sh doesn't re-interpret --filter
    const marker = join(tmp, "flag.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: { echo: { cmd: `echo "$1" "$2" > "$OUT"` } },
    };
    const result = await dispatchUserCommand(
      baseInput({
        name: "echo",
        config,
        extraArgv: ["--filter", "smoke"],
      }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("--filter smoke");
  });
});

describe("dispatchUserCommand — cwd", () => {
  it("cwd is resolved relative to projectRoot", async () => {
    const subdir = join(tmp, "apps", "api");
    mkdirSync(subdir, { recursive: true });
    const marker = join(tmp, "where.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        wherefore: {
          cmd: `pwd > "$OUT"`,
          cwd: "apps/api",
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "wherefore", config }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe(subdir);
  });

  it("defaults cwd to projectRoot when no cwd is set", async () => {
    const marker = join(tmp, "default-cwd.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: { wherefore: { cmd: `pwd > "$OUT"` } },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "wherefore", config, projectRoot: tmp }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe(tmp);
  });
});

describe("dispatchUserCommand — exit codes", () => {
  it("propagates the child's non-zero exit code", async () => {
    const config: LichConfig = {
      version: "1",
      commands: { fail: { cmd: "exit 7" } },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "fail", config }),
    );
    expect(result.exitCode).toBe(7);
  });

  it("propagates zero exit code from a successful command", async () => {
    const config: LichConfig = {
      version: "1",
      commands: { ok: { cmd: "true" } },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "ok", config }),
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("dispatchUserCommand — abort signal", () => {
  it("abort signal kills the child and returns 130", async () => {
    const config: LichConfig = {
      version: "1",
      commands: { sleep: { cmd: "sleep 30" } },
    };
    const controller = new AbortController();
    const promise = dispatchUserCommand(
      baseInput({ name: "sleep", config, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.exitCode).toBe(130);
  });

  it("abort signal already-fired before dispatch still returns 130", async () => {
    const config: LichConfig = {
      version: "1",
      commands: { sleep: { cmd: "sleep 30" } },
    };
    const controller = new AbortController();
    controller.abort();
    const result = await dispatchUserCommand(
      baseInput({ name: "sleep", config, signal: controller.signal }),
    );
    expect(result.exitCode).toBe(130);
  });
});

describe("dispatchUserCommand — group resolution errors", () => {
  it("propagates GroupResolveError when the referenced env_group is missing", async () => {
    const config: LichConfig = {
      version: "1",
      commands: {
        broken: {
          cmd: "true",
          env_group: "ghost-group",
        },
      },
    };
    await expect(
      dispatchUserCommand(baseInput({ name: "broken", config })),
    ).rejects.toThrow(/ghost-group/);
  });

  it("propagates GroupResolveError when --env-group= override targets a missing group", async () => {
    const config: LichConfig = {
      version: "1",
      env_groups: { real: { env: { X: "1" } } },
      commands: { broken: { cmd: "true" } },
    };
    await expect(
      dispatchUserCommand(
        baseInput({
          name: "broken",
          config,
          envGroupOverride: "imaginary",
        }),
      ),
    ).rejects.toThrow(/imaginary/);
  });
});

describe("dispatchUserCommand — ${...} interpolation in cmd", () => {
  it("resolves ${owned.X.port} in command.cmd before exec", async () => {
    const marker = join(tmp, "port.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        "show-port": {
          cmd: `echo "\${owned.api.port}" > "$OUT"`,
        },
      },
    };
    const portsWithApi: AllocatedPorts = {
      compose: {},
      owned: { api: { port: 9001 } },
    };
    const result = await dispatchUserCommand(
      baseInput({
        name: "show-port",
        config,
        allocatedPorts: portsWithApi,
      }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("9001");
  });

  it("resolves ${worktree.id} in command.cmd before exec", async () => {
    const marker = join(tmp, "wtid.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        "show-id": {
          cmd: `echo "\${worktree.id}" > "$OUT"`,
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "show-id", config }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe(worktree.id);
  });

  it("leaves plain shell vars like ${SHELL_VAR} unchanged (pass-through)", async () => {
    const marker = join(tmp, "shell.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker, MY_ENV: "hello" },
      commands: {
        "use-shell-var": {
          cmd: `echo "\${MY_ENV}" > "$OUT"`,
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "use-shell-var", config }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("hello");
  });
});
