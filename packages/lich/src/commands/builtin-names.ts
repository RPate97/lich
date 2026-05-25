/**
 * The canonical list of lich's built-in command names.
 *
 * This constant exists as a tiny standalone module to avoid ESM circular
 * imports between `commands/index.ts` (which wires the handler map and
 * imports `runValidate` from `commands/validate.ts`) and
 * `commands/validate.ts` (which needs to refuse user-defined commands that
 * shadow a built-in). Importing `COMMANDS` directly from `index.ts` inside
 * `validate.ts` would create a cycle that leaves `COMMANDS` undefined
 * during module init in some test environments.
 *
 * Keep this list in sync with the `COMMANDS` map in `commands/index.ts`.
 * The `index.ts` module imports this constant and asserts (at module load)
 * that every name here has a registered handler, so a missing handler
 * fails fast rather than silently mismatching.
 */
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
  // LEV-480: `lich routing` prints the daemon's in-memory routing table.
  // Diagnostic command for the friendly-URL reverse proxy — when a
  // friendly URL 404s, this is the first thing to run.
  "routing",
] as const;

export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];
