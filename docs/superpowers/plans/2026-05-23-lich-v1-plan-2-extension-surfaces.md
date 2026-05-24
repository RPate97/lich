# Lich v1 — Plan 2: Extension Surfaces

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 1 "standard CLI for your stack", 4 `env_groups` + `commands`, 5 `lich help` / `lich exec` / `lich env`)

**Required reading (every subagent on every task):** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md` — every feature needs BOTH unit and e2e tests; e2e tests spawn the real binary against `examples/dogfood-stack/`.

**Goal:** Upgrade lich from "stack runner" to "the standard CLI for your stack." Add named `env_groups`, user-defined `commands`, and the three discovery/ad-hoc CLI surfaces: `lich help`, `lich exec`, `lich env`. By end of plan, the dogfood-stack defines at least one user command that runs against the live stack, `lich help` lists it, and the `env_group:` long-form lifecycle entries from Plan 1 actually resolve.

**Builds on:** Plan 1 (`env/resolve.ts` pipeline, `lifecycle/executor.ts`'s already-defined `resolveEnvGroup` hook, `commands/index.ts` router, `worktree/detect.ts`, `state/snapshot.ts`).

**Architecture:** `env_groups` is a separate resolver under `src/groups/` that builds on the env pipeline from Plan 1. The built-in `stack` group reuses `resolveTopLevelEnv` from Plan 1 verbatim — it's the same env the stack runs with. User-defined groups are resolved fresh (default-isolated; do NOT include stack unless `extends: stack`). User-defined commands extend the CLI router with a fall-through path that activates when an unknown built-in name happens to be a declared user command; the router itself stays minimal. `lich exec` and `lich env` are first-class built-in commands that share the `env_groups` resolver. The Plan-1 lifecycle executor's `resolveEnvGroup` callback finally gets a real implementation wired in `commands/up.ts`.

**Tech stack:** Same as Plan 1 (TypeScript on Bun, vitest, ajv, yaml). No new runtime dependencies.

---

## What this plan implements

From spec section 4 (`env_groups`):

- **`env_groups`** top-level config section
- Built-in `stack` group (auto-populated from Plan 1's `resolveTopLevelEnv`)
- User-defined groups with `env_from`, `env`, `extends`, `process_env`
- `extends` chain resolution with cycle detection
- Default isolation: user-defined groups do NOT include `stack` unless `extends: stack` explicitly

From spec section 4 (`commands`):

- **`commands`** top-level config section
- Per-command `cmd`, `cwd`, `env_group` (default `"stack"`), `env`, `help`
- Argv forwarding (extra argv appended to underlying cmd)
- Universal `--env-group=<name>` flag override

From spec section 5:

- **`lich <user-command>`** invocation (built-ins win on conflict)
- **`lich help [command]`** — list all commands grouped by source (built-in / user); per-command help text
- **`lich exec [--env-group=<g>] <cmd>...`** — ad-hoc command runner with group env (default `stack`)
- **`lich env <group>`** — print resolved env as dotenv-format (for shell `source <(lich env stack)`)

From spec section 5 (validate):

- `lich validate` learns: `env_group` reference checking, `env_groups.X.extends` cycle detection, refusal of user commands that shadow built-ins, refusal of `lich validate` running with `lifecycle.*.env_group` pointing at an unknown group, and "did you mean" suggestions for typos in group names.

Plan 1 wired `resolveEnvGroup` into both `lifecycle/executor.ts` and `lifecycle/per-service.ts`, but currently throws "env_group not supported in Plan 1; provide resolveEnvGroup in Plan 2+" when invoked. This plan makes those calls work.

---

## Subsystems introduced

### `src/groups/`

`env_groups` resolver. Pure-logic where possible; I/O-heavy steps reuse `env/shell-out.ts` and `env/files.ts` from Plan 1.

- `resolve.ts` — given a group name + config + worktree + allocated-ports context, walk the `extends` chain, layer `env_from` + `env_files` + `env` on top of (optionally) process.env and (optionally) the `stack` group, run interpolation, return the resolved env map.
- `validate-extends.ts` — pure cycle detection over the extends graph (mirrors `deps/sort.ts`'s `topoLevels` shape so error messages look familiar).
- `built-in-stack.ts` — adapter that calls `resolveTopLevelEnv` from `env/resolve.ts` and packages the result as a "group-shaped" env map.

### `src/commands/dispatch.ts`

User-command dispatcher. Given the parsed argv, a loaded config, and a worktree+ports context, it: validates the command name resolves to a user-declared entry, resolves the requested env_group (default `"stack"`), merges per-command env overrides, appends extra argv to the underlying cmd string, and execs via `/bin/sh -c <cmd> "$@"`. Process inherits stdio so user-command stdout/stderr stream straight to the terminal.

### Two new built-in commands (`help`, `exec`, `env`)

The existing `commands/index.ts` already lists `help`, `exec`, `env` as stubs. Plan 2 replaces those stubs with real handlers:

- `commands/help.ts` — discovery surface.
- `commands/exec.ts` — `lich exec [--env-group=X] <cmd>...`.
- `commands/env.ts` — `lich env <group>`.

### `src/config/schema.ts` + `src/config/types.ts` (extended)

Currently both files type `env_groups` and `commands` as `Record<string, unknown>` accept-as-opaque placeholders. Plan 2 lifts them to fully-typed shapes.

### `src/commands/validate.ts` (extended)

New checks: group `extends` cycles, group references from `commands.*.env_group`, group references from `lifecycle.*.env_group` (both top-level and per-service), refusal of user commands whose name shadows a built-in.

### `src/commands/up.ts` (extended — one-line change)

Pass a real `resolveEnvGroup` callback into `runLifecycle` and `runPerServiceLifecycle` so the long-form `{ cmd, env_group }` entries Plan 1 already supports actually work.

### `src/bin/lich.ts` (extended)

The dispatcher currently exits 2 with "unknown command" when `commandName` isn't in `COMMANDS`. Plan 2 inserts a fallback path: if the name isn't a built-in but IS declared in the loaded config's `commands:` section, dispatch through `commands/dispatch.ts`. Built-ins keep winning on collision (validate refuses configs that shadow built-ins, so this can never collide in practice).

---

## File structure delta

```
packages/lich/src/
  groups/                              # NEW directory
    resolve.ts                         # NEW
    validate-extends.ts                # NEW
    built-in-stack.ts                  # NEW
  commands/
    dispatch.ts                        # NEW (user-command dispatcher)
    help.ts                            # NEW (replaces stub in commands/index.ts)
    exec.ts                            # NEW (replaces stub)
    env.ts                             # NEW (replaces stub)
    index.ts                           # MODIFY: wire help/exec/env handlers
    validate.ts                        # MODIFY: extends-cycle, env_group ref,
                                       #         built-in shadowing checks
    up.ts                              # MODIFY: pass real resolveEnvGroup
  config/
    schema.ts                          # MODIFY: tighten env_groups + commands
    types.ts                           # MODIFY: replace opaque placeholders
  bin/
    lich.ts                            # MODIFY: fall through to dispatch.ts
                                       #         on unknown built-in

packages/lich/tests/unit/
  groups/                              # NEW directory
    resolve.test.ts                    # NEW
    validate-extends.test.ts           # NEW
    built-in-stack.test.ts             # NEW
  commands/
    dispatch.test.ts                   # NEW
    help.test.ts                       # NEW
    exec.test.ts                       # NEW
    env.test.ts                        # NEW
    validate.test.ts                   # MODIFY: extends new cases for
                                       #         shadowing, group refs
  config/
    schema.test.ts                     # MODIFY: add cases for env_groups +
                                       #         commands shapes

tests/e2e/
  commands-user-defined.test.ts        # NEW
  exec.test.ts                         # NEW
  env-dotenv.test.ts                   # NEW
  env-groups-isolation.test.ts         # NEW
  help.test.ts                         # NEW
  validate-plan2-errors.test.ts        # NEW

examples/dogfood-stack/
  lich.yaml                            # MODIFY: add ≥1 env_groups entry
                                       #         (extends + isolation); keep
                                       #         existing commands; add one
                                       #         command that uses a group
```

The current dogfood `lich.yaml` already declares `commands: { test:e2e, db:psql }` and currently validates because the schema accepts them opaquely. Plan 2 will keep both, add one new entry that exercises `env_group:`, and add an `env_groups:` section with one isolated and one stack-extending group.

---

## Task list

Order roughly matches build dependencies. Each task is a coherent commit (~30-90 min). Many can run in parallel under an orchestrator once their inputs land. Tasks 1-3 are foundation; 4-8 build the resolver; 9-13 build dispatch and built-in commands; 14-17 wire validation; 18 integrates Plan 1's lifecycle hook; 19-21 update dogfood; 22-29 add e2e coverage.

---

## Task 1: Tighten `env_groups` and `commands` types

**Dependencies:** none (purely type-level).

**Files to create/modify:**
- Modify: `packages/lich/src/config/types.ts`

**Acceptance criteria:**
- `LichConfig.env_groups` becomes `Record<string, EnvGroupDef> | undefined`.
- `LichConfig.commands` becomes `Record<string, UserCommandDef> | undefined`.
- `EnvGroupDef` interface exports: `env_from?: EnvFrom`, `env?: EnvMap`, `extends?: string`, `process_env?: boolean`.
- `UserCommandDef` interface exports: `cmd: string` (required), `cwd?: string`, `env_group?: string`, `env?: EnvMap`, `help?: string`.
- Existing import sites still compile (the placeholders were `Record<string, unknown>`; new shapes are strict subsets of object-keyed records, but consumer code that reached into them as `unknown` may need explicit casts — fix them).

**Tests to write:**
- No new unit-test file (pure types); the type tightening is exercised via existing test files compiling.

**Implementation notes:**
- Mirror the naming convention already established in `types.ts`: `EnvGroupDef` and `UserCommandDef` (singular Def, matching `OwnedService` / `ComposeService` style).
- Keep `extends` typed as `string | undefined` only — the spec's later mention of "list of names" is profile-specific, not env_groups (env_groups only support single-string extends; see spec section 4 env_groups subsection).
- Add a JSDoc note on `process_env` defaulting to `true` so the schema and the resolver agree.
- Place new exports immediately after the existing `Runtime` interface for grep-ability.

---

## Task 2: Extend JSON Schema for `env_groups`

**Dependencies:** Task 1.

**Files to create/modify:**
- Modify: `packages/lich/src/config/schema.ts`

**Acceptance criteria:**
- `env_groups` is now a strict object: keys are group names (strings), values match a new `envGroupSchema`.
- `envGroupSchema` permits `env_from` (reuses `envFromSchema`), `env` (reuses `envMapSchema`), `extends` (string), `process_env` (boolean). `additionalProperties: false`.
- Group name `stack` is rejected at parse time (built-in; cannot be redeclared) — emit a schema-level `not` constraint that explicitly forbids the property name `stack` under `env_groups`.
- Existing dogfood `lich.yaml` (which has no `env_groups`) still validates.
- A new minimal config with `env_groups: { foo: { env: { A: "1" } } }` validates.
- A config with `env_groups: { stack: { ... } }` fails validation with a useful error.

**Tests to write:**
- Modify `packages/lich/tests/unit/config/schema.test.ts`:
  - `"validates a config with one user-defined env_group"`
  - `"rejects env_groups.stack as a reserved name"`
  - `"rejects unknown property inside an env_group entry"`

**Implementation notes:**
- The forbid-`stack` constraint at the schema level avoids a runtime check later. Encode as `"propertyNames": { "not": { "const": "stack" } }` on the `env_groups` object.
- Reuse existing `envFromSchema` and `envMapSchema` constants verbatim — these were exported at file scope for exactly this kind of layering.
- Don't strip the existing `env_groups: { type: "object", additionalProperties: true }` placeholder — replace it with the strict shape.

---

## Task 3: Extend JSON Schema for `commands`

**Dependencies:** Task 1.

**Files to create/modify:**
- Modify: `packages/lich/src/config/schema.ts`

**Acceptance criteria:**
- `commands` is now a strict object: keys are command names (strings), values match a new `userCommandSchema`.
- `userCommandSchema` requires `cmd: string`; permits `cwd: string`, `env_group: string`, `env: envMapSchema`, `help: string`. `additionalProperties: false`.
- Existing dogfood `lich.yaml` (which has `commands: { test:e2e, db:psql }`) still validates.
- A new minimal config with `commands: { foo: { cmd: "echo hi", help: "say hi" } }` validates.
- A config with `commands: { bad: { cwd: "x" } }` (missing required `cmd`) fails validation.

**Tests to write:**
- Modify `packages/lich/tests/unit/config/schema.test.ts`:
  - `"validates a config with one user-defined command"`
  - `"requires cmd on every user-defined command"`
  - `"rejects unknown property inside a user-defined command"`

**Implementation notes:**
- The schema does NOT enforce "command name cannot shadow a built-in" here — that's a `lich validate` reference check (Task 17), because the list of built-ins lives in `commands/index.ts` and schemas shouldn't import from sibling modules.
- Command names containing `:` or `/` are common (`test:e2e`, `db/psql`) — don't add a regex constraint on the property name.
- After this task, ALL of the Plan 2 schema work is complete; the existing dogfood yaml still validates because its `commands:` entries already conform to the new strict shape.

---

## Task 4: `env_groups` extends-cycle detector (`groups/validate-extends.ts`)

**Dependencies:** Task 1.

**Files to create/modify:**
- Create: `packages/lich/src/groups/validate-extends.ts`

**Acceptance criteria:**
- Exports `detectExtendsCycle(groups: Record<string, EnvGroupDef>): null | { cycle: string[] }`.
- Returns `null` when the extends graph is acyclic (including the empty case).
- Returns `{ cycle: [...] }` listing the cycle in walk order when one exists. The cycle is reported once (no duplicate detection of the same cycle from different entry points).
- Treats `extends: "stack"` as a leaf reference (the built-in `stack` group exists and cannot extend anything) — does NOT report it as a cycle even if a user group is itself named `nonsense`. The built-in `stack` is the terminating node.
- Does NOT itself check whether `extends` references resolve to a declared group — that's the `resolve.ts` resolver's job. Cycle detection runs first because a cycle would cause infinite recursion in `resolve.ts`.

**Tests to write:**
- Create `packages/lich/tests/unit/groups/validate-extends.test.ts`:
  - `"returns null for an empty groups map"`
  - `"returns null for a single non-extending group"`
  - `"returns null when extends terminates at the built-in stack"`
  - `"returns null for a 3-node chain a -> b -> c"`
  - `"detects a 2-node cycle a -> b -> a"`
  - `"detects a 3-node cycle a -> b -> c -> a"`
  - `"detects a self-loop a -> a"`
  - `"reports the cycle nodes in walk order"`

**Implementation notes:**
- Use the classic three-color DFS (WHITE → GRAY → BLACK). When the walk visits a GRAY node, the active path slice from that node to the current node IS the cycle.
- Mirror the error shape (`{ cycle: string[] }`) used by `deps/sort.ts`'s `CycleError.cycle` so downstream consumers see a familiar shape.
- This is a pure function with no I/O — keep it ≤80 lines.

---

## Task 5: `env_groups` resolver core (`groups/resolve.ts`)

**Dependencies:** Tasks 1, 4.

**Files to create/modify:**
- Create: `packages/lich/src/groups/resolve.ts`

**Acceptance criteria:**
- Exports `resolveEnvGroup(input: ResolveEnvGroupInput): Promise<Record<string, string>>`.
- `ResolveEnvGroupInput` carries: `name` (group name to resolve), `config` (LichConfig), `worktree` (Worktree), `allocatedPorts` (AllocatedPorts), `projectRoot` (string), `processEnv` (optional override; defaults to `process.env`).
- For `name === "stack"`: delegates to `built-in-stack.ts` (Task 6) and returns its result.
- For a user-defined group:
  1. If the group declares `extends`, resolve the parent first (recursively).
  2. If `process_env` is `true` (default) AND we're at the *outermost* call (no parent), overlay `processEnv`. If `extends` was used, the parent's resolution already handled it — do NOT double-overlay.
  3. Apply the group's `env_from` entries (shell-out via `env/shell-out.ts`).
  4. Apply the group's `env` literals (coerced to strings).
  5. Interpolate every value against the runtime context (worktree + allocated ports) — same `interpolateRecord` call site Plan 1's env resolver uses.
- Throws a `GroupResolveError` (new exported class) if `name` doesn't exist in `config.env_groups` and isn't `"stack"`. Message includes the name and a "did you mean" suggestion when an existing group is within Levenshtein 2.
- Cycle protection: call `detectExtendsCycle` (Task 4) once before recursive walking; throw `GroupCycleError` if a cycle is present. (Validation would normally catch this earlier via `lich validate`, but the resolver guards against unvalidated configs reaching it.)

**Tests to write:**
- Create `packages/lich/tests/unit/groups/resolve.test.ts`:
  - `"resolves the built-in stack group via resolveTopLevelEnv"` — use a fake config with one env var, assert the resolved map contains it.
  - `"resolves a user-defined group with only literal env"`
  - `"applies extends: parent vars present, child overrides parent on key collision"`
  - `"groups without extends do NOT include stack vars"` — declare a top-level `env: { TOP: 'A' }` and a `env_groups.foo: { env: { B: 'b' } }`; resolve `foo`; assert `TOP` is absent.
  - `"extends: stack explicitly includes stack vars"`
  - `"process_env: false blocks shell env passthrough"` — pass `processEnv: { LEAK: 'oops' }`; assert `LEAK` is absent from a group with `process_env: false`.
  - `"process_env: true (default) overlays shell env at the outermost call"` — opposite assertion.
  - `"process_env is honored at the outermost call only when extends terminates"` — a group with `extends: stack` and `process_env: false` should still NOT leak shell env; verify by setting an env var the parent doesn't define.
  - `"interpolates ${owned.X.port} in env values"` — assert a value like `"${owned.api.port}"` becomes the allocated port string.
  - `"throws GroupResolveError with suggestion when name typo"` — request `"infisical-prdo"`, assert error mentions `infisical-prod`.
  - `"throws GroupCycleError when extends has a cycle"`

**Implementation notes:**
- Reuse `loadEnvFromShellOut` from `env/shell-out.ts` and `interpolateRecord` from `config/interpolation.ts` verbatim — no new abstractions.
- The "process_env overlay only at outermost call" rule comes from spec section 4: precedence is `process.env → env_from → env_files → env literals → child overrides`. When a child group has `process_env: false`, the spec says "block shell env passthrough" — interpret as "do not overlay process_env at the outermost call of THIS resolution", but a parent with `process_env: true` still gets its own overlay during the parent's resolution. Tests above pin this exact semantics.
- The spec's section 4 env_groups text says `env_files` is NOT a field on env_groups — only `env_from`, `env`, `extends`, `process_env`. Do NOT support `env_files` here even though it'd be a small addition; the spec is intentional about this (env_files belongs to stack composition, not standalone groups).
- The Levenshtein helper already exists at the bottom of `commands/validate.ts`. Either duplicate it inline (~25 LOC; the file says "see CLEANUP-HINTS.md") OR extract to a shared util. **Decision: duplicate inline this turn**. Avoid cross-module reach for a small helper; revisit when a third caller appears.

---

## Task 6: Built-in `stack` group adapter (`groups/built-in-stack.ts`)

**Dependencies:** none (uses Plan 1's `resolveTopLevelEnv` directly).

**Files to create/modify:**
- Create: `packages/lich/src/groups/built-in-stack.ts`

**Acceptance criteria:**
- Exports `resolveStackGroup(input: ResolveStackGroupInput): Promise<Record<string, string>>`.
- `ResolveStackGroupInput` matches the input shape `resolveTopLevelEnv` from Plan 1's `env/resolve.ts` expects, minus the `service` discriminator: `config`, `worktree`, `allocatedPorts`, `projectRoot`, `processEnv?`.
- Internally calls `resolveTopLevelEnv` and returns its result unchanged.
- Includes a JSDoc note explaining WHY this thin adapter exists: it gives `groups/resolve.ts` a uniform "resolve a group by name" surface (`stack` is a name like any other, just hardcoded to map to the top-level env). Inlining the call would couple `groups/resolve.ts` to `env/resolve.ts`'s exact shape; the adapter keeps the dependency one-way.

**Tests to write:**
- Create `packages/lich/tests/unit/groups/built-in-stack.test.ts`:
  - `"returns the same env that resolveTopLevelEnv produces for a top-level env literal"`
  - `"includes auto-injected LICH_WORKTREE and LICH_STACK_ID"` — verify these survive the adapter.
  - `"interpolates ${owned.X.port} against the allocated-ports context"`

**Implementation notes:**
- This file is ~30 LOC. Resist the temptation to add features here — the value is the separation of concerns.
- Do not re-export `Worktree` or `AllocatedPorts`; consumers should import them from their original modules.

---

## Task 7: User-command dispatcher (`commands/dispatch.ts`)

**Dependencies:** Tasks 1, 5, 6.

**Files to create/modify:**
- Create: `packages/lich/src/commands/dispatch.ts`

**Acceptance criteria:**
- Exports `dispatchUserCommand(input: DispatchInput): Promise<DispatchResult>`.
- `DispatchInput` carries: `name` (the unknown-to-built-ins name from argv), `extraArgv` (the positionals and flags after the name, already parsed by mri minus consumed flags), `config`, `worktree`, `allocatedPorts`, `projectRoot`, `envGroupOverride?` (from `--env-group=X` if present), `signal?` (AbortSignal — wired by bin/lich.ts to SIGINT).
- `DispatchResult` is `{ exitCode: number }` — no stdout/stderr capture; we let the child inherit stdio.
- Behavior:
  1. Look up `config.commands?.[name]`. If absent, return `{ exitCode: 127 }` with a stderr line "lich: unknown command 'NAME' (try `lich help`)". (127 is the POSIX "command not found" convention.)
  2. Resolve the env_group: `envGroupOverride` if provided, else `config.commands[name].env_group`, else `"stack"`.
  3. Call `resolveEnvGroup` (Task 5) with that name, get the env map.
  4. Merge the command's per-command `env: { ... }` literals on top of the group env (later wins).
  5. Build the underlying shell command. Per spec section 4: extra argv is appended as positional args. Use `/bin/sh -c <cmd> -- arg1 arg2 ...` so the cmd can reach extras via `"$@"` (when it bothers); for the common case where the cmd is "pnpm test:e2e", `pnpm test:e2e --filter foo` is the visible behavior.
  6. Set `cwd` to `join(projectRoot, command.cwd ?? ".")`.
  7. Spawn with `stdio: "inherit"` so the user sees streaming output.
  8. If `signal` aborts, kill the child with SIGINT; return `{ exitCode: 130 }` (POSIX `128 + SIGINT(2)`).
  9. On normal exit, return `{ exitCode: child.exitCode ?? 1 }`.

**Tests to write:**
- Create `packages/lich/tests/unit/commands/dispatch.test.ts`:
  - `"returns 127 with helpful stderr for unknown command name"`
  - `"runs the command with the stack group env by default"` — spawn a cmd like `printenv MY_VAR`, set MY_VAR in top-level env, assert stdout contains the value (via a captured-stdio test variant; the production code uses inherit but tests can pass a custom stdio).
  - `"--env-group override changes which group is loaded"` — set MY_VAR differently in two groups, run cmd with each override, verify output differs.
  - `"per-command env overrides win over group env"`
  - `"extra argv is forwarded to the underlying cmd"` — cmd `echo "$@"`, pass `["--filter", "foo"]`; assert stdout is `-- --filter foo` (or matches the `"$@"` semantics).
  - `"cwd is resolved relative to projectRoot"` — set cwd to `apps/api`, run `pwd`, verify the absolute path matches.
  - `"abort signal kills the child and returns 130"`

**Implementation notes:**
- For testability, accept an optional `stdio` field on `DispatchInput` (default `"inherit"`); tests pass `"pipe"` and capture output.
- Do NOT validate the command at dispatch time beyond "exists in config.commands" — schema validation (Tasks 2-3) and `lich validate` (Tasks 14-17) own correctness. Dispatch is the runtime hot path.
- The `--` separator before extras is important: without it, a flag like `--filter` would be re-parsed by sh as a sh option in some shells. Always pass `--` before extras when invoking via `/bin/sh -c '<cmd>' -- "$@"`.
- This task touches ZERO files outside `commands/dispatch.ts` and its test. It does NOT wire itself into the router yet — that's Task 8.

---

## Task 8: Wire user-command dispatch into `bin/lich.ts`

**Dependencies:** Task 7.

**Files to create/modify:**
- Modify: `packages/lich/src/bin/lich.ts`
- Modify: `packages/lich/src/commands/index.ts` (export a helper to check "is built-in name" without invoking the handler)

**Acceptance criteria:**
- The dispatch flow becomes:
  1. If `commandName` is a built-in (via `isCommand`), run the built-in handler as today.
  2. Else, attempt to load `lich.yaml` from cwd via `parseConfig`. If parse fails, fall through to the existing "unknown command" error (exit 2). User commands require a valid config.
  3. If the parsed config has `commands[commandName]`, build the context (`detectWorktree(cwd)`, restore allocated ports from `state.json` via `rebuildAllocatedPorts`), and call `dispatchUserCommand`. Forward its exit code.
  4. Else, print "unknown command" with a `lich help`-aware suggestion.
- The `--env-group=<X>` flag is recognised at the top level: extract its value from `argv` and pass as `envGroupOverride` to `dispatchUserCommand`. (mri parses `--env-group=foo` as `{ "env-group": "foo" }` by default; alias to camelCase explicitly.)
- If no stack is up (no `state.json` for the current worktree), `allocatedPorts` is `{ compose: {}, owned: {} }` and user commands still run (they may fail their own logic when interpolating `${owned.X.port}`, but the dispatcher does not pre-flight this). The InterpolationError surfaces from the env_group resolver in that case — it's a useful failure.

**Tests to write:**
- Create `packages/lich/tests/unit/bin/dispatch-integration.test.ts`:
  - `"falls through to user-command dispatch when name is not a built-in"` — uses a fixture config; mocks dispatchUserCommand to assert it was called with correct args.
  - `"parses --env-group=X and forwards to dispatcher"`
  - `"prints 'unknown command' when neither built-in nor user command"`
  - `"returns 2 when config parse fails (yaml syntax error)"`

**Implementation notes:**
- The bin/lich.ts file currently calls `process.exit(2)` immediately for non-built-in names. Refactor that branch into a `dispatchUnknown(commandName, rest)` async function that does the config-load + user-dispatch fallback.
- Add `"env-group"` to mri's `string: [...]` declaration so the value isn't lost. Then map `argv["env-group"]` → `envGroupOverride`.
- This task does NOT modify `commands/index.ts`'s stubs for `help`/`exec`/`env` yet — Tasks 9-13 replace them with real handlers.
- The dispatch test verifies behavior with a real Worktree/state shape — use the existing `tests/unit` helpers if any (check `state/` test files for patterns). If no fixture exists, the test inlines a minimal valid Worktree object.

---

## Task 9: `lich help` — built-in command listing (`commands/help.ts`)

**Dependencies:** Task 1 (typed `commands` section).

**Files to create/modify:**
- Create: `packages/lich/src/commands/help.ts`
- Modify: `packages/lich/src/commands/index.ts` to wire the real handler.

**Acceptance criteria:**
- Exports `runHelp(opts: HelpOptions): Promise<HelpResult>`. Options carry `commandName?` (the optional second positional, e.g. `lich help up`), `cwd` (for config-loading), and `stdout?`/`stderr?` sinks (defaulted).
- With no `commandName`: prints a section "Built-in commands:" followed by one line per built-in command. Format: `  <name>  <one-line summary>`. Summaries are hardcoded constants in this file (see implementation notes).
- If a `lich.yaml` is present and has user-defined `commands:`, print a second section "User-defined commands (from lich.yaml):" with `<name>  <first line of help: field>` (or `(no help text)` if absent). User commands sorted alphabetically.
- If `commandName` is a built-in, print its full long-form help (also hardcoded constants here for now; the full help text mirrors what `lich <cmd> --help` would say — keep it short, ~3-10 lines per command).
- If `commandName` is a user-defined command, print its name and its full `help:` text verbatim.
- If `commandName` is neither: stderr "unknown command 'NAME'"; exit 1.
- Exit 0 on any successful listing or help-text emission.

**Tests to write:**
- Create `packages/lich/tests/unit/commands/help.test.ts`:
  - `"lists every built-in command with a one-line summary"` — assert the output contains "up", "down", "logs", "urls", "stacks", "restart", "nuke", "init", "validate", "help", "exec", "env".
  - `"includes user-defined commands from lich.yaml when present"` — use a tmpdir with a minimal yaml + commands.
  - `"shows long help for a built-in command name"`
  - `"shows the user's help: text verbatim for a user command name"`
  - `"prints 'unknown command' when name matches neither"`
  - `"works in a directory with no lich.yaml (built-ins only)"`

**Implementation notes:**
- Help summaries live as a `const BUILTIN_SUMMARIES: Record<string, string>` and `const BUILTIN_LONG_HELP: Record<string, string>` at the top of `help.ts`. Keep both up to date as new built-ins land.
- Order built-in commands in a curated order in output (up, down, restart, logs, urls, stacks, nuke, validate, init, help, exec, env) — alphabetical mixes infrastructure (`init`, `nuke`) with daily-driver commands (`up`, `logs`) in ways that obscure discovery. User commands ARE sorted alphabetically because their names aren't predictable.
- Do NOT load lich.yaml when the user requests help for a built-in (e.g. `lich help up`) — keep that path zero-IO. Only load yaml when `commandName` is absent (list mode) or when `commandName` isn't a built-in (might be a user command).
- The router signature returned by `runHelp` is `{ exitCode: 0 | 1 }`. Wire into `commands/index.ts`'s `COMMANDS` map replacing the existing `stub("help")`.

---

## Task 10: `lich exec` — ad-hoc command runner (`commands/exec.ts`)

**Dependencies:** Tasks 5, 6.

**Files to create/modify:**
- Create: `packages/lich/src/commands/exec.ts`
- Modify: `packages/lich/src/commands/index.ts` to wire the real handler.

**Acceptance criteria:**
- Exports `runExec(opts: ExecOptions): Promise<{ exitCode: number }>`. Options: `argv` (the full positional + flags after `exec`), `envGroupName?` (from `--env-group=X`; default `"stack"`), `cwd`, `signal?`, optional `stdio` override for tests.
- Behavior:
  1. The remaining argv after `exec` is the command to run. Empty argv → stderr "usage: lich exec [--env-group=<group>] <cmd> [args...]"; exit 2.
  2. Load `lich.yaml` from cwd (via `parseConfig`). If parse fails, stderr the parse error and exit 1.
  3. Detect worktree (`detectWorktree(cwd)`); load state.json if it exists (`readSnapshot`) and rebuild allocated ports (`rebuildAllocatedPorts`). If no state, use empty allocated-ports — the resolver will still produce a useful env, just without `${owned.X.port}` style refs.
  4. Resolve the env group via `resolveEnvGroup` (Task 5).
  5. Spawn the user's command using `/bin/sh -c <joined-argv>` (so `lich exec sh -c 'echo $DATABASE_URL'` and `lich exec ls -la apps/api` both work). When argv has exactly one entry, pass it as the sh command; when multiple, join with spaces but **escape each** with `shell-quote`-style logic OR (simpler, decision below) join via shellescape-by-Bun's built-in `Bun.escapeHTML`—**no, neither is right**. **Decision:** pass argv directly to `spawn(argv[0], argv.slice(1))` for the multi-arg case; only fall back to `/bin/sh -c` for the single-arg case. This matches how `docker exec` and `kubectl exec` behave and avoids quoting bugs. Test both forms.
  6. Inherit stdio so output streams to the user.
  7. Honor `signal` (kill child on SIGINT; exit 130).
  8. Return `{ exitCode: child.exitCode ?? 1 }`.

**Tests to write:**
- Create `packages/lich/tests/unit/commands/exec.test.ts`:
  - `"runs argv via /bin/sh -c for single-arg form"` — `runExec({ argv: ["echo $HOME"] })` invokes shell expansion.
  - `"runs argv as direct spawn for multi-arg form"` — `runExec({ argv: ["echo", "hi"] })` produces "hi" without shell-meta interpretation.
  - `"loads the stack env group by default"` — set a top-level env var, run `printenv THE_VAR`, assert it appears.
  - `"--env-group=X loads a different group"`
  - `"exits 2 on empty argv with usage message"`
  - `"exits with the child's exit code on normal exit"`
  - `"returns 130 when signal aborts mid-run"`

**Implementation notes:**
- The single-arg-vs-multi-arg dispatch is the same trick `docker exec`/`kubectl exec` use; document it inline so future readers don't add a "fix the shell quoting bug" PR.
- The router (Task 13 — actually integrated alongside this task in `commands/index.ts`) needs to extract `--env-group=X` and pass it. mri can do this if `--env-group` is registered as a string option in bin/lich.ts (Task 8 already does this).
- The handler signature wired into `COMMANDS` matches what `commands/index.ts` already expects from other handlers (`CommandHandler` shape with `CommandContext`).

---

## Task 11: `lich env` — dotenv output for shell sourcing (`commands/env.ts`)

**Dependencies:** Tasks 5, 6.

**Files to create/modify:**
- Create: `packages/lich/src/commands/env.ts`
- Modify: `packages/lich/src/commands/index.ts` to wire the real handler.

**Acceptance criteria:**
- Exports `runEnvCmd(opts: EnvCmdOptions): Promise<{ exitCode: number }>`. Options: `groupName` (first positional after `env`), `cwd`, optional `stdout`/`stderr` sinks.
- Behavior:
  1. If no group name, stderr "usage: lich env <group>" and exit 2.
  2. Load `lich.yaml`, detect worktree, restore allocated ports (same pattern as exec).
  3. Resolve the group via `resolveEnvGroup` (Task 5).
  4. Print the resolved env as dotenv format, ONE `KEY=VALUE` per line, on stdout. Values containing whitespace, `#`, `'`, `"`, `\`, `$`, or any control char are wrapped in double quotes with escapes for `\`, `"`, `$`, `\n`, `\r`, `\t`. Bare-alnum values are unquoted.
  5. Keys are emitted in sorted order for stability (so `lich env stack > .env.lich && git diff` is meaningful).
  6. Exit 0 on success.

**Tests to write:**
- Create `packages/lich/tests/unit/commands/env.test.ts`:
  - `"prints KEY=VALUE for each env var in sorted order"`
  - `"quotes values containing whitespace"`
  - `"quotes values containing #"`
  - `"escapes \\n, \\\", \\\\, $ inside quoted values"`
  - `"emits parseable dotenv: round-trips through the env/files.ts dotenv parser"` — this is the load-bearing assertion. Take the output, feed it through Plan 1's dotenv-parser, assert the result matches the original input. (See `env/shell-out.ts` for the in-tree dotenv parser; reuse it as the reference parser for this test.)
  - `"exits 2 with usage when no group name given"`
  - `"exits 1 with helpful error when group does not exist"`

**Implementation notes:**
- The dotenv emission rules are mirrored from the in-tree parser in `env/shell-out.ts` (the `parseDotenv` function). The output must round-trip cleanly through that parser; the round-trip test is the SLO.
- Do NOT add a `--format=json` option here. The spec lists only dotenv. If JSON is needed later, it's a v1.x add.
- Sorting keys breaks ties for any user that re-sources the output; non-sorted output could mask diffs and was a real pain point in v0's similar tooling.

---

## Task 12: Wire real `help`, `exec`, `env` handlers into router

**Dependencies:** Tasks 9, 10, 11.

**Files to create/modify:**
- Modify: `packages/lich/src/commands/index.ts`

**Acceptance criteria:**
- The `COMMANDS` map no longer contains `stub("help")`, `stub("exec")`, or `stub("env")`. Each is replaced by a `CommandHandler` that calls the new `runHelp` / `runExec` / `runEnvCmd` functions.
- Each handler parses the right options from `ctx.argv`:
  - `help`: `commandName = ctx.argv._[0]`.
  - `exec`: `envGroupName = ctx.argv["env-group"]`, `argv = ctx.argv._`.
  - `env`: `groupName = ctx.argv._[0]`.
- The smoke test (`packages/lich/tests/unit/smoke.test.ts`'s "every command stub returns not-yet-implemented" assertion) is updated: the stub-message assertion no longer applies to `help`, `exec`, `env`. Either narrow the loop to just the remaining stubs (`restart`) or change the assertion to "stubs OR has been promoted to real handler."

**Tests to write:**
- No new test file; existing smoke test must be updated. Add one new assertion: `"help/exec/env are real handlers, not stubs"` — call each with a minimal argv and assert the result is NOT the not-yet-implemented stub message.

**Implementation notes:**
- The handler functions in `commands/index.ts` are tiny adapters between `CommandContext` and the per-command `Options` shape. Keep them <10 LOC each; the logic lives in the per-command modules.
- The existing smoke test loop iterates `Object.entries(COMMANDS)` and asserts every result contains the command name in `message`. After this task, `help`, `exec`, `env` no longer satisfy this. Refactor the loop to use a `STUB_COMMANDS = new Set(["restart"])` list and only assert the stub message for those.

---

## Task 13: Wire `resolveEnvGroup` callback into `commands/up.ts`'s lifecycle calls

**Dependencies:** Task 5.

**Files to create/modify:**
- Modify: `packages/lich/src/commands/up.ts`

**Acceptance criteria:**
- Both `runLifecycle(...)` calls (for `before_up`, `after_up`, `before_down`) and `runPerServiceLifecycle(...)` calls receive a real `resolveEnvGroup` function instead of `undefined`.
- The callback signature is `(groupName: string) => Promise<NodeJS.ProcessEnv>` and it invokes `groups/resolve.ts`'s `resolveEnvGroup` with the active config + worktree + allocatedPorts + projectRoot.
- The dogfood-stack yaml's existing lifecycle hooks (which currently use shorthand strings, no `env_group:`) continue to work unchanged.
- A new test fixture (a synthetic config) with `lifecycle.after_up: [{ cmd: "echo $VAR", env_group: "demo" }]` and a corresponding `env_groups.demo: { env: { VAR: "value" } }` now runs successfully where Plan 1 would have thrown "env_group not supported in Plan 1".

**Tests to write:**
- Modify `packages/lich/tests/unit/commands/up.test.ts` (or a new sibling if up.test.ts is unwieldy): `"long-form lifecycle entries resolve env_group via groups resolver"` — this is the load-bearing unit test for the wiring.

**Implementation notes:**
- Plan 1 left `resolveEnvGroup` as a deliberate seam (see `lifecycle/executor.ts:40-44` and `lifecycle/per-service.ts:55-59`). This task fills the seam.
- The Plan 1 executor throws if a long-form entry sets `env_group` and no callback is provided. After this task, the callback is always provided, so the throw path becomes a defensive guard for unit tests that pass `undefined` deliberately.
- This task does NOT add new lifecycle features — just wires existing infrastructure.

---

## Task 14: `lich validate` — refuse user commands shadowing built-ins

**Dependencies:** Task 1.

**Files to create/modify:**
- Modify: `packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- After schema validation passes, `runValidate` checks each entry in `config.commands` and emits a `ValidationError` of kind `"shadow"` (a new kind on the `ValidationError.kind` union) if its name matches any built-in.
- Built-in names come from `Object.keys(COMMANDS)` imported from `commands/index.ts`. (This creates a circular-import risk; mitigate per implementation notes.)
- Error message format: `commands.<name> shadows the built-in 'lich <name>' — pick a different name (try '<name>:run' or similar)`.
- Location: `<file>` (no precise line:col; ajv-style location resolution doesn't reach into the `commands` object's key range trivially; acceptable for v1).
- Exit code remains 1 on any error, 0 when clean.

**Tests to write:**
- Modify `packages/lich/tests/unit/commands/validate.test.ts`:
  - `"refuses a user command named 'up'"`
  - `"refuses a user command named 'validate'"`
  - `"accepts user commands with `:` separators that don't collide with built-ins"`
  - `"accepts a command named 'test:e2e' (from dogfood-stack)"`

**Implementation notes:**
- Circular-import mitigation: `commands/index.ts` imports `runValidate` from `commands/validate.ts`. If `validate.ts` then imports `COMMANDS` from `commands/index.ts`, Node ESM circulars cause `COMMANDS` to be undefined during module init in some test setups. Avoid by exporting a separate `BUILTIN_COMMAND_NAMES: readonly string[]` constant from `commands/builtin-names.ts` (NEW file, ~5 LOC) and importing it from both places.
- Add `"shadow"` to `ValidationError.kind`'s union.

---

## Task 15: `lich validate` — env_groups extends cycles

**Dependencies:** Tasks 1, 4.

**Files to create/modify:**
- Modify: `packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- After schema validation passes, if `config.env_groups` is present, run `detectExtendsCycle` (Task 4); if it returns a cycle, push a `ValidationError` of kind `"cycle"` with message `cycle in env_groups extends: a → b → c → a`.
- Mirror the message format used by the existing `checkDependsOnAndCycles` for `depends_on` cycles — readers should see one consistent shape.

**Tests to write:**
- Modify `packages/lich/tests/unit/commands/validate.test.ts`:
  - `"detects a 2-node env_groups extends cycle"`
  - `"detects a self-loop in env_groups extends"`
  - `"accepts env_groups extends chains that terminate"`
  - `"accepts env_groups with extends: stack (built-in terminator)"`

**Implementation notes:**
- This check runs BEFORE the next task's reference-resolution check, because a cycle would otherwise misreport as "extends X not found" if the validator walks the chain.

---

## Task 16: `lich validate` — env_group reference resolution

**Dependencies:** Task 1.

**Files to create/modify:**
- Modify: `packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- New check: every `env_group:` reference resolves to either `"stack"` (built-in) or a declared name in `config.env_groups`. Cover three source surfaces:
  1. `config.commands.<name>.env_group` (Task 1's typed shape).
  2. `config.lifecycle.<phase>[i]` long-form entries (`{ cmd, env_group }`).
  3. `config.owned.<svc>.lifecycle.<phase>[i]` long-form entries (per-service).
  4. `config.env_groups.<name>.extends` references to other groups (excluding `"stack"`).
- Each unresolved reference emits `ValidationError` of kind `"ref"` (already exists) with message `env_group "NAME" not declared (try "..." ?)`. Include a Levenshtein-based suggestion when within edit distance 2 of an existing group name.
- Location: `<file> (/commands/<name>/env_group)` or analogous JSON-pointer-style for lifecycle entries.

**Tests to write:**
- Modify `packages/lich/tests/unit/commands/validate.test.ts`:
  - `"refuses commands.X.env_group pointing at undeclared group"`
  - `"refuses lifecycle.after_up entry env_group pointing at undeclared group"`
  - `"refuses owned.svc.lifecycle entry env_group pointing at undeclared group"`
  - `"refuses env_groups.X.extends pointing at undeclared group"`
  - `"accepts env_group: stack universally"`
  - `"suggests close-match names on typo"`

**Implementation notes:**
- Walk `commands`, `lifecycle.before_up`/`after_up`/`before_down`, and every `owned.<svc>.lifecycle` block. Build the iterator once at the top of the new check function; pass each `{ envGroupName, location }` pair through a shared resolver.
- The Levenshtein helper from `commands/validate.ts` is already in this file — reuse it directly, no need to extract.
- The built-in `"stack"` name is always valid even if the user never declares an `env_groups:` section.

---

## Task 17: `lich validate` — refuse interpolation refs to `${owned.X.captured.Y}` (deferral note + suggestion)

**Dependencies:** none (small polish).

**Files to create/modify:**
- Modify: `packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- Current Plan-1 validator's `checkValueRefs` falls through any `${owned.X.captured.Y}` reference into an "unknown reference" error. This is correct (capture isn't until Plan 4) but the error message is misleading — implies the user mistyped. Update the message to: `${owned.X.captured.Y} is a Plan-4 (failure-surfacing) feature; supported references today: worktree.*, services.<name>.host_port, owned.<name>.port, owned.<name>.ports.<key>`.
- No new `ValidationError.kind`; uses existing `"interp"`.

**Tests to write:**
- Modify `packages/lich/tests/unit/commands/validate.test.ts`: `"reports a clearer error for ${owned.X.captured.Y} references (Plan 4 feature)"`.

**Implementation notes:**
- This is a 1-line change inside `validateRefBody`. It exists as its own task because Plan 4 will REMOVE the special-case error once captures are implemented — keeping it isolated makes that Plan-4 task obvious.

---

## Task 18: Update `examples/dogfood-stack/lich.yaml` — add `env_groups`

**Dependencies:** Tasks 1, 2.

**Files to create/modify:**
- Modify: `examples/dogfood-stack/lich.yaml`

**Acceptance criteria:**
- A new `env_groups:` top-level section with TWO entries:
  - `stack-plus-test`: `extends: stack`, `env: { TEST_MODE: "integration" }`. Demonstrates the "stack PLUS extras" pattern from spec section 4 pattern C.
  - `isolated-tools`: NO `extends`, `process_env: false`, `env: { TOOL_MODE: "standalone" }`. Demonstrates spec pattern B (isolated standalone group).
- The existing `commands: { test:e2e, db:psql }` entries remain unchanged.
- A NEW entry under `commands:`: `tools:env-check` with `cmd: 'printenv TOOL_MODE TEST_MODE LICH_WORKTREE'`, `env_group: isolated-tools`, and a `help:` field explaining it as a diagnostic.
- `lich validate` against the updated dogfood-stack yaml exits 0 with no errors.

**Tests to write:**
- No new unit-test file. The conformance test in `packages/lich/tests/unit/config/schema.test.ts` (`"validates the dogfood-stack/lich.yaml as a conformance benchmark"`) MUST continue to pass.

**Implementation notes:**
- Add the new sections ABOVE `commands:` so the read order is `version → owned → env → env_groups → profiles → commands`. Matches spec sample order.
- Pick env values that are obvious in test assertions (`integration`, `standalone`) — these aren't realistic but they're easy to assert.
- The `tools:env-check` command is the one e2e tests exercise to verify env_group resolution end-to-end.

---

## Task 19: E2E test — user-defined command invocation

**Dependencies:** Tasks 7, 8, 18.

**Files to create/modify:**
- Create: `tests/e2e/commands-user-defined.test.ts`

**Acceptance criteria:**
- Test `"lich <user-command> runs the cmd with resolved env"`:
  1. Copy dogfood-stack to tmpdir.
  2. `lich up` (background); wait for ready.
  3. `runLich(["test:e2e"], { cwd })` — assert exit 0 and stdout contains `"no e2e tests in dogfood-stack yet"` (the existing dogfood `test:e2e` command).
  4. `lich down`; cleanup.
- Test `"extra argv is forwarded to the underlying cmd"`:
  1. `lich up`; wait for ready.
  2. `runLich(["tools:env-check", "--extra", "foo"], { cwd })` — the `printenv` cmd ignores extra argv but the test asserts exit 0 (proving the dispatcher accepted them rather than failing usage).
  3. Additionally, define an alternative ad-hoc command via `lich exec sh -c 'echo "$@"' -- a b c` and assert stdout is `a b c` (proves the `"$@"` plumbing reaches the shell).
- Test `"unknown command emits exit 127"`: `runLich(["does:not:exist"], { cwd })` exits 127 with stderr containing "unknown command".

**Tests to write:**
- Single file: `tests/e2e/commands-user-defined.test.ts` with the three tests above.

**Implementation notes:**
- Use the existing helpers: `copyExampleToTmpdir`, `runLich`/`spawnLich`, `waitForHttp200`. Follow the cleanup pattern from `tests/e2e/basic-up.test.ts` (lichProc kill + cleanup in `afterEach`).
- These tests REQUIRE docker + supabase v2+ on the host (they spin up the dogfood stack). Same prerequisites as Plan 1's e2e suite — the existing test infrastructure already handles missing prerequisites by failing loudly with the docker error.

---

## Task 20: E2E test — `lich exec`

**Dependencies:** Tasks 10, 12.

**Files to create/modify:**
- Create: `tests/e2e/exec.test.ts`

**Acceptance criteria:**
- Test `"lich exec runs an arbitrary command with the stack env"`:
  1. Copy + up the dogfood stack.
  2. `runLich(["exec", "sh", "-c", "echo $DATABASE_URL"], { cwd })`.
  3. Assert exit 0 and stdout contains `postgresql://postgres:postgres@localhost:` (the resolved DATABASE_URL with an actual allocated port number, not the un-interpolated `${owned.supabase.ports.db}`).
- Test `"--env-group=<X> overrides the default stack group"`:
  1. With the stack up, `runLich(["exec", "--env-group=isolated-tools", "sh", "-c", "echo $TOOL_MODE-$DATABASE_URL"], { cwd })`.
  2. Assert exit 0 and stdout is `standalone-` (the `TOOL_MODE` from the isolated group AND an empty DATABASE_URL, because isolated-tools does NOT extend stack).
- Test `"exits 2 with usage when no command argv given"`: `runLich(["exec"], { cwd })` → exit 2, stderr contains "usage".

**Tests to write:**
- Single file: `tests/e2e/exec.test.ts`.

**Implementation notes:**
- The "DATABASE_URL is empty under isolated-tools" assertion is THE proof of isolation. If a future bug leaks stack env into isolated groups, this test catches it instantly.
- These tests run while a stack is up — required because `${owned.supabase.ports.db}` is only resolvable after port allocation.

---

## Task 21: E2E test — `lich env <group>`

**Dependencies:** Tasks 11, 12.

**Files to create/modify:**
- Create: `tests/e2e/env-dotenv.test.ts`

**Acceptance criteria:**
- Test `"lich env stack prints dotenv with allocated-port values"`:
  1. Copy + up the dogfood stack.
  2. `runLich(["env", "stack"], { cwd })`.
  3. Assert exit 0, stdout contains `DATABASE_URL=` followed by `postgresql://postgres:postgres@localhost:<digits>/postgres` (digits prove port resolution ran).
  4. Assert stdout contains `LICH_WORKTREE=` and `LICH_STACK_ID=`.
- Test `"lich env output is sourceable in bash"`:
  1. With stack up, write `lich env stack` output to a tmpfile.
  2. Spawn `bash -c "source $tmpfile && echo $DATABASE_URL"` (a real bash subprocess).
  3. Assert stdout matches the same `postgresql://...` pattern. (Proves dotenv quoting handles `:` and `/` correctly.)
- Test `"lich env <isolated-group> does not include stack vars"`:
  1. With stack up, `runLich(["env", "isolated-tools"], { cwd })`.
  2. Assert stdout contains `TOOL_MODE=standalone` and does NOT contain `DATABASE_URL` or `LICH_STACK_ID`.
- Test `"lich env <unknown> exits 1"`.

**Tests to write:**
- Single file: `tests/e2e/env-dotenv.test.ts`.

**Implementation notes:**
- The "source in bash" round-trip test is the load-bearing assertion for the dotenv quoting/escaping rules (Task 11). If this passes, the user's `source <(lich env stack)` use case works.
- Use `node:child_process.spawnSync("bash", ["-c", `source ${tmp} && env | grep DATABASE_URL`])` rather than shell-escaping the file path manually.

---

## Task 22: E2E test — env_groups isolation and `process_env`

**Dependencies:** Tasks 11, 18.

**Files to create/modify:**
- Create: `tests/e2e/env-groups-isolation.test.ts`

**Acceptance criteria:**
- Test `"process_env: false blocks shell env passthrough"`:
  1. Copy + up the dogfood stack.
  2. `runLich(["env", "isolated-tools"], { cwd, env: { LEAK_TEST: "from-shell" } })` (the helper accepts an env override).
  3. Assert stdout does NOT contain `LEAK_TEST`.
- Test `"extends: stack inherits stack env"`:
  1. `runLich(["env", "stack-plus-test"], { cwd })`.
  2. Assert stdout contains both `DATABASE_URL=postgresql://...` (from stack) AND `TEST_MODE=integration` (from the group).
- Test `"user group without extends does NOT include stack env"`:
  1. `runLich(["env", "isolated-tools"], { cwd })`.
  2. Assert stdout does NOT contain `DATABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`.

**Tests to write:**
- Single file: `tests/e2e/env-groups-isolation.test.ts`.

**Implementation notes:**
- The `runLich` helper (`tests/e2e/helpers/lich.ts`) already accepts `env` overrides — verified by reading the file. Use the `env: { LEAK_TEST: "from-shell" }` field directly.
- These three tests together fully verify spec section 4's env_groups patterns A, B, C from the design doc.

---

## Task 23: E2E test — `lich help`

**Dependencies:** Tasks 9, 12, 18.

**Files to create/modify:**
- Create: `tests/e2e/help.test.ts`

**Acceptance criteria:**
- Test `"lich help lists every built-in command"`:
  1. `runLich(["help"], { cwd: tmpdirWithDogfood })`.
  2. Assert stdout contains every built-in name (up, down, restart, logs, urls, stacks, nuke, init, validate, help, exec, env).
  3. Assert each appears with a non-empty summary.
- Test `"lich help lists user-defined commands when run in a worktree with lich.yaml"`:
  1. `runLich(["help"], { cwd: tmpdirWithDogfood })`.
  2. Assert stdout contains "User-defined commands" and the names `test:e2e`, `db:psql`, `tools:env-check`.
- Test `"lich help <built-in> prints its long help"`: `runLich(["help", "up"])` → stdout contains "Bring the current worktree's stack up" or similar phrase from the long-help constant.
- Test `"lich help <user-cmd> prints the user's help: text verbatim"`: `runLich(["help", "tools:env-check"], { cwd })` → stdout contains the help string from the yaml.
- Test `"lich help <unknown> exits 1"`.
- Test `"lich help works in a dir with no lich.yaml"`: in an empty tmpdir, `runLich(["help"])` exits 0 and lists only built-ins.

**Tests to write:**
- Single file: `tests/e2e/help.test.ts`.

**Implementation notes:**
- These tests do NOT spin up a stack. Help is purely static (config-load only). Skip the `lich up` overhead — saves significant CI time.
- The "no lich.yaml" test uses `mkdtempSync` directly rather than `copyExampleToTmpdir`.

---

## Task 24: E2E test — `lich validate` plan-2 error paths

**Dependencies:** Tasks 14, 15, 16.

**Files to create/modify:**
- Create: `tests/e2e/validate-plan2-errors.test.ts`
- Create: `tests/e2e/fixtures/invalid-yamls/` (NEW directory with several `.yaml` fixtures).

**Acceptance criteria:**
- Fixture YAMLs (each minimal-but-invalid, version: "1"):
  - `shadow-builtin.yaml`: declares `commands: { up: { cmd: "echo x" } }`.
  - `env-groups-cycle.yaml`: `env_groups: { a: { extends: b }, b: { extends: a } }`.
  - `env-group-undeclared.yaml`: `commands: { foo: { cmd: "x", env_group: "ghost" } }`.
  - `env-group-typo-suggestion.yaml`: declares `env_groups: { infisical-prod: ... }` and `commands: { foo: { cmd: "x", env_group: "infisical-prdo" } }`.
  - `env-group-extends-missing.yaml`: `env_groups: { a: { extends: "nonexistent" } }`.
- Each test runs `runLich(["validate", "<fixture>"], { cwd })` and asserts:
  - Exit 1.
  - Stderr (or stdout when --json) contains the expected error message substring.
- One test invokes `runLich(["validate", "--json", "fixture.yaml"])` and asserts the JSON report's `errors[].kind` includes `"shadow"`, `"cycle"`, or `"ref"` as appropriate.

**Tests to write:**
- Single file: `tests/e2e/validate-plan2-errors.test.ts` (~6 tests, one per fixture + one --json structural test).
- Fixture files under `tests/e2e/fixtures/invalid-yamls/`.

**Implementation notes:**
- Fixtures live under `tests/e2e/fixtures/invalid-yamls/` because they're test-only, not example apps. Add a one-line README in that dir noting "DO NOT add to examples/; these intentionally fail validation."
- These tests do NOT spin up a stack — pure validate-only. Very fast (sub-second each).

---

## Task 25: E2E test — `lifecycle` `env_group` resolution

**Dependencies:** Tasks 13, 18.

**Files to create/modify:**
- Create: `tests/e2e/lifecycle-env-group.test.ts`
- Create: `examples/dogfood-stack/scripts/write-marker.sh` (NEW small shell script the e2e test uses).
- Modify: `examples/dogfood-stack/lich.yaml` (add a top-level `lifecycle.after_up` long-form entry — see implementation notes).

**Acceptance criteria:**
- The dogfood-stack's `lich.yaml` gains a top-level `lifecycle.after_up` entry of the form `{ cmd: "./scripts/write-marker.sh", env_group: "stack-plus-test" }`.
- The `scripts/write-marker.sh` writes a file containing `TEST_MODE=$TEST_MODE\nDATABASE_URL=$DATABASE_URL\n` to `$LICH_HOME/marker.txt` (path passed via env from the test, with a fallback).
- Test `"after_up lifecycle entry uses env_group when specified"`:
  1. Copy dogfood, set `LICH_HOME=<tmpdir>`, `lich up`, wait for ready.
  2. Read `<tmpdir>/marker.txt`.
  3. Assert `TEST_MODE=integration` (from the `stack-plus-test` group's literal) AND `DATABASE_URL=postgresql://...:<digits>/...` (from the inherited `stack` parent).
  4. `lich down`; cleanup.
- This test proves Task 13's wiring works end-to-end.

**Tests to write:**
- Single file: `tests/e2e/lifecycle-env-group.test.ts`.

**Implementation notes:**
- Adding `lifecycle.after_up` to dogfood-stack ALSO means Plan 1's existing tests that assert "lifecycle has migrate + seed entries" need to extend — verify the test count expectations in any tests that count `lifecycle_hooks` (e.g. `validate` summary tests). Specifically, `packages/lich/tests/unit/commands/validate.test.ts` may have an assertion on the dogfood summary count; update if so.
- The marker script must be executable. Tests should `chmod +x` after `copyExampleToTmpdir` or rely on the cp helper preserving mode (which `cpSync` does by default).
- Resist the urge to also add a long-form `before_down` test in this task — keep tasks bite-sized. Per-service lifecycle env_group testing can ride alongside Plan 4's failure tests if needed; Plan 1's lifecycle code already has unit-test coverage for both top-level and per-service.

---

## Task 26: Smoke-test parity — update `packages/lich/tests/unit/smoke.test.ts`

**Dependencies:** Task 12.

**Files to create/modify:**
- Modify: `packages/lich/tests/unit/smoke.test.ts`

**Acceptance criteria:**
- The "every command stub returns not-yet-implemented" loop no longer fails after Task 12 promotes `help`/`exec`/`env` to real handlers. Either narrow the loop to a `STUB_COMMANDS = new Set(["restart"])` or change the assertion to "command exists and is callable."
- New assertion: `"help/exec/env are real handlers"` — invoke each with a minimal valid context and assert the result type doesn't carry the stub's literal message.
- The command-names-equality assertion (currently lists all 12 expected names) does not need a change — Plan 2 adds no new built-ins.

**Tests to write:**
- Modify only — no new file.

**Implementation notes:**
- This task is bundled into Task 12's PR-equivalent work in practice, but isolating it makes the diff readable. If the orchestrator merges Tasks 9-12 into a single subagent run, this becomes a trivial cleanup commit.

---

## Task 27: Conformance benchmark refresh

**Dependencies:** Tasks 2, 3, 18.

**Files to create/modify:**
- Modify: `packages/lich/tests/unit/config/schema.test.ts`

**Acceptance criteria:**
- The existing `"validates the dogfood-stack/lich.yaml as a conformance benchmark"` test continues to pass against the Task-18-updated yaml.
- If it fails, fix the schema (NOT the yaml) — the dogfood-stack is the source-of-truth for what lich must handle.
- Add THREE new conformance assertions:
  - `"validates a config with one env_groups entry and one commands entry that uses it"`.
  - `"rejects a config with env_groups.stack (reserved)"`.
  - `"rejects a config with a command missing the required cmd field"`.

**Tests to write:**
- Modify only.

**Implementation notes:**
- The conformance benchmark is the single fastest signal that the schema and the dogfood yaml are in sync. Treat any failure here as schema-bug-by-default; only edit the yaml if the spec genuinely requires a different shape.

---

## Task 28: `lich help` man-page polish (long-help text for new built-ins)

**Dependencies:** Tasks 9, 10, 11.

**Files to create/modify:**
- Modify: `packages/lich/src/commands/help.ts`

**Acceptance criteria:**
- `BUILTIN_LONG_HELP["help"]`, `["exec"]`, `["env"]` each carry 3-10 lines of long-form text describing options, examples, and exit codes.
- Each long-help text includes at least one `Example:` block.
- A test in `packages/lich/tests/unit/commands/help.test.ts`: `"long help for help/exec/env includes an Example block"` — asserts each contains the substring `Example:` or `Examples:`.

**Tests to write:**
- Modify existing test file.

**Implementation notes:**
- This task is intentionally small to give the help-output its own commit. Future plans can extend long help for `up`/`down`/etc. without touching unrelated logic.
- Keep the text plain ASCII — no ANSI, no markdown. The `output/pretty.ts` formatter handles coloring at the listing-level; long help is verbatim.

---

## Task 29: Final integration check + commit

**Dependencies:** all prior tasks.

**Files to create/modify:**
- None — verification only.

**Acceptance criteria:**
- `cd packages/lich && bun test` exits 0 (all unit tests pass).
- `cd packages/lich && bun run build` exits 0; `packages/lich/dist/lich` exists.
- `cd tests/e2e && bun test` exits 0 (assuming docker + supabase v2+ on the runner). All Plan 2 e2e tests pass alongside Plan 1's. The Plan-1-and-prior `basic-up.test.ts` "brings the stack up and serves the web app" test remains gated on Plan 5; otherwise green.
- `./packages/lich/dist/lich help` in any directory lists every built-in.
- From `examples/dogfood-stack/` (or a tmpdir copy thereof, with the stack up), `./packages/lich/dist/lich tools:env-check` prints the expected env vars.
- `git status` is clean; commit history shows ~25+ small, focused commits with `feat(lich):`, `test(lich):`, or `test(e2e):` prefixes per the conventions in `CLAUDE.md`.

**Tests to write:**
- None.

**Implementation notes:**
- This task is a verification gate, not a code task. It exists so the orchestrator has an explicit "we're done" checkpoint before declaring Plan 2 complete and starting Plan 3.

---

## Cross-plan dependencies

- **All of Plan 1 must be done.** Plan 2 cannot start before Plan 1 ships.
- Specifically: env resolution pipeline (P1 Task 13), interpolation engine (P1 Task 14), CLI router (`commands/index.ts` from P0), and the lifecycle hook executor's `resolveEnvGroup` seam (P1 Tasks 19-20) are the load-bearing dependencies.
- Plan 3 (Profiles) depends on Plan 2 because lifecycle entries' long-form `env_group:` is exercised in profile-scoped lifecycle.

---

## Testing requirements

Per testing standards (`docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`), every feature needs BOTH unit and e2e tests.

E2e coverage floor for this plan (consolidated across Tasks 19-25):

- **User-defined command invocable as `lich <name>`** (Task 19) — define in dogfood-stack yaml, invoke, assert correct stdout/exit and env loaded.
- **Argv forwarding** (Task 19) — `lich exec sh -c 'echo "$@"' -- a b c` reaches the shell with the extras.
- **`--env-group=<X>` override** (Task 20) — invoke `lich exec` with different group, verify env differs.
- **`lich exec <cmd>`** (Task 20) — runs against live stack with `DATABASE_URL` correctly resolved.
- **`lich env <group>`** (Task 21) — dotenv format, `source`able in bash, sorted keys.
- **`lich help`** (Task 23) — lists built-in and user-defined commands.
- **`lich help <user-cmd>`** (Task 23) — shows the user's `help:` text verbatim.
- **`process_env: false` isolation** (Task 22) — set a shell env var, verify it does NOT appear in the resolved group.
- **`extends: stack`** (Task 22) — a derived group includes stack env.
- **Standalone group** (Task 22) — a group without `extends: stack` does NOT include stack env.
- **Validate failure cases** (Task 24) — group references that don't resolve, extends cycles, commands shadowing built-ins.
- **Lifecycle `env_group:` resolves** (Task 25) — top-level `after_up` with `env_group` populates the marker file correctly.

---

## Acceptance criteria

Plan 2 is done when:

- `examples/dogfood-stack/lich.yaml` defines at least two `env_groups` entries (stack-extending and isolated) and three `commands` entries (existing two + one that uses an env_group).
- `lich help` from inside the dogfood-stack tmpdir lists every user command alongside built-ins.
- `lich <user-command>` (e.g. `lich tools:env-check`) invokes correctly with the resolved group env.
- `lich exec sh -c 'echo $DATABASE_URL'` against a live stack prints a real `postgresql://...:<port>/postgres` URL.
- `lich env stack` prints dotenv that includes the worktree's allocated postgres URL and is `source`able by bash.
- `lich validate` catches: nonexistent env_group reference, env_groups extends cycle, user command shadowing built-in.
- Plan 1's lifecycle long-form `{ cmd, env_group }` entries actually work end-to-end (no more "env_group not supported in Plan 1" throw).
- All Plan 2 e2e tests pass.
- All Plan 1 e2e tests still pass.
