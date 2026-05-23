type StubResult = { ok: boolean; message: string };

function stub(name: string): () => StubResult {
  return () => ({ ok: false, message: `'lich ${name}' is not yet implemented` });
}

export const COMMANDS = {
  up: stub("up"),
  down: stub("down"),
  logs: stub("logs"),
  urls: stub("urls"),
  stacks: stub("stacks"),
  restart: stub("restart"),
  nuke: stub("nuke"),
  init: stub("init"),
  validate: stub("validate"),
  help: stub("help"),
  exec: stub("exec"),
  env: stub("env"),
} as const;

export type CommandName = keyof typeof COMMANDS;

export function isCommand(name: string): name is CommandName {
  return name in COMMANDS;
}
