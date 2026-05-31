// Standalone to break the index.ts ↔ validate.ts cycle.
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
  "exec",
  "env",
  "routing",
  "dashboard",
  "feedback",
  "sandbox",
] as const;

export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];
