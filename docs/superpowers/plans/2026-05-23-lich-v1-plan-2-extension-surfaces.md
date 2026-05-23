# Lich v1 — Plan 2: Extension Surfaces

> **Status:** HIGH-LEVEL SHELL — task structure captured; per-task code/steps to be refined when this plan is ready to execute.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 1 ("standard CLI for your stack"), 4 (env_groups + commands), 5 (lich help / exec / env))

**Required reading:** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`

**Goal:** Upgrade lich from "stack runner" to "the standard CLI for your stack." Add named env_groups, user-defined commands, and the three discovery/ad-hoc CLI surfaces: `lich help`, `lich exec`, `lich env`. By end of plan, the dogfood-stack defines at least one user command that runs against the live stack, and `lich help` lists it.

**Builds on:** Plan 1 (env resolution pipeline must exist; CLI dispatcher must exist).

**Architecture:** `env_groups` is a separate resolver that reuses the env pipeline from Plan 1 with a layering control. User-defined commands dispatch through the same CLI router that built-ins use, with built-ins winning on name collision. `lich exec` and `lich env` are first-class built-in commands that resolve a named group and either exec a child process with that env or print the env as dotenv.

---

## What this plan implements

From the spec section 4:

- **`env_groups`** top-level config section
- Built-in `stack` group (auto-populated from top-level env resolution from Plan 1)
- User-defined groups with `env_from`, `env`, `extends`, `process_env`
- `extends` chain resolution with cycle detection
- Default isolation: groups do NOT include stack unless `extends: stack` explicitly

From the spec section 4:

- **`commands`** top-level config section
- Per-command `cmd`, `cwd`, `env_group`, `env`, `help`
- Argv forwarding (extra args appended to cmd)
- `--env-group=<name>` flag override

From the spec section 5:

- **`lich <user-command>`** invocation (top-level namespace shared with built-ins; conflict detection)
- **`lich help [command]`** — list all commands with summaries; per-command help text
- **`lich exec [--env-group=X] <cmd>`** — ad-hoc command runner with group env
- **`lich env <group>`** — print resolved env as dotenv (for shell sourcing)

From the spec section 5 (validate):

- `lich validate` gains env_group reference checking, extends cycle detection, built-in shadowing refusal

---

## Subsystems introduced

### `groups/`

`env_groups` resolver. Takes a group name, walks the `extends` chain (with cycle detection), composes `env_from` + `env` layered on top of process.env (or not, based on `process_env`). Returns the resolved env map.

- `resolve.ts` — main resolver
- `validate-extends.ts` — cycle detection over the extends graph

### `commands/dispatch.ts`

User-command dispatcher. Resolves the command by name (built-in first, then user-defined), resolves the env group, builds the final env, appends extra argv, execs as child process.

The existing `commands/` directory from Plan 1 gets two new built-in commands (`help.ts`, `exec.ts`, `env.ts`) and a dispatch layer that fans out to user-defined commands.

### `config/schema.ts` (extended)

JSON Schema gains `env_groups` and `commands` top-level sections, with all their sub-fields.

### `config/validate.ts` (extended)

New checks:
- `env_group` references in commands resolve to a declared group
- `extends` chains in env_groups don't cycle
- User commands don't shadow built-in names (`up`, `down`, `logs`, `urls`, `stacks`, `restart`, `nuke`, `init`, `validate`, `help`, `exec`, `env`)

---

## File structure delta

```
packages/lich/src/
  groups/
    resolve.ts
    validate-extends.ts
  commands/
    dispatch.ts                  # user-command dispatcher
    help.ts                      # NEW built-in
    exec.ts                      # NEW built-in
    env.ts                       # NEW built-in
  config/
    schema.ts                    # extended for env_groups + commands
    validate.ts                  # extended for group/command checks

packages/lich/tests/unit/
  groups/
  commands/
  config/

tests/e2e/
  commands.test.ts               # user-defined command works
  exec.test.ts                   # lich exec runs with group env
  env-groups.test.ts             # isolation, extends, process_env
  help.test.ts                   # help lists user commands

examples/dogfood-stack/lich.yaml  # MODIFY — add at least one commands entry and one env_group
```

---

## Task list (high-level)

1. **Extend JSON Schema** for `env_groups` and `commands` (subset for this plan)
2. **`env_groups` resolver** with extends chain + cycle detection + process_env handling
3. **Built-in `stack` group** wiring — assemble from Plan 1's resolved top-level env
4. **`commands` schema parsing** — validate command names against built-in shadowing
5. **User-command dispatcher** — extend CLI router to fall through to user commands; argv forwarding
6. **`lich help`** — list all commands (built-in + user-defined); per-command help text
7. **`lich exec`** — arbitrary command runner with `--env-group` flag
8. **`lich env <group>`** — dotenv output for shell sourcing
9. **`lich validate` checks** — env_group references, extends cycles, command shadowing
10. **Update `examples/dogfood-stack/lich.yaml`** — define one env_group + one user command (e.g. a `test:e2e` placeholder or `db:psql`)
11. **E2e tests** per the testing standards floor

---

## Cross-plan dependencies

- All of Plan 1 must be done. Plan 2 cannot start before Plan 1 ships.
- Specifically: env resolution pipeline (P1.13) and CLI dispatcher (P1's commands/) are the load-bearing dependencies.

---

## Testing requirements

Per testing standards, every feature needs both unit and e2e tests.

E2e coverage floor for this plan:

- **User-defined command invocable as `lich <name>`** — define in dogfood-stack yaml, invoke, assert correct stdout/exit and that the env was loaded.
- **Argv forwarding** — `lich test:e2e --filter foo` reaches the underlying cmd with `--filter foo` appended.
- **`--env-group=X` override** — invoke same command with different group, verify env differs.
- **`lich exec <cmd>`** — `lich exec sh -c 'echo $DATABASE_URL'` prints the expected resolved URL from the `stack` group.
- **`lich env <group>`** — output is dotenv format and `source`able in a shell test.
- **`lich help`** — lists built-in and user-defined commands with summaries.
- **`lich help <user-cmd>`** — shows the user's `help:` text verbatim.
- **`process_env: false` isolation** — set a shell env var, verify it does NOT appear in `lich env <group>` output for an isolated group.
- **`extends: stack`** — a derived group includes stack env.
- **Standalone group** — a group without `extends: stack` does NOT include stack env.
- **Validate failure cases** — group references that don't resolve, extends cycles, commands shadowing built-ins.

---

## Acceptance criteria

Plan 2 is done when:

- `examples/dogfood-stack/lich.yaml` defines at least one `env_groups` entry and one `commands` entry
- `lich help` from inside the dogfood-stack lists the user command
- `lich <user-command>` invokes it correctly with the resolved group env
- `lich exec pnpm prisma studio` (or equivalent for the dogfood-stack's stack) runs against the live stack with `DATABASE_URL` correctly set
- `lich env stack` prints dotenv that includes the worktree's allocated postgres URL
- `lich validate` catches: nonexistent env_group reference, extends cycle, user command shadowing built-in
- All Plan 2 e2e tests pass
