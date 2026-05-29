import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  runFeedback,
  redactEnvFromCmds,
  renderGitHubDeepLink,
  shouldUseDeepLink,
} from "../../../src/commands/feedback.js";

let workDir: string;
let cacheDir: string;
let prevLichHome: string | undefined;
let prevLichNoBrowser: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "lich-feedback-work-"));
  cacheDir = mkdtempSync(join(tmpdir(), "lich-feedback-cache-"));
  prevLichHome = process.env.LICH_HOME;
  prevLichNoBrowser = process.env.LICH_NO_BROWSER;
  // pristine LICH_HOME so isDaemonAlive() sees no daemon
  process.env.LICH_HOME = workDir;
  // never spawn a real browser from unit tests
  process.env.LICH_NO_BROWSER = "1";
});

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  if (prevLichNoBrowser === undefined) {
    delete process.env.LICH_NO_BROWSER;
  } else {
    process.env.LICH_NO_BROWSER = prevLichNoBrowser;
  }
  rmSync(workDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

class Sink {
  chunks: string[] = [];
  write = (chunk: string | Uint8Array): boolean => {
    this.chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  };
  text(): string {
    return this.chunks.join("");
  }
}

function makeSink(): { sink: Sink; out: NodeJS.WritableStream } {
  const sink = new Sink();
  return { sink, out: sink as unknown as NodeJS.WritableStream };
}

function ttyStream(input: string, isTTY: boolean): NodeJS.ReadableStream {
  const stream = Readable.from([input]) as Readable & { isTTY?: boolean };
  if (isTTY) {
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
  return stream;
}

describe("runFeedback — inline mode", () => {
  it("produces a printable payload with auto-context and a deep-link footer", async () => {
    const { sink, out } = makeSink();
    const { sink: errSink, out: err } = makeSink();
    const result = await runFeedback({
      argv: ["the", "supabase", "skill", "missed", "the", "oneshot", "pattern"],
      cwd: workDir,
      cacheDir,
      yes: true,
      noBrowser: true,
      out,
      err,
    });

    expect(result.exitCode).toBe(0);
    expect(errSink.text()).toBe("");

    const text = sink.text();
    expect(text).toContain("---- feedback payload ----");
    expect(text).toContain("---- end payload ----");
    expect(text).toContain(
      "the supabase skill missed the oneshot pattern",
    );
    expect(text).toMatch(/lich version: \S+/);
    expect(text).toMatch(/platform: \S+/);
    expect(text).toContain(`cwd: ${workDir}`);
    expect(text).toMatch(/lich\.yaml: absent/);
    expect(text).toMatch(/daemon: not running/);
    expect(text).toContain("To submit, open this pre-filled GitHub issue:");
    expect(text).toContain("https://github.com/RPate97/lich/issues/new?");
    expect(text).toContain("RPate97/lich");
    expect(text).toMatch(/cached locally at: .+\.md/);
  });
});

describe("runFeedback — --file mode", () => {
  it("reads the message body from the given file", async () => {
    const path = join(workDir, "feedback.md");
    writeFileSync(
      path,
      "## Heading\n\nFile-based feedback body with multiple lines.\n",
      "utf8",
    );

    const { sink, out } = makeSink();
    const result = await runFeedback({
      file: path,
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
    });
    expect(result.exitCode).toBe(0);
    const text = sink.text();
    expect(text).toContain("File-based feedback body with multiple lines.");
    expect(text).toContain("## Heading");
  });

  it("returns exit 2 when --file points at a missing path", async () => {
    const { sink: errSink, out: err } = makeSink();
    const { out } = makeSink();
    const result = await runFeedback({
      file: join(workDir, "does-not-exist.md"),
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
      err,
    });
    expect(result.exitCode).toBe(2);
    expect(errSink.text()).toMatch(/--file not found/);
  });
});

describe("runFeedback — --no-context", () => {
  it("suppresses every auto-attached system-info section", async () => {
    const { sink, out } = makeSink();
    const result = await runFeedback({
      argv: ["bare message"],
      cwd: workDir,
      cacheDir,
      yes: true,
      noContext: true,
      out,
    });
    expect(result.exitCode).toBe(0);
    const text = sink.text();
    expect(text).toContain("bare message");
    expect(text).not.toContain("## Environment");
    expect(text).not.toMatch(/lich version:/);
    expect(text).not.toMatch(/platform:/);
    expect(text).not.toMatch(/daemon:/);
    expect(text).not.toContain("## lich.yaml");
    // submission footer survives — --no-context affects auto-context only
    expect(text).toContain("To submit, open this pre-filled GitHub issue:");
  });
});

describe("runFeedback — privacy", () => {
  it("redacts env_from cmd: values from the attached lich.yaml", async () => {
    const SECRET_CMD = "op read op://vault/db/password";
    writeFileSync(
      join(workDir, "lich.yaml"),
      [
        'version: "1"',
        "env_from:",
        `  - cmd: ${SECRET_CMD}`,
        "services:",
        "  api:",
        "    cmd: echo hi",
        "",
      ].join("\n"),
      "utf8",
    );

    const { sink, out } = makeSink();
    const result = await runFeedback({
      argv: ["filing a report"],
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
    });
    expect(result.exitCode).toBe(0);
    const text = sink.text();
    expect(text).not.toContain(SECRET_CMD);
    expect(text).not.toContain("op://vault/db/password");
    expect(text).toContain("cmd: <redacted>");
    // unrelated services.api.cmd survives — only env_from is redacted
    expect(text).toContain("cmd: echo hi");
  });

  it("does NOT include env: resolved values in the payload (no parseConfig pass)", async () => {
    const SECRET = "DOTENV_SECRET_must_not_leak";
    writeFileSync(join(workDir, ".env"), `SECRET=${SECRET}\n`, "utf8");
    writeFileSync(
      join(workDir, "lich.yaml"),
      ['version: "1"', "env_files:", "  - .env", ""].join("\n"),
      "utf8",
    );

    const { sink, out } = makeSink();
    const result = await runFeedback({
      argv: ["report"],
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
    });
    expect(result.exitCode).toBe(0);
    const text = sink.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("DOTENV_SECRET");
  });
});

describe("runFeedback — confirmation prompt", () => {
  it("TTY + 'n' declines → 'aborted (not submitted)', no cache file written", async () => {
    const { sink, out } = makeSink();
    const stdin = ttyStream("n\n", true);
    const result = await runFeedback({
      argv: ["something to say"],
      cwd: workDir,
      cacheDir,
      out,
      in: stdin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.cachedAt).toBeUndefined();
    expect(sink.text()).toMatch(/aborted \(not submitted\)/);
    const entries = readdirSync(cacheDir);
    expect(entries).toEqual([]);
  });

  it("TTY + 'y' accepts → cache file written + submit footer printed", async () => {
    const { sink, out } = makeSink();
    const stdin = ttyStream("y\n", true);
    const result = await runFeedback({
      argv: ["another report"],
      cwd: workDir,
      cacheDir,
      noBrowser: true,
      out,
      in: stdin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.cachedAt).toBeDefined();
    expect(existsSync(result.cachedAt!)).toBe(true);
    const cached = readFileSync(result.cachedAt!, "utf8");
    expect(cached).toContain("another report");
    expect(sink.text()).toContain("To submit, open this pre-filled GitHub issue:");
  });

  it("non-TTY stdin skips the prompt (treats as scripted)", async () => {
    const { sink, out } = makeSink();
    const stdin = ttyStream("", false);
    const result = await runFeedback({
      argv: ["scripted"],
      cwd: workDir,
      cacheDir,
      out,
      in: stdin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.cachedAt).toBeDefined();
    expect(sink.text()).not.toContain("Submit this feedback?");
  });
});

describe("runFeedback — empty body", () => {
  it("returns exit 2 with an error when the resolved body is empty", async () => {
    const path = join(workDir, "empty.md");
    writeFileSync(path, "", "utf8");

    const { out } = makeSink();
    const { sink: errSink, out: err } = makeSink();
    const result = await runFeedback({
      file: path,
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
      err,
    });
    expect(result.exitCode).toBe(2);
    expect(errSink.text()).toMatch(/empty message/);
  });

  it("returns exit 2 when the editor returns only whitespace + comments", async () => {
    const { out } = makeSink();
    const { sink: errSink, out: err } = makeSink();
    const result = await runFeedback({
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
      err,
      editorImpl: async () => ({ ok: true, message: "" }),
    });
    expect(result.exitCode).toBe(2);
    expect(errSink.text()).toMatch(/empty message/);
  });
});

describe("runFeedback — local cache", () => {
  it("writes the payload to <cacheDir>/<timestamp>.md", async () => {
    const { out } = makeSink();
    const result = await runFeedback({
      argv: ["cache me"],
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
    });
    expect(result.exitCode).toBe(0);
    expect(result.cachedAt).toBeDefined();
    expect(result.cachedAt).toMatch(/\.md$/);
    expect(result.cachedAt!.startsWith(cacheDir)).toBe(true);
    const body = readFileSync(result.cachedAt!, "utf8");
    expect(body).toContain("cache me");
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });
});

describe("runFeedback — editor mode", () => {
  it("invokes editorImpl when no argv and no --file are given, reads the result", async () => {
    let editorPath = "";
    const { sink, out } = makeSink();
    const result = await runFeedback({
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
      editorImpl: async (path) => {
        editorPath = path;
        writeFileSync(
          path,
          "# template comment\n\nThe editor-driven message body.\n",
          "utf8",
        );
        return { ok: true, message: "" };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(editorPath.length).toBeGreaterThan(0);
    expect(sink.text()).toContain("The editor-driven message body.");
    expect(sink.text()).not.toContain("# template comment");
  });

  it("returns exit 2 when the editor exits non-zero", async () => {
    const { out } = makeSink();
    const { sink: errSink, out: err } = makeSink();
    const result = await runFeedback({
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
      err,
      editorImpl: async () => ({ ok: false, message: "user quit without saving" }),
    });
    expect(result.exitCode).toBe(2);
    expect(errSink.text()).toMatch(/user quit/);
  });
});

describe("redactEnvFromCmds", () => {
  it("redacts a scalar cmd: under env_from", () => {
    const input = [
      'version: "1"',
      "env_from:",
      "  - cmd: op read op://vault/db",
      "  - cmd: echo hello",
      "services:",
      "  api:",
      "    cmd: bun run dev",
      "",
    ].join("\n");
    const out = redactEnvFromCmds(input);
    expect(out).not.toContain("op://vault/db");
    expect(out).not.toContain("echo hello");
    expect(out).toContain("cmd: <redacted>");
    expect(out).toContain("cmd: bun run dev");
  });

  it("redacts a block-scalar cmd: under env_from (cmd: |)", () => {
    const input = [
      'version: "1"',
      "env_from:",
      "  - cmd: |",
      "      op read op://vault/big-secret",
      "      | tr -d '\\n'",
      "services:",
      "  api:",
      "    cmd: |",
      "      bun run dev",
      "",
    ].join("\n");
    const out = redactEnvFromCmds(input);
    expect(out).not.toContain("op://vault/big-secret");
    expect(out).toContain("cmd: <redacted>");
    expect(out).toContain("bun run dev");
  });

  it("leaves cmd: keys outside env_from alone", () => {
    const input = [
      'version: "1"',
      "services:",
      "  api:",
      "    cmd: bun run dev",
      "  web:",
      "    cmd: next dev",
      "",
    ].join("\n");
    const out = redactEnvFromCmds(input);
    expect(out).toContain("cmd: bun run dev");
    expect(out).toContain("cmd: next dev");
    expect(out).not.toContain("<redacted>");
  });

  it("handles env_from nested under a service", () => {
    const input = [
      'version: "1"',
      "services:",
      "  api:",
      "    cmd: bun run dev",
      "    env_from:",
      "      - cmd: op read op://vault/api-key",
      "  web:",
      "    cmd: next dev",
      "",
    ].join("\n");
    const out = redactEnvFromCmds(input);
    expect(out).not.toContain("op://vault/api-key");
    expect(out).toContain("cmd: <redacted>");
    expect(out).toContain("cmd: bun run dev");
    expect(out).toContain("cmd: next dev");
  });
});

describe("renderGitHubDeepLink", () => {
  it("encodes title, body, and labels into a github issues/new URL", () => {
    const url = renderGitHubDeepLink({
      title: "feedback: tunnel hangs",
      body: "## Message\n\nsomething broke",
      labels: ["feedback"],
    });
    expect(url.startsWith("https://github.com/RPate97/lich/issues/new?")).toBe(true);
    expect(url).toContain("title=feedback%3A+tunnel+hangs");
    expect(url).toContain("body=%23%23+Message");
    expect(url).toContain("labels=feedback");
  });

  it("omits the labels param when no labels are passed", () => {
    const url = renderGitHubDeepLink({
      title: "t",
      body: "b",
    });
    expect(url).not.toContain("labels=");
  });

  it("comma-joins multiple labels", () => {
    const url = renderGitHubDeepLink({
      title: "t",
      body: "b",
      labels: ["feedback", "bug"],
    });
    expect(url).toContain("labels=feedback%2Cbug");
  });
});

describe("shouldUseDeepLink", () => {
  it("returns true for short URLs", () => {
    expect(shouldUseDeepLink("https://example.com/short")).toBe(true);
  });

  it("returns false at the 6000-char threshold", () => {
    expect(shouldUseDeepLink("x".repeat(6000))).toBe(false);
  });

  it("returns true just under the threshold", () => {
    expect(shouldUseDeepLink("x".repeat(5999))).toBe(true);
  });
});

describe("runFeedback — deep-link path", () => {
  it("prints the GitHub deep-link URL for a short payload", async () => {
    const { sink, out } = makeSink();
    const opens: string[] = [];
    const result = await runFeedback({
      argv: ["short", "feedback", "body"],
      cwd: workDir,
      cacheDir,
      yes: true,
      noBrowser: true,
      out,
      openBrowserImpl: (url) => opens.push(url),
    });
    expect(result.exitCode).toBe(0);

    const text = sink.text();
    expect(text).toContain("To submit, open this pre-filled GitHub issue:");
    expect(text).toContain("https://github.com/RPate97/lich/issues/new?");
    expect(text).toContain("title=feedback%3A+short+feedback+body");
    expect(text).toContain("&labels=feedback");
    expect(text).toMatch(/body=%23%23\+Message/);
    expect(text).not.toContain("curl");
  });

  it("opens the browser by default when not in --no-browser mode", async () => {
    // beforeEach sets LICH_NO_BROWSER=1 to keep the suite safe; the default
    // behavior test needs to clear it explicitly to exercise the open path.
    delete process.env.LICH_NO_BROWSER;
    const { out } = makeSink();
    const opens: string[] = [];
    const result = await runFeedback({
      argv: ["browser open test"],
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
      openBrowserImpl: (url) => opens.push(url),
    });
    expect(result.exitCode).toBe(0);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toContain("github.com/RPate97/lich/issues/new");
  });

  it("--no-browser prints the URL without opening the browser", async () => {
    const { sink, out } = makeSink();
    const opens: string[] = [];
    const result = await runFeedback({
      argv: ["no browser test"],
      cwd: workDir,
      cacheDir,
      yes: true,
      noBrowser: true,
      out,
      openBrowserImpl: (url) => opens.push(url),
    });
    expect(result.exitCode).toBe(0);
    expect(opens).toEqual([]);
    expect(sink.text()).toContain("https://github.com/RPate97/lich/issues/new?");
  });

  it("LICH_NO_BROWSER=1 suppresses the browser open the same way", async () => {
    // beforeEach already sets LICH_NO_BROWSER=1; this test exercises the env
    // var path explicitly (no input.noBrowser flag).
    const { sink, out } = makeSink();
    const opens: string[] = [];
    const result = await runFeedback({
      argv: ["env var no browser"],
      cwd: workDir,
      cacheDir,
      yes: true,
      out,
      openBrowserImpl: (url) => opens.push(url),
    });
    expect(result.exitCode).toBe(0);
    expect(opens).toEqual([]);
    expect(sink.text()).toContain(
      "https://github.com/RPate97/lich/issues/new?",
    );
  });
});

describe("runFeedback — curl fallback for long payloads", () => {
  it("falls back to curl + body-less deep-link when payload exceeds the URL cap", async () => {
    const { sink, out } = makeSink();
    const opens: string[] = [];
    // 6KB body that, once embedded + url-encoded, blows past the 6000-char URL cap.
    const longBody = "x".repeat(6000);
    const result = await runFeedback({
      argv: [longBody],
      cwd: workDir,
      cacheDir,
      yes: true,
      noBrowser: true,
      noContext: true,
      out,
      openBrowserImpl: (url) => opens.push(url),
    });
    expect(result.exitCode).toBe(0);
    expect(opens).toEqual([]);

    const text = sink.text();
    expect(text).toContain("To submit, run:");
    expect(text).toContain("curl");
    expect(text).toContain("Payload too long for URL");
    // body-less deep-link still printed as a second option
    expect(text).toContain("https://github.com/RPate97/lich/issues/new?");
    // The full encoded body must NOT be in the URL line — only the placeholder.
    expect(text).toContain("Payload+too+long+for+URL");
  });

  it("uses the deep-link path for a short body even with context attached", async () => {
    const { sink, out } = makeSink();
    const result = await runFeedback({
      argv: ["short"],
      cwd: workDir,
      cacheDir,
      yes: true,
      noBrowser: true,
      out,
    });
    expect(result.exitCode).toBe(0);
    const text = sink.text();
    expect(text).toContain("To submit, open this pre-filled GitHub issue:");
    expect(text).not.toContain("curl");
  });
});
