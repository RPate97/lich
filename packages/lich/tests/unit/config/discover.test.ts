import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContext,
  compileTemplate,
  DiscoverError,
  expandDiscover,
} from "../../../src/config/discover.js";
import type { LichConfig } from "../../../src/config/types.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-discover-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function touch(...segs: string[]): void {
  const p = join(tmp, ...segs);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "// stub for discover test\n");
}

describe("buildContext", () => {
  it("splits basename, basename_no_ext, and dirname for a nested file", () => {
    const ctx = buildContext("apps/cronjob/src/temporal/workers/EmailTemporalWorker.ts");
    expect(ctx.basename).toBe("EmailTemporalWorker.ts");
    expect(ctx.basename_no_ext).toBe("EmailTemporalWorker");
    expect(ctx.dirname).toBe("apps/cronjob/src/temporal/workers");
  });

  it("returns empty dirname for a file at the glob root", () => {
    const ctx = buildContext("Worker.ts");
    expect(ctx.dirname).toBe("");
    expect(ctx.basename).toBe("Worker.ts");
    expect(ctx.basename_no_ext).toBe("Worker");
  });

  it("strips only the FINAL extension on a multi-dot filename", () => {
    const ctx = buildContext("api.service.ts");
    expect(ctx.basename).toBe("api.service.ts");
    expect(ctx.basename_no_ext).toBe("api.service");
  });

  it("treats a leading-dot filename as having no extension to strip", () => {
    const ctx = buildContext(".gitignore");
    expect(ctx.basename).toBe(".gitignore");
    expect(ctx.basename_no_ext).toBe(".gitignore");
  });
});

describe("compileTemplate — variables", () => {
  it("expands ${basename}", () => {
    const tpl = compileTemplate("file=${basename}", "/loc");
    const out = tpl(buildContext("workers/Foo.ts"));
    expect(out).toBe("file=Foo.ts");
  });

  it("expands ${basename_no_ext}", () => {
    const tpl = compileTemplate("name=${basename_no_ext}", "/loc");
    const out = tpl(buildContext("workers/Foo.ts"));
    expect(out).toBe("name=Foo");
  });

  it("expands ${dirname}", () => {
    const tpl = compileTemplate("dir=${dirname}", "/loc");
    const out = tpl(buildContext("a/b/Foo.ts"));
    expect(out).toBe("dir=a/b");
  });

  it("supports multiple expressions in one template", () => {
    const tpl = compileTemplate("${dirname}/${basename_no_ext}.js", "/loc");
    const out = tpl(buildContext("dist/temporal/EmailWorker.ts"));
    expect(out).toBe("dist/temporal/EmailWorker.js");
  });

  it("passes literal text through unchanged", () => {
    const tpl = compileTemplate("pnpm run ${basename_no_ext} --watch", "/loc");
    const out = tpl(buildContext("Foo.ts"));
    expect(out).toBe("pnpm run Foo --watch");
  });
});

describe("compileTemplate — filters", () => {
  it("kebab lowercases and dash-collapses non-alphanumerics", () => {
    const tpl = compileTemplate("${basename_no_ext | kebab}", "/loc");
    expect(tpl(buildContext("EmailWorker.ts"))).toBe("email-worker");
    expect(tpl(buildContext("Email_Worker.ts"))).toBe("email-worker");
    expect(tpl(buildContext("email.worker.ts"))).toBe("email-worker");
  });

  it("snake lowercases and underscore-collapses non-alphanumerics", () => {
    const tpl = compileTemplate("${basename_no_ext | snake}", "/loc");
    expect(tpl(buildContext("EmailWorker.ts"))).toBe("email_worker");
    expect(tpl(buildContext("Email-Worker.ts"))).toBe("email_worker");
  });

  it("strip_suffix removes the trailing arg when present", () => {
    const tpl = compileTemplate("${basename_no_ext | strip_suffix:Worker}", "/loc");
    expect(tpl(buildContext("EmailWorker.ts"))).toBe("Email");
    expect(tpl(buildContext("EmailService.ts"))).toBe("EmailService");
  });

  it("strip_prefix removes the leading arg when present", () => {
    const tpl = compileTemplate("${basename_no_ext | strip_prefix:Worker}", "/loc");
    expect(tpl(buildContext("WorkerEmail.ts"))).toBe("Email");
    expect(tpl(buildContext("ServiceEmail.ts"))).toBe("ServiceEmail");
  });

  it("chains filters left to right (canonical example)", () => {
    const tpl = compileTemplate(
      "${basename_no_ext | strip_suffix:TemporalWorker | kebab}-worker",
      "/loc",
    );
    expect(tpl(buildContext("EmailTemporalWorker.ts"))).toBe("email-worker");
    expect(tpl(buildContext("CleanupTemporalWorker.ts"))).toBe("cleanup-worker");
    expect(tpl(buildContext("PaymentTemporalWorker.ts"))).toBe("payment-worker");
  });
});

describe("compileTemplate — error paths", () => {
  it("rejects an unknown variable with a 'did you mean' hint when close", () => {
    expect(() => compileTemplate("${basenmae}", "/loc")).toThrow(DiscoverError);
    try {
      compileTemplate("${basenmae}", "/loc");
    } catch (e) {
      expect((e as DiscoverError).message).toMatch(/unknown template var/);
      expect((e as DiscoverError).message).toMatch(/basename/);
      expect((e as DiscoverError).location).toBe("/loc");
    }
  });

  it("rejects an unknown variable with the known set listed when no close match", () => {
    expect(() => compileTemplate("${frobnicate}", "/loc")).toThrow(DiscoverError);
    try {
      compileTemplate("${frobnicate}", "/loc");
    } catch (e) {
      const msg = (e as DiscoverError).message;
      expect(msg).toMatch(/unknown template var/);
      expect(msg).toContain("known:");
      expect(msg).toContain("basename");
    }
  });

  it("rejects an unknown filter with a 'did you mean' hint when close", () => {
    expect(() => compileTemplate("${basename | kabab}", "/loc")).toThrow(DiscoverError);
    try {
      compileTemplate("${basename | kabab}", "/loc");
    } catch (e) {
      const msg = (e as DiscoverError).message;
      expect(msg).toMatch(/unknown template filter/);
      expect(msg).toContain("kebab");
    }
  });

  it("rejects an unterminated ${ block", () => {
    expect(() => compileTemplate("hello ${basename", "/loc")).toThrow(
      /unterminated/i,
    );
  });

  it("rejects an empty ${} expression", () => {
    expect(() => compileTemplate("${}", "/loc")).toThrow(/empty/i);
  });

  it("rejects strip_suffix without an argument", () => {
    expect(() => compileTemplate("${basename | strip_suffix}", "/loc")).toThrow(
      /requires an argument/i,
    );
  });

  it("rejects strip_prefix without an argument", () => {
    expect(() => compileTemplate("${basename | strip_prefix}", "/loc")).toThrow(
      /requires an argument/i,
    );
  });

  it("rejects a filter that doesn't take an argument when one is given", () => {
    expect(() => compileTemplate("${basename | kebab:foo}", "/loc")).toThrow(
      /does not accept an argument/i,
    );
  });

  it("rejects an empty filter segment from a trailing `|`", () => {
    expect(() => compileTemplate("${basename | }", "/loc")).toThrow(
      /empty filter/i,
    );
  });
});

describe("expandDiscover", () => {
  it("expands a discover block into one synthetic service per matched file", async () => {
    touch("apps/cronjob/src/temporal/workers/EmailTemporalWorker.ts");
    touch("apps/cronjob/src/temporal/workers/PaymentTemporalWorker.ts");
    touch("apps/cronjob/src/temporal/workers/CleanupTemporalWorker.ts");
    touch("apps/cronjob/src/temporal/workers/index.ts");

    // glob is relative to discover.cwd (apps/cronjob), not the config dir
    const config: LichConfig = {
      version: "1",
      owned: {
        "cronjob-workers": {
          discover: {
            glob: "src/temporal/workers/*TemporalWorker.ts",
            name_template:
              "${basename_no_ext | strip_suffix:TemporalWorker | kebab}-worker",
            cmd_template:
              "pnpm exec nodemon -r ./tsconfigPathsDist.js dist/temporal/workers/${basename_no_ext}.js",
            cwd: "apps/cronjob",
          },
          ready_when: {
            log_match: "Temporal worker created successfully",
          },
          env: {
            NODE_ENV: "development",
          },
        },
      },
    };

    await expandDiscover(config, tmp);

    expect(config.owned).toBeDefined();
    expect("cronjob-workers" in config.owned!).toBe(false);

    const names = Object.keys(config.owned!).sort();
    expect(names).toEqual([
      "cleanup-worker",
      "email-worker",
      "payment-worker",
    ]);

    const email = config.owned!["email-worker"];
    expect(email.cmd).toBe(
      "pnpm exec nodemon -r ./tsconfigPathsDist.js dist/temporal/workers/EmailTemporalWorker.js",
    );
    expect(email.cwd).toBe("apps/cronjob");
    expect(email.ready_when?.log_match).toBe("Temporal worker created successfully");
    expect(email.env?.NODE_ENV).toBe("development");
    expect(email.discover).toBeUndefined();
  });

  it("sorts the expanded services alphabetically by materialized name", async () => {
    touch("workers/zWorker.ts");
    touch("workers/aWorker.ts");
    touch("workers/mWorker.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        ws: {
          discover: {
            glob: "workers/*Worker.ts",
            name_template: "${basename_no_ext | kebab}",
            cmd_template: "node ${basename}",
          },
        },
      },
    };

    await expandDiscover(config, tmp);

    expect(Object.keys(config.owned!)).toEqual([
      "a-worker",
      "m-worker",
      "z-worker",
    ]);
  });

  it("preserves hand-written owned entries unchanged", async () => {
    touch("workers/Foo.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          cwd: "apps/api",
        },
        workers: {
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext | kebab}",
            cmd_template: "node ${basename}",
          },
        },
      },
    };

    await expandDiscover(config, tmp);

    expect(config.owned!.api.cmd).toBe("bun run dev");
    expect(config.owned!.api.cwd).toBe("apps/api");
    expect(config.owned!.foo).toBeDefined();
    expect(config.owned!.foo.cmd).toBe("node Foo.ts");
    expect("workers" in config.owned!).toBe(false);
  });

  it("zero matches is not an error (yields zero synthetic services)", async () => {
    mkdirSync(join(tmp, "workers"), { recursive: true });

    const config: LichConfig = {
      version: "1",
      owned: {
        api: { cmd: "bun run dev" },
        workers: {
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext}",
            cmd_template: "node ${basename}",
          },
        },
      },
    };

    await expandDiscover(config, tmp);

    expect(Object.keys(config.owned!)).toEqual(["api"]);
  });

  it("rejects a synthetic name that collides with a hand-written entry", async () => {
    touch("workers/api.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        api: { cmd: "bun run dev" },
        workers: {
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext}",
            cmd_template: "node ${basename}",
          },
        },
      },
    };

    await expect(expandDiscover(config, tmp)).rejects.toThrow(DiscoverError);
    await expect(expandDiscover(config, tmp)).rejects.toThrow(/collides/i);
  });

  it("rejects two discover blocks that produce the same synthetic name", async () => {
    touch("a/Foo.ts");
    touch("b/Foo.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        groupA: {
          discover: {
            glob: "a/*.ts",
            name_template: "${basename_no_ext | kebab}",
            cmd_template: "node ${basename}",
          },
        },
        groupB: {
          discover: {
            glob: "b/*.ts",
            name_template: "${basename_no_ext | kebab}",
            cmd_template: "node ${basename}",
          },
        },
      },
    };

    await expect(expandDiscover(config, tmp)).rejects.toThrow(/collides/i);
  });

  it("rejects an empty name_template expansion", async () => {
    touch("workers/Worker.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        ws: {
          discover: {
            glob: "workers/*.ts",
            // strip_suffix:Worker on "Worker" → ""
            name_template: "${basename_no_ext | strip_suffix:Worker}",
            cmd_template: "node ${basename}",
          },
        },
      },
    };

    await expect(expandDiscover(config, tmp)).rejects.toThrow(/empty string/i);
  });

  it("rejects an empty cmd_template expansion", async () => {
    touch("workers/Worker.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        ws: {
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext}",
            cmd_template: "${basename_no_ext | strip_suffix:Worker}",
          },
        },
      },
    };

    await expect(expandDiscover(config, tmp)).rejects.toThrow(/empty string/i);
  });

  it("uses discover.cwd as the glob root AND per-instance cwd", async () => {
    touch("apps/cronjob/src/workers/Foo.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        ws: {
          discover: {
            // glob is relative to discover.cwd, not the config dir
            glob: "src/workers/*.ts",
            name_template: "${basename_no_ext | kebab}",
            cmd_template: "node ${basename}",
            cwd: "apps/cronjob",
          },
        },
      },
    };

    await expandDiscover(config, tmp);
    expect(config.owned!.foo).toBeDefined();
    expect(config.owned!.foo.cwd).toBe("apps/cronjob");
    expect(config.owned!.foo.cmd).toBe("node Foo.ts");
  });

  it("falls back to parent.cwd when discover.cwd is unset", async () => {
    touch("apps/cronjob/workers/Foo.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        ws: {
          cwd: "apps/cronjob",
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext | kebab}",
            cmd_template: "node ${basename}",
          },
        },
      },
    };

    await expandDiscover(config, tmp);
    expect(config.owned!.foo).toBeDefined();
    expect(config.owned!.foo.cwd).toBe("apps/cronjob");
  });

  it("falls back to configDir when neither cwd is set", async () => {
    touch("workers/Foo.ts");

    const config: LichConfig = {
      version: "1",
      owned: {
        ws: {
          discover: {
            glob: "workers/*.ts",
            name_template: "${basename_no_ext | kebab}",
            cmd_template: "node ${basename}",
          },
        },
      },
    };

    await expandDiscover(config, tmp);
    expect(config.owned!.foo).toBeDefined();
    // undefined cwd = runtime's "configDir" default
    expect(config.owned!.foo.cwd).toBeUndefined();
  });

  it("noop on configs with no owned section", async () => {
    const config: LichConfig = { version: "1" };
    await expandDiscover(config, tmp);
    expect(config.owned).toBeUndefined();
  });

  it("noop on configs with no discover blocks", async () => {
    const config: LichConfig = {
      version: "1",
      owned: {
        api: { cmd: "bun run dev" },
      },
    };
    await expandDiscover(config, tmp);
    expect(Object.keys(config.owned!)).toEqual(["api"]);
    expect(config.owned!.api.cmd).toBe("bun run dev");
  });
});
