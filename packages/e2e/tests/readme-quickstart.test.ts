
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { parseLichUrls } from "../helpers/urls.js";
import { readStateJson, waitForStackStatus } from "../helpers/state.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build lich binary (exit ${build.status}); cannot run e2e tests`,
    );
  }
  if (!existsSync(lichBinary)) {
    throw new Error(
      `lich build reported success but ${lichBinary} does not exist`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-test fixture state — every test gets a fresh tmpdir / LICH_HOME so
// nothing leaks between runs and the user's real ~/.lich is never touched.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  // install: true — apps/web runs `next dev`, which needs `next` in
  // node_modules/.bin. Without it the web owned service exits 127
  // immediately and `lich up` fails before any state.json is written.
  // Same rationale as `basic-up.test.ts` (LEV-313).
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-readme-quickstart-home-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/** Always-best-effort teardown — logs failures, swallows them. */
function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  // Plan-5 daemon would otherwise hold proxy port 3300 across tests;
  // see `basic-up.test.ts`'s afterEach for the rationale.
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch {
    /* best-effort */
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`, err);
  }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the (single) stack id under `<lichHome>/stacks/`. The quickstart
 * test brings up one stack per test, so we list the directory and pick
 * the only entry. Returns null if no stack dir exists yet.
 */
function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot).filter((name) => {
    try {
      return statSync(join(stacksRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (entries.length === 0) return null;
  return entries[0];
}

// ---------------------------------------------------------------------------
// The README quickstart contract
// ---------------------------------------------------------------------------

describe("README quickstart", () => {
  // *** If you change the commands below, update README.md's `## Quickstart`
  // *** section to match. The README is the external promise; this test is
  // *** the proof that the promise still holds.
  //
  // README's `## Quickstart` commands, semantically:
  //   1. `cd examples/dogfood-stack` — copyExampleToTmpdir("dogfood-stack")
  //   2. `lich up`                  — runLich(["up"], { cwd, LICH_HOME })
  //   3. (the README implies)       — runLich(["urls"], { cwd, LICH_HOME })
  //   4. "open the URL in a browser" — waitForHttp200 against the first url
  //   5. `lich down` (cleanup)      — runLich(["down"], { cwd, LICH_HOME })
  it(
    "lich up + lich urls + URL responds 200 + lich down cleans up",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Progress logger — mirrors the live-stderr pattern from
      // `basic-up.test.ts` so failures show the phase, not just a timeout.
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- Step 1+2: README `cd examples/dogfood-stack && lich up` ----
      // No profile arg — resolves to dev:fast (the dogfood stack's
      // `default: true` profile). --no-browser keeps the Plan-5
      // browser-auto-open from racing the test.
      step("lich up --no-browser (README's `lich up` — dev:fast default)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        // 60s budget — dev:fast typically resolves in ~3-5s, but the
        // first `next dev` compile can stretch on slow CI. Mirrors
        // `basic-up.test.ts`'s budget.
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // Surface stdout+stderr so a failed up gives a real diagnostic
        // (port conflict, missing bun install, etc.) rather than the
        // mystery "lich up exited 1" message vitest would otherwise show.
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0 (README promises stack ready in seconds)");

      // ---- state.json: stack reached `up` -----------------------------
      // `lich up` only returns once the stack is ready (per spec section
      // 5), but assert state.json explicitly so a regression where `up`
      // returns prematurely shows up here, not as a flaky URL probe later.
      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 30_000,
      });
      expect(snap.status).toBe("up");
      // dev:fast resolves api + web only — confirms the README's
      // promise that the quickstart is fast (no postgres dependency).
      const serviceNames = snap.services.map((s) => s.name).sort();
      expect(serviceNames).toEqual(["api", "web"]);
      step(`stack ready with services [${serviceNames.join(", ")}]`);

      // ---- Step 3: README implies running `lich urls` -----------------
      // The README's quickstart shows the friendly-URL output block
      // explicitly ("api: http://api.<wt>.lich.localhost:3300/", etc.)
      // and tells the user to "open the web URL in a browser." That
      // promise has two parts:
      //   - `lich urls` exits 0 and prints HTTP URLs
      //   - those URLs serve 200 (i.e. the friendly proxy + dashboard
      //     daemon are working end-to-end)
      // The `--raw` flag is the part of the README that doesn't depend
      // on the Plan-5 friendly-URL daemon; we probe THOSE URLs because
      // raw URLs hit the upstream directly and prove the stack itself
      // is serving traffic. The friendly-URL contract is covered by
      // `basic-up.test.ts` (the second `it` block under that file's
      // `lich up against dogfood-stack` describe) — we don't duplicate
      // that here because the README's promise is "the stack comes up
      // and serves," not "the proxy is transparent."
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      // The README states URLs like `api: http://...` and `web: http://...`
      // appear; parseLichUrls handles both raw and friendly formats.
      const urls = parseLichUrls(urlsResult.stdout);
      const urlKeys = Object.keys(urls).sort();
      expect(
        urlKeys,
        `lich urls --raw should list api + web; got: ${urlsResult.stdout}`,
      ).toEqual(expect.arrayContaining(["api", "web"]));
      // At least one HTTP URL — the README explicitly lists the friendly
      // form `http://...` so a zero-URL output would be a regression.
      const allUrls = Object.values(urls);
      expect(
        allUrls.length,
        `lich urls should print at least one URL; saw 0 in:\n${urlsResult.stdout}`,
      ).toBeGreaterThan(0);
      const allLookLikeHttp = allUrls.every((u) =>
        /^https?:\/\//.test(u),
      );
      expect(
        allLookLikeHttp,
        `every printed URL should be http://… or https://…; got: ${JSON.stringify(urls)}`,
      ).toBe(true);

      // ---- Step 4: README's "open the URL in a browser" -> HTTP 200 ---
      // The api comes up first and serves /health immediately; the web
      // app sits behind Next.js cold-compile (typically 3-8s) so we
      // probe both with appropriate budgets. The README tells the user
      // to "open the web URL in a browser" — a 200 on `/` is the
      // minimum behavior that promise requires.
      const apiUrl = urls.api;
      const webUrl = urls.web;
      expect(apiUrl, `api URL expected in: ${urlsResult.stdout}`).toBeTruthy();
      expect(webUrl, `web URL expected in: ${urlsResult.stdout}`).toBeTruthy();

      step(`probing api /health (${apiUrl})`);
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      // dev:fast default → db: "stub". Catches the same default-flip
      // drift `helpers/dbmode.ts` was built to surface — if a future
      // change accidentally flips the default to `dev`, the README's
      // promise of a "fast, no-postgres" quickstart silently breaks.
      await expectDbMode(apiUrl!, "stub");

      step(`probing web / (${webUrl}) — README's main "open in browser" target`);
      // 30s — matches the LEV-443 acceptance criterion ("stack ready
      // within ~30s") and covers Next.js cold-compile on slow CI.
      await waitForHttp200(webUrl!, { timeoutMs: 30_000 });
      step("web served 200 — README quickstart promise holds");

      // Capture allocated ports so the post-down assertion can confirm
      // teardown released them.
      const allocatedPorts: number[] = [];
      for (const svc of snap.services) {
        if (!svc.allocated_ports) continue;
        for (const p of Object.values(svc.allocated_ports)) {
          allocatedPorts.push(p);
        }
      }
      expect(allocatedPorts.length).toBeGreaterThanOrEqual(2);

      // ---- Step 5: README's `lich down` cleans up --------------------
      // In-body teardown so the afterEach safety net sees status:stopped
      // and no-ops; mirrors `basic-up.test.ts` to keep cleanup hooks
      // under the 20s hookTimeout.
      step("lich down (README's teardown step)");
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      if (downResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich down stdout:", downResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich down stderr:", downResult.stderr);
      }
      expect(downResult.exitCode).toBe(0);

      // state.json transitions to status:stopped (lich keeps the entry
      // around for `lich stacks` visibility until nuke).
      const downSnap = readStateJson(lichHome, stackId!);
      expect(downSnap?.status).toBe("stopped");

      // The README promises `lich down` "tears the stack down" — the
      // explicit behavioral assertion is that the previously-allocated
      // ports stop listening. Give services a brief beat to release
      // sockets after teardown returns.
      await new Promise<void>((r) => setTimeout(r, 1_500));
      for (const port of allocatedPorts) {
        const stillUp = await tcpListening(port);
        expect(
          stillUp,
          `port ${port} still listening after lich down — README promised teardown but the port is still bound`,
        ).toBe(false);
      }
      step("lich down released allocated ports — README contract holds");
    },
    // Per-test timeout: the full quickstart (build + up + probe + down)
    // fits well inside 2 minutes on the fast pool; the larger budget
    // mirrors `basic-up.test.ts` and absorbs slow CI / cold caches.
    180_000,
  );
});

// ---------------------------------------------------------------------------
// TCP listening probe — local to this file because basic-up.test.ts's
// version is module-private. Tiny enough that duplicating is cheaper
// than promoting it to `helpers/wait.ts` for one extra caller.
// ---------------------------------------------------------------------------

function tcpListening(port: number): Promise<boolean> {
  return new Promise((res) => {
    // Lazy-require to avoid pulling node:net at the top — matches the
    // pattern in parallel-stacks.test.ts.
    const { createConnection } =
      require("node:net") as typeof import("node:net");
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 1000 });
    socket.on("connect", () => {
      socket.end();
      res(true);
    });
    socket.on("error", () => res(false));
    socket.on("timeout", () => {
      socket.destroy();
      res(false);
    });
  });
}
