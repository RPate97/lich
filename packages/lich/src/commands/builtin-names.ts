// Standalone module to break a cycle between commands/index.ts and commands/validate.ts.
export const BUILTIN_COMMAND_NAMES = [
  "up",
  "down",
  "logs",
  "urls",
  "stacks",
  "restart",
  "nuke",
  "init",
  "validate",
  "help",
  "exec",
  "env",
  "routing",
] as const;

export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];
