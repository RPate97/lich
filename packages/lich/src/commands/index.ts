import mri from "mri";
import { runInitSync } from "./init.js";

type StubResult = { ok: boolean; message: string };

function stub(name: string): () => StubResult {
  return () => ({ ok: false, message: `'lich ${name}' is not yet implemented` });
}

function initEntry(): StubResult {
  // Re-parse argv for init-specific flags; the top-level dispatcher in
  // bin/lich.ts only knows about --version/--help. Keeps the COMMANDS map
  // signature unchanged.
  const argv = mri(process.argv.slice(2), {
    boolean: ["force", "no-gitignore"],
  });
  const result = runInitSync(
    { force: !!argv.force, noGitignore: !!argv["no-gitignore"] },
    process.cwd()
  );
  return { ok: result.exitCode === 0, message: result.messages.join("\n") };
}

export const COMMANDS = {
  up: stub("up"),
  down: stub("down"),
  logs: stub("logs"),
  urls: stub("urls"),
  stacks: stub("stacks"),
  restart: stub("restart"),
  nuke: stub("nuke"),
  init: initEntry,
  validate: stub("validate"),
  help: stub("help"),
  exec: stub("exec"),
  env: stub("env"),
} as const;

export type CommandName = keyof typeof COMMANDS;

export function isCommand(name: string): name is CommandName {
  return name in COMMANDS;
}
