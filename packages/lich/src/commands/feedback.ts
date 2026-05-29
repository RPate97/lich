/**
 * `lich feedback [message] [--file PATH] [--no-context] [--no-browser] [--yes]`
 * — user feedback. Inline / `--file` / $EDITOR modes. Caches to
 * `<LICH_HOME>/feedback/<ts>.md`. Short payloads open a pre-filled GitHub
 * issue in the browser; long ones fall back to a curl command.
 *
 * PRIVACY (LOAD-BEARING):
 *   - NEVER read resolved env values — yaml goes in raw with `env_from cmd:`
 *     values redacted via {@link redactEnvFromCmds}.
 *   - NEVER read `.env` files.
 *   - Always show the exact payload BEFORE asking for confirmation.
 *   - `--no-context` suppresses every auto-attached system-info section.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { VERSION } from "../version.js";
import { isDaemonAlive } from "../daemon/pid-file.js";
import { openInBrowser } from "../daemon/open-browser.js";

/** Soft cap on the encoded URL length before falling back to the curl path. */
const DEEP_LINK_MAX_URL_LENGTH = 6000;

const GITHUB_ISSUE_NEW_URL = "https://github.com/RPate97/lich/issues/new";

export interface RunFeedbackInput {
  /** Joined with spaces and used as inline message body when non-empty. */
  argv?: string[];
  file?: string;
  noContext?: boolean;
  yes?: boolean;
  noBrowser?: boolean;
  cwd?: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  in?: NodeJS.ReadableStream;
  /** Test override; defaults to `<LICH_HOME>/feedback/` or `~/.lich/feedback/`. */
  cacheDir?: string;
  /** Test override; defaults to spawning `$VISUAL` / `$EDITOR` / `vi`. */
  editorImpl?: (path: string) => Promise<{ ok: boolean; message: string }>;
  /** Test override; defaults to {@link openInBrowser}. */
  openBrowserImpl?: (url: string) => void;
}

export interface RunFeedbackResult {
  exitCode: number;
  /** Path to cached payload, present only when the user confirmed. */
  cachedAt?: string;
  /** Assembled payload text; always present, even on abort. */
  payload?: string;
}

export async function runFeedback(
  input: RunFeedbackInput = {},
): Promise<RunFeedbackResult> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const stdin = input.in ?? process.stdin;
  const cwd = input.cwd ?? process.cwd();

  let body: string;
  try {
    body = await resolveBody(input);
  } catch (e) {
    err.write(`lich feedback: ${(e as Error).message}\n`);
    return { exitCode: 2 };
  }

  if (body.trim().length === 0) {
    err.write("lich feedback: empty message, aborting (nothing to submit)\n");
    return { exitCode: 2 };
  }

  const context = input.noContext === true ? null : await gatherContext(cwd);
  const payload = assemblePayload({ body, context });

  // PRIVACY: always show the exact payload before confirming.
  out.write("---- feedback payload ----\n");
  out.write(payload);
  if (!payload.endsWith("\n")) out.write("\n");
  out.write("---- end payload ----\n");

  if (input.yes !== true && isTTY(stdin)) {
    const accepted = await confirm(out, stdin);
    if (!accepted) {
      out.write("aborted (not submitted)\n");
      return { exitCode: 0, payload };
    }
  }

  const cachedAt = await cachePayload(payload, input.cacheDir);

  out.write(`cached locally at: ${cachedAt}\n`);
  out.write("\n");

  const noBrowser =
    input.noBrowser === true ||
    process.env.LICH_NO_BROWSER === "1" ||
    process.env.LICH_NO_BROWSER === "true";

  presentSubmission({
    out,
    err,
    payload,
    body,
    cachedAt,
    noBrowser,
    openBrowserImpl: input.openBrowserImpl ?? openInBrowser,
  });

  return { exitCode: 0, cachedAt, payload };
}

/** Build the GitHub `issues/new` deep-link URL with title/body/labels prefilled. */
export function renderGitHubDeepLink(opts: {
  title: string;
  body: string;
  labels?: string[];
}): string {
  const params = new URLSearchParams();
  params.set("title", opts.title);
  params.set("body", opts.body);
  if (opts.labels && opts.labels.length > 0) {
    params.set("labels", opts.labels.join(","));
  }
  return `${GITHUB_ISSUE_NEW_URL}?${params.toString()}`;
}

/** True when the encoded URL is short enough for the browser-open path. */
export function shouldUseDeepLink(url: string): boolean {
  return url.length < DEEP_LINK_MAX_URL_LENGTH;
}

interface PresentSubmissionInput {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  payload: string;
  body: string;
  cachedAt: string;
  noBrowser: boolean;
  openBrowserImpl: (url: string) => void;
}

/**
 * Chooses between the deep-link (browser-open) and curl strategies based on
 * encoded URL length. Long payloads still surface a body-less deep-link as a
 * second option alongside the curl command.
 */
function presentSubmission(input: PresentSubmissionInput): void {
  const title = `feedback: ${(firstLine(input.body) || "feedback").slice(0, 80)}`;
  const deepLinkUrl = renderGitHubDeepLink({
    title,
    body: input.payload,
    labels: ["feedback"],
  });

  if (shouldUseDeepLink(deepLinkUrl)) {
    input.out.write("To submit, open this pre-filled GitHub issue:\n");
    input.out.write(`${deepLinkUrl}\n`);
    if (input.noBrowser) {
      return;
    }
    try {
      input.openBrowserImpl(deepLinkUrl);
    } catch (e) {
      input.err.write(
        `lich feedback: could not open browser: ${(e as Error).message}\n` +
          "  URL is printed above; open it manually.\n",
      );
    }
    return;
  }

  const bodylessUrl = renderGitHubDeepLink({
    title,
    body: `Payload too long for URL — paste from ${input.cachedAt}`,
    labels: ["feedback"],
  });
  input.out.write("To submit, run:\n");
  input.out.write(renderCurlCommand({ payload: input.payload, body: input.body }));
  input.out.write("\n");
  input.out.write("\n");
  input.out.write(
    `Payload too long for URL — paste from ${input.cachedAt}\n`,
  );
  input.out.write("Or open this GitHub issue and paste the cached payload:\n");
  input.out.write(`${bodylessUrl}\n`);
}

const EDITOR_TEMPLATE = [
  "# Write your feedback below. Lines starting with `#` are ignored.",
  "# Save and quit to submit; quit without saving to abort.",
  "#",
  "# What happened?",
  "",
  "",
  "# What did you expect to happen?",
  "",
  "",
  "# Anything else (repro steps, errors you saw)?",
  "",
  "",
].join("\n");

async function resolveBody(input: RunFeedbackInput): Promise<string> {
  if (typeof input.file === "string" && input.file.length > 0) {
    if (!existsSync(input.file)) {
      throw new Error(`--file not found: ${input.file}`);
    }
    return readFileSync(input.file, "utf8");
  }

  if (input.argv && input.argv.length > 0) {
    return input.argv.join(" ");
  }

  return runEditorMode(input.editorImpl);
}

async function runEditorMode(
  editorImpl: RunFeedbackInput["editorImpl"],
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lich-feedback-"));
  const path = join(dir, "FEEDBACK.md");
  writeFileSync(path, EDITOR_TEMPLATE, "utf8");

  let result: { ok: boolean; message: string };
  try {
    if (editorImpl) {
      result = await editorImpl(path);
    } else {
      result = spawnEditor(path);
    }
  } catch (e) {
    cleanup(path);
    throw new Error(`failed to open editor: ${(e as Error).message}`);
  }

  if (!result.ok) {
    cleanup(path);
    throw new Error(result.message || "editor exited non-zero");
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    cleanup(path);
    throw new Error(`failed to read editor buffer: ${(e as Error).message}`);
  }
  cleanup(path);

  const stripped = raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
  return stripped;
}

function spawnEditor(path: string): { ok: boolean; message: string } {
  const editor =
    process.env.VISUAL && process.env.VISUAL.length > 0
      ? process.env.VISUAL
      : process.env.EDITOR && process.env.EDITOR.length > 0
        ? process.env.EDITOR
        : "vi";

  const result = spawnSync(editor, [path], { stdio: "inherit" });
  if (result.error) {
    return { ok: false, message: result.error.message };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    return { ok: false, message: `editor '${editor}' exited ${result.status}` };
  }
  return { ok: true, message: "" };
}

function cleanup(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

interface FeedbackContext {
  version: string;
  uname: string;
  cwd: string;
  yamlPath: string | null;
  yamlRedacted: string | null;
  daemonAlive: boolean;
  daemonLog: string | null;
  gitBranch: string | null;
  insideGitWorktree: boolean;
}

async function gatherContext(cwd: string): Promise<FeedbackContext> {
  const yamlPath = findLichYaml(cwd);
  let yamlRedacted: string | null = null;
  if (yamlPath !== null) {
    try {
      const raw = readFileSync(yamlPath, "utf8");
      yamlRedacted = redactEnvFromCmds(raw);
    } catch {
      yamlRedacted = null;
    }
  }

  const daemonAlive = await isDaemonAlive().catch(() => false);
  const daemonLog = daemonAlive ? readDaemonLogTail() : null;

  const git = probeGit(cwd);

  return {
    version: VERSION,
    uname: probeUname(),
    cwd,
    yamlPath,
    yamlRedacted,
    daemonAlive,
    daemonLog,
    gitBranch: git.branch,
    insideGitWorktree: git.insideWorktree,
  };
}

function findLichYaml(cwd: string): string | null {
  const direct = join(cwd, "lich.yaml");
  return existsSync(direct) ? direct : null;
}

function probeUname(): string {
  const result = spawnSync("uname", ["-sm"], { encoding: "utf8" });
  if (result.error || typeof result.status !== "number" || result.status !== 0) {
    return `${process.platform} ${process.arch}`;
  }
  return result.stdout.trim();
}

function probeGit(cwd: string): { branch: string | null; insideWorktree: boolean } {
  // Stderr silenced — running outside a repo is common, not an error.
  const probe = spawnSync(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (
    probe.error ||
    typeof probe.status !== "number" ||
    probe.status !== 0 ||
    probe.stdout.trim() !== "true"
  ) {
    return { branch: null, insideWorktree: false };
  }

  const branchProbe = spawnSync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (
    branchProbe.error ||
    typeof branchProbe.status !== "number" ||
    branchProbe.status !== 0
  ) {
    return { branch: null, insideWorktree: true };
  }
  return { branch: branchProbe.stdout.trim() || null, insideWorktree: true };
}

/**
 * Last ~100 lines of the daemon log. Forward-looking: the daemon currently
 * spawns with `stdio: "ignore"` so the file's typically absent.
 */
function readDaemonLogTail(): string | null {
  const path = resolveDaemonLogPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    const tail = lines.slice(Math.max(0, lines.length - 100));
    return tail.join("\n");
  } catch {
    return null;
  }
}

function resolveDaemonLogPath(): string {
  const home =
    process.env.LICH_HOME && process.env.LICH_HOME.length > 0
      ? process.env.LICH_HOME
      : join(homedir(), ".lich");
  return join(home, "daemon.log");
}

/**
 * PRIVACY: redact `cmd: ...` values under `env_from:` blocks before the
 * yaml is included in feedback payloads. These cmds typically shell out to
 * secret managers (`infisical run --command "printenv"`) and could leak
 * tokens/credentials.
 *
 * Operates on raw yaml text (not parsed AST) so the user sees their actual
 * file content minus the secret values. Tracks the most recent `env_from:`
 * by indent; any deeper `cmd:` key has its value replaced with `<redacted>`.
 * Block scalars (`cmd: |` / `cmd: >`) get the value AND the indented block
 * stripped. Exported for unit tests.
 */
export function redactEnvFromCmds(yaml: string): string {
  const lines = yaml.split("\n");
  const out: string[] = [];

  // -1 = not currently inside an env_from block.
  let envFromIndent = -1;
  // > -1 = swallowing a redacted block-scalar at this indent.
  let redactedBlockIndent = -1;

  for (const line of lines) {
    const indent = leadingSpaces(line);
    const trimmed = line.trimStart();

    if (redactedBlockIndent > -1) {
      if (trimmed.length === 0) continue;
      if (indent > redactedBlockIndent) continue;
      redactedBlockIndent = -1;
    }

    if (/^env_from\s*:/.test(trimmed)) {
      envFromIndent = indent;
      out.push(line);
      continue;
    }

    if (envFromIndent > -1 && indent <= envFromIndent && trimmed.length > 0) {
      envFromIndent = -1;
    }

    if (envFromIndent > -1 && indent > envFromIndent) {
      // Redact both scalar and block-scalar `cmd:` forms.
      const cmdMatch = trimmed.match(/^(-\s+)?cmd\s*:\s*(\|[-+]?|>[-+]?)?(.*)$/);
      if (cmdMatch) {
        const dashPrefix = cmdMatch[1] ?? "";
        const blockMarker = cmdMatch[2];
        if (blockMarker) {
          // Swallow the indented block that follows.
          out.push(
            `${" ".repeat(indent)}${dashPrefix}cmd: <redacted>`,
          );
          redactedBlockIndent = indent;
          continue;
        }
        out.push(
          `${" ".repeat(indent)}${dashPrefix}cmd: <redacted>`,
        );
        continue;
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 0x20) n += 1;
  return n;
}

function assemblePayload(opts: {
  body: string;
  context: FeedbackContext | null;
}): string {
  const sections: string[] = [];

  sections.push("## Message");
  sections.push("");
  sections.push(opts.body.trim());

  if (opts.context !== null) {
    sections.push("");
    sections.push("## Environment");
    sections.push("");
    sections.push(`- lich version: ${opts.context.version}`);
    sections.push(`- platform: ${opts.context.uname}`);
    sections.push(`- cwd: ${opts.context.cwd}`);
    sections.push(
      `- lich.yaml: ${opts.context.yamlPath !== null ? "present" : "absent"}`,
    );
    if (opts.context.insideGitWorktree) {
      sections.push(
        `- git branch: ${opts.context.gitBranch ?? "(detached HEAD)"}`,
      );
    } else {
      sections.push("- git branch: (not inside a git worktree)");
    }
    sections.push(
      `- daemon: ${opts.context.daemonAlive ? "running" : "not running"}`,
    );

    if (opts.context.yamlRedacted !== null) {
      sections.push("");
      sections.push("## lich.yaml (env_from cmd: values redacted)");
      sections.push("");
      sections.push("```yaml");
      sections.push(opts.context.yamlRedacted.replace(/\n+$/, ""));
      sections.push("```");
    }

    if (opts.context.daemonLog !== null) {
      sections.push("");
      sections.push("## Daemon log (last 100 lines)");
      sections.push("");
      sections.push("```");
      sections.push(opts.context.daemonLog.replace(/\n+$/, ""));
      sections.push("```");
    }
  }

  return sections.join("\n") + "\n";
}

function renderCurlCommand(opts: { payload: string; body: string }): string {
  const title = firstLine(opts.body) || "feedback";
  return [
    `curl -X POST https://api.github.com/repos/RPate97/lich/issues \\`,
    `  -H 'Accept: application/vnd.github+json' \\`,
    `  -H 'Authorization: Bearer <GITHUB_TOKEN>' \\`,
    `  -d ${shellQuote(JSON.stringify({ title: `feedback: ${title.slice(0, 80)}`, body: opts.payload }))}`,
    "",
    "(Set GITHUB_TOKEN to a token with `repo:public_repo` scope, or open",
    "https://github.com/RPate97/lich/issues/new and paste the payload above.)",
  ].join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const idx = trimmed.indexOf("\n");
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

async function cachePayload(
  payload: string,
  cacheDirOverride: string | undefined,
): Promise<string> {
  const dir =
    cacheDirOverride && cacheDirOverride.length > 0
      ? cacheDirOverride
      : defaultCacheDir();
  await mkdir(dir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("Z", "Z");
  const path = join(dir, `${stamp}.md`);
  await writeFile(path, payload, "utf8");
  return path;
}

function defaultCacheDir(): string {
  const home =
    process.env.LICH_HOME && process.env.LICH_HOME.length > 0
      ? process.env.LICH_HOME
      : join(homedir(), ".lich");
  return join(home, "feedback");
}

async function confirm(
  out: NodeJS.WritableStream,
  stdin: NodeJS.ReadableStream,
): Promise<boolean> {
  out.write("Submit this feedback? [y/N] ");
  const rl = createInterface({ input: stdin, output: out, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      let resolved = false;
      const settle = (value: string): void => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };
      rl.once("line", (line: string) => settle(line));
      rl.once("close", () => settle(""));
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

function isTTY(stdin: NodeJS.ReadableStream): boolean {
  return Boolean(
    (stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY,
  );
}
