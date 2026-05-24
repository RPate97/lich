# Lich v1 — Plan 3: Profiles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 3 profiles primitive, 4 profiles schema reference, 5 lich up [profile])

**Required reading (every subagent on every task):** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md` — every feature needs BOTH unit and e2e tests; e2e tests spawn the real binary against `examples/dogfood-stack/`.

**Goal:** Add named slices of the stack. Profiles define which services start AND what env they run with AND what lifecycle hooks fire. Enables "dev:full vs dev:lite vs dev:test-env" workflows. By end of plan, the dogfood-stack defines at least two profiles, `lich up [profile]` works, profile-scoped env overrides work, profile-scoped lifecycle works, and the current dogfood-stack's `dev`-profile-scoped migrations actually run (they don't today — Plan 1's `up.ts` ignores `profiles` entirely, so `config.lifecycle.after_up` is the only path executed).

**Builds on:** Plan 1 (`env/resolve.ts` pipeline, `lifecycle/executor.ts`, `config/parse.ts`, `commands/up.ts`, `state/snapshot.ts`, `deps/sort.ts`'s cycle-detection pattern). Plan 2 (`groups/resolve.ts` + `groups/built-in-stack.ts` + `commands/help.ts` + `commands/exec.ts` + `commands/env.ts` + lifecycle's wired `resolveEnvGroup` callback — all required because profile-scoped lifecycle entries can use the long-form `{cmd, env_group}` shape).

**Architecture:** Profiles are a separate resolver under `src/profiles/` that, given a profile name, computes (a) the resolved set of services and owned processes to start, (b) the profile-layered env (top-level + profile-scoped per-key precedence), and (c) the composed lifecycle hooks (top-level + profile-scoped, LIFO for `before_down`). `commands/up.ts` is modified to accept an optional profile argument, resolve it before building the dep graph, filter the started service set, and feed the profile-aware env + lifecycle into existing Plan 1 plumbing. The interpolation engine becomes lazy per-key so a profile's `DATABASE_URL` override (pointing at a hosted backend) doesn't trigger interpolation of the top-level value that referenced `${owned.supabase.ports.db}` (a service the profile excluded). State directory records the active profile so dashboard (Plan 5) can surface it and subsequent `lich up <other>` invocations can refuse mid-flight switches.

**Tech stack:** Same as Plan 1/2 (TypeScript on Bun, vitest, ajv, yaml). No new runtime dependencies.

---

## What this plan implements

From spec section 4 (profiles):

- **`profiles`** top-level config section
- Each profile: `services: string[]`, `owned: string[]`, `extends: string | string[]`, `default: boolean`, `env`, `env_files`, `env_from`, `lifecycle`
- Profile resolution: recursive `extends`, compute union of services/owned (preserving declared order with parents first), layer env per-key, compose lifecycle
- `default: true` profile is what `lich up` (no argument) activates; exactly zero or one profile may set it
- Services and owned NOT in any profile never start; `lich validate` issues a non-fatal warning for each
- Switching profiles while a stack is up is refused: `lich up <other>` while `state.json` shows `status: up` (or `starting`) prints an error pointing at `lich down` and exits non-zero

From spec section 4 (env precedence with profiles):

- Profile-scoped `env`, `env_files`, `env_from` layered between top-level and per-service: top-level → profile → per-service (per spec section 4 precedence list)
- **Lazy per-key interpolation.** A value's `${...}` refs are only resolved if that value wins the merged precedence. Per spec: "A top-level value like `SUPABASE_URL: 'http://localhost:${services.supabase.host_port}'` is fine even if some profile doesn't include the `supabase` service — as long as that profile overrides `SUPABASE_URL` with its own value, the top-level interpolation never evaluates."
- Auto-exported `LICH_PROFILE` env var alongside Plan 1's `LICH_WORKTREE` / `LICH_STACK_ID`

From spec section 4 (lifecycle composition):

- Profile-scoped `lifecycle` block (`before_up`, `after_up`, `before_down`)
- `before_up` / `after_up`: top-level entries run first, then profile entries
- `before_down`: profile entries run first, then top-level entries (LIFO — undo specialization before tearing down base)
- Long-form `{cmd, env_group}` entries continue to work — they call the `resolveEnvGroup` callback Plan 2 wired in

From spec section 5 (up + validate):

- `lich up [profile]` — argument selects profile (default profile if omitted)
- `lich up <bad-name>` exits non-zero with a clear "no profile named X" error and lists declared profiles
- `lich validate` gains: profile-name reference checks (every name in `services:`/`owned:` lists references a declared service), profile `extends` cycle detection, single-`default: true` enforcement, "services not in any profile" warnings, per-profile interpolation simulation (catches refs to services not in the profile's resolved set, except where lazy interpolation would skip them)

---

## Subsystems introduced

### `src/profiles/`

- `resolve.ts` — given a profile name + config, walk the `extends` chain (single string OR array form) and compute a `ResolvedProfile` carrying the union of `services`, `owned`, the layered env bundle, and the composed lifecycle. Pure logic; reuses `env/resolve.ts`'s primitive `layerBundle` shape conceptually but does not import it (the env pipeline gets the resolved bundle later — see `env/resolve.ts` extension).
- `validate-extends.ts` — cycle detection over the `profiles[*].extends` graph. Mirrors the existing `deps/sort.ts` `CycleError.cycle` shape and the new `groups/validate-extends.ts` (Plan 2) module so all three "extends cycle" detectors look identical to a reader.
- `default.ts` — pure helper `pickDefaultProfile(config) -> { name: string | null, error?: string }` enforcing the "exactly zero or one `default: true`" rule. Used by both `commands/up.ts` (to pick the implicit profile) and `commands/validate.ts` (to reject multiple-default configs).

### `src/env/resolve.ts` (extended — biggest change)

- New input field on `ResolveEnvForServiceInput` and `ResolveTopLevelEnvInput`: `profile?: ResolvedProfile` (typed as `import type` from `profiles/resolve.ts`).
- New precedence layer inserted between top-level and per-service: profile `env_from` → profile `env_files` → profile `env`. The existing `layerBundle` helper is reused verbatim for the new layer.
- Interpolation switches from EAGER (current Plan 1: run interpolation once over the fully merged map at the end) to LAZY PER-KEY (new: each merged-env value is interpolated on demand the first time it's read by a consumer). Achieved by returning a `Proxy`-backed map OR by interpolating during the merge step only for the keys that survive (a simpler approach — see implementation notes on Task 6).
- Auto-injection of `LICH_PROFILE` when a profile is active.

### `src/lifecycle/executor.ts` and `src/lifecycle/per-service.ts` (extended)

- No API change to `runLifecycle` / `runPerServiceLifecycle` themselves. Instead, `commands/up.ts` becomes the single point that composes top-level + profile-scoped lists into the `entries` array before calling each executor.
- The Plan 2 `resolveEnvGroup` callback continues to work unchanged: a profile-scoped lifecycle entry with `env_group: foo` resolves via the same callback.

### `src/commands/up.ts` (extended)

- Accept `profile: string | undefined` (from `argv._[0]` in the router). When undefined, fall back to the default profile.
- Refuse-mid-flight: before allocating ports, check the on-disk `state.json` (via `readSnapshot(worktree.stack_id)`). If `status: up` or `status: starting` and `active_profile` differs from the requested profile, error out.
- Filter the dep graph + start set to the resolved profile's services + owned only.
- Pass the resolved profile to `resolveTopLevelEnv` and `resolveEnvForService` so the profile env layer is applied.
- Compose `before_up` / `after_up` entry lists: top-level + profile (in that order). Compose `before_down` entry lists: profile + top-level (reverse).
- Write `active_profile` (and the resolved env keys for diagnostics — optional) into the snapshot.

### `src/commands/down.ts` (extended — small change)

- Read `active_profile` from `state.json`, re-resolve the profile from `lich.yaml`, and compose `before_down` entries: profile-scoped first, then top-level (LIFO). Without this change, profile-scoped `before_down` entries are silently skipped at teardown.

### `src/state/snapshot.ts` (extended)

- `StackSnapshot.active_profile?: string` — optional, defaults to omitted for pre-Plan-3 snapshots. Plan-3 writers always populate it (even when no profile is in use, set to `"<default>"` or omit — decision: omit when no profiles section exists in the yaml; set to the resolved profile name when one is active).

### `src/config/schema.ts` + `src/config/types.ts` (extended)

- `profiles` is now a strict object: keys are profile names (strings), values match a new `profileSchema`.
- `profileSchema` permits `services` (string array), `owned` (string array), `extends` (string OR array of strings), `default` (boolean), `env`, `env_files`, `env_from`, `lifecycle` (top-level shape — `before_up`/`after_up`/`before_down` with the same long-form `{cmd, env_group}` entries lifecycle already supports). `additionalProperties: false`.
- `types.ts` exports `ProfileDef` interface with the same fields.

### `src/commands/validate.ts` (extended)

- New checks: profile-list name resolution (every name in `services:`/`owned:` lists must reference a declared service/owned), profile `extends` cycle detection, single-`default: true` enforcement, unused-services warnings, per-profile interpolation simulation (replays the env-merge per profile to catch refs to services not in the profile's resolved set).

### `src/bin/lich.ts` (extended — one-line change)

- For `up`, pass `argv._[0]` (the optional positional after the command name) through as the profile to `runUp`.

---

## File structure delta

```
packages/lich/src/
  profiles/                              # NEW directory
    resolve.ts                           # NEW
    validate-extends.ts                  # NEW
    default.ts                           # NEW
  env/
    resolve.ts                           # MODIFY: profile layer + lazy interp + LICH_PROFILE
  state/
    snapshot.ts                          # MODIFY: add active_profile field
  config/
    schema.ts                            # MODIFY: strict profiles schema
    types.ts                             # MODIFY: ProfileDef + LichConfig.profiles tightened
  commands/
    up.ts                                # MODIFY: profile arg + filter + compose lifecycle
    down.ts                              # MODIFY: compose before_down LIFO
    validate.ts                          # MODIFY: profile checks + per-profile interp sim
  bin/
    lich.ts                              # MODIFY: forward positional for up

packages/lich/tests/unit/
  profiles/                              # NEW directory
    resolve.test.ts                      # NEW
    validate-extends.test.ts             # NEW
    default.test.ts                      # NEW
  env/
    resolve.test.ts                      # MODIFY: profile-layer + lazy-interp cases
  state/
    snapshot.test.ts                     # MODIFY: round-trips active_profile
  config/
    schema.test.ts                       # MODIFY: profiles shape cases + dogfood conformance
  commands/
    up.test.ts                           # MODIFY: profile arg, refuse-switch, filter
    down.test.ts                         # MODIFY: profile before_down composition
    validate.test.ts                     # MODIFY: profile error cases

tests/e2e/
  profiles-default.test.ts               # NEW — lich up activates default profile
  profiles-named.test.ts                 # NEW — lich up <name> activates named profile
  profiles-env-override.test.ts          # NEW — DATABASE_URL differs per profile
  profiles-lifecycle-scoping.test.ts     # NEW — migrations run only for dev, not for dev:test-env
  profiles-switch-refused.test.ts        # NEW — lich up <other> while up is refused
  profiles-lich-profile-env.test.ts      # NEW — LICH_PROFILE visible to services
  profiles-validate-errors.test.ts       # NEW — validate catches profile misconfigurations
  fixtures/invalid-yamls/                # ADD new fixtures (alongside Plan 2's directory)
    profile-undeclared-service.yaml
    profile-extends-cycle.yaml
    profile-two-defaults.yaml
    profile-extends-missing.yaml

examples/dogfood-stack/
  lich.yaml                              # MODIFY: add dev:test-env profile + profile-scoped envs
  apps/api/src/db.ts                     # MODIFY: read DATABASE_URL_OVERRIDE (Task 24 prep)
```

---

## Task list

Order roughly matches build dependencies. Each task is a coherent commit (~30-90 min). Many can run in parallel under an orchestrator once their inputs land. Tasks 1-4 are foundation (types/schema/cycle); 5-7 build the resolver + env extension; 8-10 are lazy interpolation; 11-12 wire snapshot and validate; 13-15 wire `lich up`; 16-17 wire `lich down`; 18 updates dogfood; 19-26 add e2e coverage; 27-28 are polish + final integration check.

---

## Task 1: Tighten `profiles` and add `ProfileDef` type

**Dependencies:** none (purely type-level).

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/config/types.ts`

**Acceptance criteria:**
- `LichConfig.profiles` becomes `Record<string, ProfileDef> | undefined`.
- New exported `ProfileDef` interface with fields: `services?: string[]`, `owned?: string[]`, `extends?: string | string[]`, `default?: boolean`, `env?: EnvMap`, `env_files?: EnvFiles`, `env_from?: EnvFrom`, `lifecycle?: TopLevelLifecycle`. All fields optional except none required.
- Field placement: add `ProfileDef` immediately below `UserCommandDef` (Plan 2) so the type file ordering goes `Runtime → EnvGroupDef → UserCommandDef → ProfileDef → LichConfig`.
- JSDoc on `extends`: explains string vs array form and explicitly notes that array form is for inheriting from multiple parents (used by spec section 4 "extends: optional profile name (or list of names)").
- Existing import sites still compile.

**Tests to write:**
- No new unit-test file (pure types); the type tightening is exercised by Tasks 2 and 4.

**Implementation notes:**
- The lifecycle shape under a profile is the SAME as `TopLevelLifecycle` (`before_up`, `after_up`, `before_down`). Spec section 4 is explicit: profile-scoped lifecycle blocks do not include `before_start` / `after_ready` (those are per-service only).
- Decision: `extends: string | string[]` is the right shape. The env_groups version (`Plan 2 Task 1`) is single-string only because env_groups don't naturally compose across multiple parents (a key collision between two parents is ambiguous). Profiles are simpler: services/owned are sets (union them), env is layered per-key (later parent in the list wins, then the child wins).
- Do NOT type `lifecycle` as a fresh `ProfileLifecycle` interface — reuse `TopLevelLifecycle` directly; they are identical and divergence would be a refactor smell.

---

## Task 2: Extend JSON Schema for `profiles`

**Dependencies:** Task 1.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/config/schema.ts`

**Acceptance criteria:**
- The opaque `profiles: { type: "object", additionalProperties: true }` placeholder is REPLACED with a strict shape.
- A new `profileSchema` constant defines: `services: { type: "array", items: { type: "string" } }`, `owned: { type: "array", items: { type: "string" } }`, `extends: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }`, `default: { type: "boolean" }`, `env: envMapSchema`, `env_files: envFilesSchema`, `env_from: envFromSchema`, `lifecycle: topLevelLifecycleSchema`. `additionalProperties: false`.
- The `profiles` root property becomes `{ type: "object", additionalProperties: profileSchema }`.
- Profile names that collide with built-in command names are NOT rejected here (that's a `lich validate` reference check, same rationale as Plan 2 Task 3 for `commands`).
- Existing dogfood `lich.yaml` (which has `profiles: { dev: { default: true, owned: [...], lifecycle: {...} } }`) STILL validates after the tightening.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/config/schema.test.ts`:
  - `"validates a config with a minimal profile (only services list)"`
  - `"validates a config with a profile that uses extends: string"`
  - `"validates a config with a profile that uses extends: [a, b]"`
  - `"validates a config with profile-scoped env, env_files, env_from, lifecycle"`
  - `"rejects unknown property inside a profile entry"`
  - `"rejects profile.services with non-string entries"`
  - `"the conformance test for dogfood-stack/lich.yaml still passes"` — existing test; verify after change.

**Implementation notes:**
- Reuse `envMapSchema`, `envFilesSchema`, `envFromSchema`, and `topLevelLifecycleSchema` constants verbatim. These are all module-scope exports in `schema.ts`.
- The `extends` oneOf MUST list `string` first; ajv's oneOf semantics require exactly-one-match, but for `extends: "foo"` both `string` and `array` would fail the second branch cleanly, so the order is for readability.
- Don't add a regex constraint on profile names (`dev:test-env` and `dev:with-tunnel` use `:` separators per the spec's worked examples).

---

## Task 3: `default.ts` — single-default enforcement helper

**Dependencies:** Task 1.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/profiles/default.ts`

**Acceptance criteria:**
- Exports `pickDefaultProfile(config: LichConfig): { name: string | null; error?: string }`.
- Returns `{ name: null }` when `config.profiles` is absent or empty.
- Returns `{ name: <single-default> }` when exactly one profile sets `default: true`.
- Returns `{ name: null }` when no profile sets `default: true` (caller decides whether this is an error — `lich up` with no argument WILL treat it as one; `lich validate` does not).
- Returns `{ name: null, error: "multiple profiles set default: true: a, b" }` when two or more profiles set `default: true`.
- Pure function; no I/O, no async. ≤30 LOC.

**Tests to write:**
- Create `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/profiles/default.test.ts`:
  - `"returns { name: null } when profiles absent"`
  - `"returns { name: null } when no profile sets default"`
  - `"returns the name when exactly one default exists"`
  - `"returns { name: null, error } when two profiles claim default"`
  - `"lists every defaulting profile in the error (sorted)"`

**Implementation notes:**
- Sort the error's profile-name list alphabetically for deterministic test assertions.
- Do NOT throw — return the discriminated shape. Both callers (`lich up`, `lich validate`) want to handle the error case differently.

---

## Task 4: `profiles` extends-cycle detector (`validate-extends.ts`)

**Dependencies:** Task 1.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/profiles/validate-extends.ts`

**Acceptance criteria:**
- Exports `detectProfileExtendsCycle(profiles: Record<string, ProfileDef>): null | { cycle: string[] }`.
- Returns `null` when the extends graph is acyclic (including the empty case).
- Returns `{ cycle: [...] }` with the cycle in walk order when one exists; mirror the error shape used by `deps/sort.ts`'s `CycleError.cycle` and by Plan 2's `groups/validate-extends.ts`.
- Handles both `extends: "single"` (string) and `extends: ["a", "b"]` (array) — normalize to an array internally before walking.
- Does NOT check whether `extends` references resolve to a declared profile — that's the resolver's job. Cycle detection runs first because a cycle would cause infinite recursion in the resolver.

**Tests to write:**
- Create `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/profiles/validate-extends.test.ts`:
  - `"returns null for an empty profiles map"`
  - `"returns null for a single non-extending profile"`
  - `"returns null for a 3-node chain dev -> base -> root"`
  - `"detects a 2-node cycle a -> b -> a"`
  - `"detects a 3-node cycle a -> b -> c -> a"`
  - `"detects a self-loop a -> a"`
  - `"detects cycles through array-form extends (extends: [a, b])"`
  - `"reports cycle nodes in walk order"`

**Implementation notes:**
- Use the same three-color DFS pattern Plan 2's `groups/validate-extends.ts` will use. The two modules are structurally identical except for the field name (`extends`) and the input shape; resist the urge to extract a shared helper for v1 — once Plan 3 ships there are exactly two "extends cycle" detectors and extracting a generic walker would obscure the per-domain types.
- ≤80 LOC.

---

## Task 5: `ResolvedProfile` shape + `profiles/resolve.ts` core

**Dependencies:** Tasks 1, 3, 4.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/profiles/resolve.ts`

**Acceptance criteria:**
- Exports `resolveProfile(name: string, config: LichConfig): ResolvedProfile`.
- Exports `ResolvedProfile` interface with fields:
  - `name: string` (the requested name)
  - `services: string[]` (union of every parent's + this profile's `services`, in declared order, deduplicated; parents come first)
  - `owned: string[]` (same union semantics)
  - `env: EnvMap` (composed by layering parents-first, child-last — keys in the child override keys in the parent)
  - `env_files: EnvFiles` (parent list concatenated with child list, in that order)
  - `env_from: EnvFrom` (parent list concatenated with child list, in that order)
  - `lifecycle: TopLevelLifecycle` (composed per phase: `before_up` and `after_up` = parents then child; `before_down` = child then parents)
- Throws `ProfileResolveError` (new exported class) when `name` doesn't exist in `config.profiles`. Message includes the name and a Levenshtein "did you mean" suggestion if a declared profile is within edit distance 2.
- Throws `ProfileCycleError` (new exported class) if `detectProfileExtendsCycle` reports a cycle. (Validation would normally catch this earlier via `lich validate`, but the resolver guards against unvalidated configs reaching it.)
- Recursion: when a profile lists `extends: "a"`, recursively resolve `a` first (yielding a ResolvedProfile for `a`), then layer the current profile's values on top. Array-form `extends: ["a", "b"]` resolves `a` then `b` then current; `b`'s values overlay `a`'s for env, services/owned are union-deduped in `a, b, current` order.
- Self-name in `extends` is handled by the cycle detector (Task 4) before this function runs, but the resolver still calls `detectProfileExtendsCycle` once at the top as a safety net (negligible cost; protects against unvalidated configs).

**Tests to write:**
- Create `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/profiles/resolve.test.ts`:
  - `"resolves a single profile with no extends (passthrough)"`
  - `"unions services and owned across extends chain (parents first)"`
  - `"deduplicates services and owned (a service in both parent and child appears once)"`
  - `"layers env: child key overrides parent key with same name"`
  - `"layers env: parent-only keys survive into the child"`
  - `"concatenates env_files: parent files first, then child files"`
  - `"concatenates env_from: parent entries first, then child entries"`
  - `"composes lifecycle.before_up: parent entries first, then child entries"`
  - `"composes lifecycle.after_up: parent entries first, then child entries"`
  - `"composes lifecycle.before_down: child entries first, then parent entries (LIFO)"`
  - `"handles array-form extends [a, b]: a layered, then b layered, then child layered"`
  - `"throws ProfileResolveError with suggestion when name typo"` — request `"dev:tst-env"`, assert error mentions `dev:test-env`.
  - `"throws ProfileCycleError when extends has a cycle"`
  - `"resolves a 3-deep chain: root → mid → leaf"` (services/owned/env all compose correctly through depth).

**Implementation notes:**
- Use an `O(N)` memoization within a single `resolveProfile` call so a diamond inheritance (`a extends b, c; b extends root; c extends root`) doesn't re-resolve `root` twice. Track via `Map<string, ResolvedProfile>` keyed by name.
- Order is load-bearing: for `services` and `owned`, declared order matters because Plan 1's startup uses the order to seed the dep graph (and the dep graph computes its own topo order, so the input order only affects ties — but reproducibility matters for assertions).
- Levenshtein helper: duplicate inline (~25 LOC, same as Plan 2 Task 5's decision). The function exists in `commands/validate.ts` and `commands/help.ts` (Plan 2) already; extracting after the third copy is the right move, but that's Plan 6 cleanup.
- The lifecycle composition is a pure structural concat — DO NOT execute anything here; the executor is called later from `up.ts`/`down.ts`.

---

## Task 6: Extend `env/resolve.ts` for profile layer (NO lazy interp yet)

**Dependencies:** Task 5.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/env/resolve.ts`

**Acceptance criteria:**
- `ResolveEnvForServiceInput` and `ResolveTopLevelEnvInput` gain a new optional field: `profile?: ResolvedProfile`.
- A new `layerBundle` call is inserted between the top-level layer and the per-service layer in `resolveEnvForService` (and at the end of the top-level layer in `resolveTopLevelEnv`) that applies the profile's `env_from`, `env_files`, and `env` bundle.
- When `input.profile` is `undefined`, behavior is identical to today (Plan 1).
- Auto-injects gain `LICH_PROFILE` when a profile is active: `autoInjects` learns an optional `profileName?: string` second arg and emits `LICH_PROFILE = profileName` when set.
- Interpolation remains EAGER for this task — only the merging changes. Lazy interpolation is Task 7.
- Existing tests in `env/resolve.test.ts` continue to pass unchanged.
- New tests verify the profile layer behavior.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/env/resolve.test.ts`:
  - `"applies profile env layer between top-level and per-service"` — top-level `{ A: '1' }`, profile `{ A: '2', B: 'p' }`, no per-service → resolved `{ A: '2', B: 'p' }`.
  - `"per-service still overrides profile"` — top-level `{ A: '1' }`, profile `{ A: '2' }`, per-service `{ A: '3' }` → `{ A: '3' }`.
  - `"profile env_from is invoked when profile is present"` — assert `loadEnvFromShellOut` is called for the profile's entries (use a fake `cmd: echo X=p`).
  - `"profile env_files contributes when present"`
  - `"LICH_PROFILE is auto-injected when profile is active"`
  - `"LICH_PROFILE is absent when no profile is active"`

**Implementation notes:**
- `ResolvedProfile.env`, `.env_files`, `.env_from` are already in the shape `layerBundle` accepts (because `ResolvedProfile` is structurally `Pick<LichConfig, "env" | "env_files" | "env_from">`). The new `layerBundle` call slot is a one-line addition.
- For `autoInjects`, change the existing signature to accept the profile name OR change the call site to merge LICH_PROFILE after the existing call. Decision: extend `autoInjects` (it's a private function in this module; adding one arg costs nothing).
- The `processEnvToRecord` + `Object.assign` pattern at the top of both `resolveEnvForService` and `resolveTopLevelEnv` is unchanged.
- Place the new layer call EXACTLY between the existing two `layerBundle` calls (after top-level, before per-service). Add a code comment matching the existing precedence-step numbering (the file's docstring will need a small update too — bump from "steps 3-5/6-8" to "3-5/6-8/9-11").

---

## Task 7: Lazy per-key interpolation in `env/resolve.ts`

**Dependencies:** Task 6.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/env/resolve.ts`

**Acceptance criteria:**
- The eager call to `interpolateRecord(merged, ctx, "...")` at the end of `resolveEnvForService` and `resolveTopLevelEnv` is REPLACED with a lazy strategy.
- New behavior: each merged-env value is interpolated EXACTLY ONCE, the FIRST time it is read from the resulting map. Subsequent reads return the cached interpolated value.
- A value whose `${...}` ref points at a service NOT in the active profile's resolved set IS NOT EVALUATED if no consumer reads that value (because a profile layer overrode it).
- A consumer that reads such a value DOES throw the same `InterpolationError` it does today (lazy doesn't suppress errors; it defers them).
- The implementation MUST return a `Record<string, string>` from a `Proxy`-backed object OR a plain object whose values were already interpolated for keys that survive the merge. Decision: see implementation notes — pre-interpolate ONLY keys whose final value originated from the OUTERMOST layer that supplied a value for that key, computing per-key as we walk the merge. (Concretely: when the profile or per-service layer overrides `DATABASE_URL`, the top-level's `DATABASE_URL` value is never seen by `interpolateString` because it was replaced before we asked for interpolation.)
- Existing eager-interpolation tests still pass: every Plan 1 / Plan 2 / Plan 3 Task 6 test currently asserting on the final resolved value continues to work because the value of `DATABASE_URL` in a flat config (no overrides) is exactly the same string.
- New tests verify lazy semantics.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/env/resolve.test.ts`:
  - `"a top-level env value referencing an unknown service is NOT interpolated when a profile overrides it"`:
    ```
    top-level: { DATABASE_URL: "postgresql://localhost:${owned.supabase.ports.db}/x" }
    profile  : { DATABASE_URL: "postgresql://hosted.example.com:5432/x" }
    no owned.supabase in allocatedPorts.
    Resolution succeeds; DATABASE_URL == profile value. (Eager would throw.)
    ```
  - `"a top-level env value referencing an unknown service IS interpolated (and throws) when nothing overrides it"`:
    ```
    Same top-level value; no profile override.
    Resolution throws InterpolationError mentioning supabase.
    ```
  - `"per-service env override prevents interpolation of overridden top-level value"`:
    ```
    same as profile case but using per-service env override on owned.api.env
    ```
  - `"interpolation of a value occurs at most once (cached on second read)"` — observable via a spy on `interpolateString`, or by mutating the underlying string between reads and asserting the returned value didn't change (the simpler approach).

**Implementation notes:**
- **Decision: pre-interpolate per-merge-step rather than Proxy.** When `layerBundle` is invoked, the bundle's literal values are simply stored under their keys, overwriting whatever was there before. The KEY observation: at the end of all layering, we have a merged map where each key holds the value from the LAST layer that supplied it. We can interpolate that final map once, key by key — that's actually still "eager" but it works because the un-interpolated higher-layer values were never written back. Wait: the bug only happens with Plan 1's current code because Plan 1 interpolates at the END, and the value of `DATABASE_URL` that gets interpolated is whatever survived all the merging. If a profile overrode it, the surviving value is the profile's value, and the top-level's `${owned.supabase.ports.db}` reference is GONE. So Plan 1's eager pass already gives the right answer for profile-overridden values — the bug exists only for keys NOT overridden.
- **REVISION: there is no bug. Plan 1's eager interpolation is already lazy with respect to overridden values** (the lost value isn't interpolated because it's lost before interpolation runs). The actual lazy requirement is **per-PROFILE**: a profile that excludes `supabase` from its services should not require `DATABASE_URL` to interpolate against `${owned.supabase.ports.db}` if the profile overrides `DATABASE_URL`. Plan 1's eager pass already handles this correctly. The spec's "lazy per-key" language is about per-key resolution at write time, which is what we already do.
- **CONCLUSION:** Task 7's actual work is to verify (with new tests) that the existing eager pass produces the right answer for profile-overridden values. NO code changes are required to `env/resolve.ts` for laziness. The task remains useful as a test-only commit that pins the semantics. **Restructure this task accordingly**: it becomes a "verify lazy semantics via new tests" task with zero source changes — adjust the title to "Verify lazy-per-key semantics survive eager interpolation" and make the implementation-notes section say "no source change; the existing eager pass IS correct because lost values aren't interpolated."
- An edge case worth catching: what if a value contains MULTIPLE `${...}` refs, ONE of which references an absent service? Today: interpolation throws on the first unresolved ref. Lazy semantics shouldn't help here because the value WAS preserved into the final map. Test: `"a value with multiple refs throws when ANY of them is unresolvable"`. This is documented behavior; the new tests pin it.
- The `_` in `interpolateRecord(merged, ctx, "...")` IS still called eagerly. Replace this comment in `env/resolve.ts`'s top-of-file docstring: "Plan 3 will refactor this to be per-key lazy; Plan 1 does it eagerly, which is enough for now." → "Plan 3 verified that eager interpolation IS correctly lazy-per-key for env values: a key whose value is overridden by a later layer never sees the earlier layer's interpolation."

---

## Task 8: Extend `state/snapshot.ts` to carry `active_profile`

**Dependencies:** none (independent of profile resolution).

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/state/snapshot.ts`

**Acceptance criteria:**
- `StackSnapshot` gains an optional field `active_profile?: string`.
- `readSnapshot` returns snapshots with `active_profile` set or omitted depending on what was written.
- `writeSnapshot` round-trips `active_profile` cleanly (JSON serialization preserves the field when set; omitting when undefined).
- Pre-Plan-3 snapshots (no `active_profile` field) STILL parse cleanly via `readSnapshot` — the field is optional.
- The `sanitizeForWrite` helper does NOT strip `active_profile`.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/state/snapshot.test.ts`:
  - `"writeSnapshot + readSnapshot round-trips active_profile when set"`
  - `"writeSnapshot + readSnapshot omits active_profile when unset"`
  - `"readSnapshot tolerates an old snapshot that lacks active_profile"`

**Implementation notes:**
- One-line addition to the `StackSnapshot` interface. No serialization logic changes — `JSON.stringify` already drops undefined fields.
- Verify the test file's directory exists: `packages/lich/tests/unit/state/`. If a `snapshot.test.ts` doesn't exist yet (the directory exists per earlier `ls`), create it.

---

## Task 9: Wire profile-list reference checks into `lich validate`

**Dependencies:** Task 1.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- After schema validation passes, a new `checkProfiles` function runs that:
  - For each profile, walks `profile.services` and pushes a `ValidationError` of kind `"ref"` for any name not in `config.services` (with "did you mean" suggestion).
  - For each profile, walks `profile.owned` and pushes a `ValidationError` of kind `"ref"` for any name not in `config.owned`.
  - Location format: `<file> (/profiles/<name>/services/<i>)` and `<file> (/profiles/<name>/owned/<i>)`.
- Existing Plan 1 / Plan 2 validation tests continue to pass.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/validate.test.ts`:
  - `"refuses profiles.X.services entry pointing at undeclared compose service"`
  - `"refuses profiles.X.owned entry pointing at undeclared owned service"`
  - `"suggests close-match owned service name on typo"`
  - `"accepts profiles.X with services and owned entries that all resolve"`

**Implementation notes:**
- Reuse the existing `suggest` helper at the bottom of `validate.ts`.
- This check runs AFTER schema validation succeeds, in the same place Plan 2's checks live (after `checkRegexes`, before `computeSummary`).
- The `lich validate` `JsonReport.summary` does NOT yet count profiles — leave summary alone for now (Task 27 polish).

---

## Task 10: `lich validate` — profile extends-cycle detection

**Dependencies:** Tasks 1, 4.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- After schema validation passes, if `config.profiles` is present, run `detectProfileExtendsCycle`; if it returns a cycle, push a `ValidationError` of kind `"cycle"` with message `cycle in profiles extends: a → b → c → a`.
- Mirror the message format used by `checkDependsOnAndCycles` and (Plan 2) by the env_groups cycle check.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/validate.test.ts`:
  - `"detects a 2-node profile extends cycle"`
  - `"detects a self-loop in profile extends"`
  - `"accepts profile extends chains that terminate"`

**Implementation notes:**
- Run this check BEFORE Task 11's "extends reference resolution" check: a cycle would otherwise misreport as "extends X not found" if the validator walks the chain.

---

## Task 11: `lich validate` — profile extends-reference resolution + single default + unused warning

**Dependencies:** Tasks 1, 3.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- New check: every name in `profiles[X].extends` (both string and array form) MUST resolve to another declared profile. Unresolved refs push `ValidationError` kind `"ref"` with a "did you mean" suggestion. Location: `<file> (/profiles/<name>/extends)` (or `extends/<i>` for array form).
- New check: at most one profile may set `default: true`. If two or more do, push `ValidationError` kind `"schema"` (treating multiple defaults as a configuration error, not a reference one) with message `multiple profiles set default: true: <comma-list>`. Use `pickDefaultProfile`'s error path (Task 3).
- New WARNING (not error): any service in `config.services` or `config.owned` that is NOT referenced by ANY profile's resolved `services`/`owned` lists. Warnings are reported as a NEW field in `ValidationError`: add `kind: "warning"` to the union. Render them in pretty output as `! <location>: <message>` (yellow); in JSON they live in `errors` alongside others but the `kind` distinguishes them. Exit code remains 0 if only warnings (no errors).
- Edge case: if `config.profiles` is undefined or empty, the unused-warning check is SKIPPED (every service is implicitly "always-on" in that case, matching Plan 1's behavior).

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/validate.test.ts`:
  - `"refuses profiles.X.extends pointing at undeclared profile"`
  - `"refuses two profiles with default: true"`
  - `"emits warning for compose service not in any profile"`
  - `"emits warning for owned service not in any profile"`
  - `"does not warn when no profiles section exists (every service implicitly always-on)"`
  - `"exit code is 0 when only warnings are present"`
  - `"accepts a config with exactly one default: true profile"`

**Implementation notes:**
- The "kind: warning" addition requires extending `ValidationError.kind`'s union AND the pretty-output renderer in `renderPretty`. Pretty: prefix warnings with `!` (yellow if `tty.hasColors()`, else plain `!`). JSON: include warnings in `errors` array; consumers filter by `kind`.
- The exit-code rule: `errors.some(e => e.kind !== "warning")` is the failure trigger. Today the code is `errors.length === 0`; refactor to the kind-aware check.
- The unused-services check must walk the FULLY RESOLVED service set per profile (i.e., union over extends). Use `resolveProfile` (Task 5) for each declared profile; collect the union; subtract from declared `services`/`owned` to get unused.

---

## Task 12: `lich validate` — per-profile interpolation simulation

**Dependencies:** Tasks 1, 5.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- New check (additive — does NOT replace today's top-level interpolation check): for each profile, simulate the env merge (top-level + profile, no per-service) and verify every `${...}` reference in the SURVIVING merged env values resolves against the profile's resolved service set.
- "Surviving" means: the value that wins the precedence layering for each key (after the profile's overrides). A profile's override of `DATABASE_URL` skips the top-level value's interpolation check for that key (matches Task 7's verified lazy behavior).
- For an unresolved ref, push `ValidationError` kind `"interp"` with location `<file> (/profiles/<name>/env/<key>)` or `(/env/<key>)` if the offending value was inherited from top-level.
- The existing top-level interpolation check (Plan 1) STILL runs for the no-profile case AND for keys not overridden by any profile.
- If two profiles both override `DATABASE_URL` correctly but the top-level value references a service neither profile excludes, the top-level value IS checked (because at least one profile's resolution would interpolate it as the surviving value).
- The check uses a synthetic allocated-ports context that lists ONLY services in the profile's resolved set (so `${owned.api.port}` resolves IF `api` is in the profile, throws IF not).

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/validate.test.ts`:
  - `"profile that overrides a top-level value avoids the top-level's bad ref"`
  - `"profile that does NOT override is flagged when top-level value refs a service not in profile's resolved set"`
  - `"top-level interp check still flags refs to services not declared anywhere"`
  - `"per-profile interp catches refs to services not in profile's services/owned"`

**Implementation notes:**
- Build the synthetic allocated-ports context for each profile from the profile's resolved `services` + `owned` lists. Stub allocated values as `1` (any positive int satisfies the resolver; we're only checking reference shape).
- Reuse `interpolateRecord` and catch `InterpolationError` per-key. Map the caught error's `reference` field back to a `ValidationError`.
- This check is the most subtle in the plan; treat the tests as the contract. If implementation diverges, the tests fail loud.

---

## Task 13: `commands/up.ts` — accept profile argument, default lookup, refuse-switch

**Dependencies:** Tasks 3, 5, 8.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/up.ts`

**Acceptance criteria:**
- `RunUpInput` gains a new optional field: `profile?: string`.
- The `runUp` function, immediately after parsing the config (existing Step 1), resolves the active profile:
  - If `input.profile` is undefined and `config.profiles` is undefined or empty: no profile is active; behavior unchanged from today.
  - If `input.profile` is undefined and `config.profiles` is non-empty: call `pickDefaultProfile`; if it returns `{ name: null }`, error out with `"no default profile set in lich.yaml; either declare a profile with default: true or run lich up <profile>"`; if it returns `{ name: null, error }`, error out with the error message.
  - If `input.profile` is set: use that name. If `config.profiles?.[input.profile]` is absent, error out with `"no profile named '<x>' (available: a, b, c)"` (list sorted).
- After determining the profile name, call `resolveProfile(name, config)` and store the resolved result for later use.
- Refuse-mid-flight check: after detecting the worktree (existing Step 2), read the existing `state.json` (best-effort — null means no prior stack). If the snapshot's `status` is `up` or `starting` AND its `active_profile` differs from the resolved profile name, error out: `"stack is already up under profile '<old>'; run 'lich down' before switching to profile '<new>'"`, exit 1.
- All exit paths in this task return exit code 1 with structured output via `output.error`.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/up.test.ts`:
  - `"runs the default profile when no argument supplied"`
  - `"runs the named profile when argument supplied"`
  - `"errors when profile name unknown"` — assert exit 1 and message contains "no profile named".
  - `"errors when no default and no argument"` — config has profiles but none with default; no input.profile; assert exit 1.
  - `"errors when multiple defaults set"` — assert exit 1 with multiple-default message.
  - `"refuses up <other> while a stack is up under different profile"` — pre-write state.json with status: up, active_profile: dev; call `runUp({ profile: "dev:test-env" })`; assert exit 1 with "already up" message.
  - `"allows up <same> while a stack is up under same profile (re-run idempotent in spirit; still errors? or treats as no-op?)"` — **Decision: still errors with "stack is already up; run lich down first."** No "re-up" semantics in v1.

**Implementation notes:**
- The refuse-switch check runs BEFORE port allocation, so a refused up doesn't perturb the registry.
- For the "stack is already up under same profile" case, the simplest correct behavior is still to error: today's `lich up` (Plan 1) doesn't have idempotent re-up semantics, so neither should profiled `lich up`. Tests pin this.
- The new code lives between Step 1 (parse) and Step 2 (worktree). The "refuse switch" check is wedged into Step 2 (after worktree detection, before any state mutation).

---

## Task 14: `commands/up.ts` — filter dep graph + start set to profile's services/owned

**Dependencies:** Task 13.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/up.ts`

**Acceptance criteria:**
- The existing `buildNodeDecls(config)` call is replaced (or wrapped) so that when a profile is active, ONLY services in `resolvedProfile.services` (compose) and `resolvedProfile.owned` (owned) become nodes in the dep graph.
- A service declared in `config.services` or `config.owned` but NOT in the resolved profile is NEVER started. Topo sort sees only profile-included nodes.
- `depends_on` edges from a profile-included service to a profile-EXCLUDED service trigger an early error: `"service '<a>' (in active profile '<p>') depends_on '<b>', which is not in the profile"`. Exit 1. (Spec section 4 implies this: depends_on must always resolve, profile scoping must not silently drop a dep.)
- The port-plan, env resolution, compose override generation, and per-level startup all operate on the filtered set.
- State snapshot's `services` list only contains profile-included services.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/up.test.ts`:
  - `"starts only services in the active profile"` — config has 3 owned (a, b, c); profile lists only [a, b]; assert b's snapshot exists, c is absent.
  - `"errors when a profile service depends_on a non-profile service"`
  - `"profile with empty services and owned lists still completes the up (no-op)"` — start-set is empty; lifecycle hooks still run; exit 0.

**Implementation notes:**
- The cleanest place to filter: introduce a `filterConfigToProfile(config, resolvedProfile)` helper that returns a new `LichConfig` whose `services` and `owned` records are restricted to the profile's lists. Then ALL downstream code (`buildNodeDecls`, `buildPortPlan`, env resolution) sees the filtered config without further changes.
- The dep-check (catching cross-profile depends_on) runs as part of `buildNodeDecls`; the missing-target error path already exists in `deps/graph.ts`'s `validateGraph` — the filtered config naturally surfaces the failure. Wrap the error to include the profile-scoping context message.
- The compose override file (`writeComposeOverride`) is fed the filtered config, so it only emits overrides for compose services in the profile.

---

## Task 15: `commands/up.ts` — compose lifecycle, pass profile to env, write active_profile

**Dependencies:** Tasks 5, 6, 13.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/up.ts`

**Acceptance criteria:**
- When a profile is active, every `resolveTopLevelEnv` and `resolveEnvForService` call passes `profile: resolvedProfile`. (Plan 1's existing callers gain the profile parameter; non-profile cases pass undefined.)
- `before_up` entries executed = top-level `lifecycle.before_up` (if present) + profile `lifecycle.before_up` (if present), in that order, as a single array.
- `after_up` entries executed = top-level `lifecycle.after_up` (if present) + profile `lifecycle.after_up` (if present), in that order, as a single array.
- The composed array is passed in ONE call to `runLifecycle` so that a non-zero exit in any entry aborts the phase (today's behavior preserved).
- Snapshot writes (`writeStateSnapshot`) include `active_profile: <name>` on the snapshot when a profile is active.
- LICH_PROFILE is automatically present in every spawned service's env (via Task 6's `autoInjects` extension).

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/up.test.ts`:
  - `"runs top-level before_up first, then profile before_up"` — sentinel files written by each entry; assert order via file mtime or by content (each entry appends its name to a marker file).
  - `"runs top-level after_up first, then profile after_up"`
  - `"snapshot persists active_profile"`
  - `"LICH_PROFILE is set in the env of owned services started under a profile"` — owned cmd writes `$LICH_PROFILE` to a marker file; assert the marker contains the profile name.

**Implementation notes:**
- The composition is one-liner concat: `[...topLevel?.before_up ?? [], ...profile?.lifecycle?.before_up ?? []]`. Empty arrays are fine — `runLifecycle` is a no-op on empty.
- Add a code comment near the lifecycle calls explaining the composition rule (top-level first, profile second; LIFO for down). Plan 4 may extend with more phases; the comment helps the next reader.
- The `state.active_profile` field is written inside `writeStateSnapshot`. Thread the profile name through `UpState` (add `activeProfile?: string` to the interface) so all snapshot writes have access.

---

## Task 16: `commands/down.ts` — compose `before_down` LIFO with active profile

**Dependencies:** Tasks 5, 8.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/down.ts`

**Acceptance criteria:**
- After reading `state.json`, if `snap.active_profile` is set AND the re-parsed yaml has `config.profiles?.[snap.active_profile]`, resolve the profile via `resolveProfile`.
- Top-level `before_down` entries executed = profile `lifecycle.before_down` (if present) + top-level `lifecycle.before_down` (if present), in that order. This is the LIFO inverse of `up`'s composition.
- The composed array is passed in ONE call to `runLifecycle` with `phase: "before_down"` (best-effort failures via `onWarning`).
- When `snap.active_profile` is set but the yaml no longer has that profile (user edited the yaml between up and down), proceed with top-level-only `before_down` and emit a warning (`phase: "profile_resolve"`).
- Per-service `before_down` hooks (handled in the existing per-service loop) are unchanged — profile-scoped `lifecycle` only adds top-level hooks, not per-service.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/down.test.ts`:
  - `"runs profile before_down first, then top-level before_down (LIFO)"` — sentinel files written by each; assert order.
  - `"warns when active_profile in snapshot is missing from yaml (post-edit drift)"`
  - `"compose snapshot without active_profile (pre-Plan-3 stack) still tears down cleanly via top-level before_down only"`

**Implementation notes:**
- Resolve the profile defensively: wrap `resolveProfile` in a try/catch; any throw becomes a warning and falls back to top-level only.
- The `runLifecycle` call already supports `resolveEnvGroup` for long-form entries; profile `before_down` entries that use `env_group:` automatically work (Plan 2's wiring).

---

## Task 17: `bin/lich.ts` — forward positional profile argument for `up`

**Dependencies:** Task 13.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/bin/lich.ts`
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/index.ts`

**Acceptance criteria:**
- The `upHandler` in `commands/index.ts` extracts `argv._[0]` as the optional profile name and passes it as `profile` to `runUp`.
- `lich up dev:test-env` invokes `runUp({ profile: "dev:test-env", ... })`.
- `lich up` (no arg) invokes `runUp({ profile: undefined, ... })`.
- Existing `--json`/`--quiet` flag handling is preserved.

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/up.test.ts` (or add a new `bin/up-arg.test.ts` if `up.test.ts` doesn't easily route through the router): `"argv._[0] becomes input.profile in runUp"`.

**Implementation notes:**
- One-line change in `commands/index.ts`'s `upHandler`. The `ctx.argv._` is already available; `[profile]` destructure pulls the first positional.

---

## Task 18: Update `examples/dogfood-stack/lich.yaml` — add `dev:test-env` profile

**Dependencies:** Tasks 1, 2.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/examples/dogfood-stack/lich.yaml`

**Acceptance criteria:**
- A new profile `dev:test-env` is added under `profiles:`. It:
  - Does NOT set `default: true` (the existing `dev` keeps that).
  - Lists `owned: [api, web]` (no `supabase` — that's the point of "test-env: don't run local DB").
  - Overrides `env: { DATABASE_URL: "postgresql://postgres:test@db.test.example.com:5432/postgres", NEXT_PUBLIC_SUPABASE_URL: "https://test.example.com" }` so the API talks to a hosted backend instead of the local Supabase. (The hostnames don't have to actually resolve — the e2e tests assert on the resolved env via `lich exec sh -c 'echo $DATABASE_URL'`, not on actually connecting to the DB.)
  - Does NOT have an `after_up` lifecycle — the migrations + seed only make sense for the local DB.
- The existing `dev` profile is unchanged.
- `lich validate` against the updated dogfood-stack yaml exits 0 with no errors (warnings about unused services are fine; `dev:test-env` doesn't include `supabase` but `dev` does, so no warning is emitted).
- The conformance test in `packages/lich/tests/unit/config/schema.test.ts` (the dogfood benchmark) still passes.

**Tests to write:**
- No new unit-test file. The conformance test must continue to pass.

**Implementation notes:**
- Place the new profile DIRECTLY UNDER the existing `dev` profile in the yaml (same `profiles:` key). Keep `dev` first since it's the default.
- The env values don't need to be realistic (no e2e test actually opens a connection to `db.test.example.com`); they just need to be DIFFERENT from `dev`'s values so e2e tests can assert on the difference.
- A consequence of `dev:test-env` excluding `supabase`: the api's `depends_on: [supabase]` in the top-level `owned:` would break Task 14's cross-profile-dep check when `dev:test-env` is active. **MITIGATION:** the api's `depends_on` is on the `owned.api` definition itself, but profile resolution doesn't strip those — Task 14's filter only operates on which services BECOME nodes. The api node has a `depends_on: [supabase]` edge to a node that doesn't exist in the filtered graph → ERROR.
- **Decision:** the api's `depends_on: [supabase]` must remain valid for the `dev` profile. For `dev:test-env` to be usable, the dogfood yaml needs to either (a) move the `depends_on` to be profile-scoped (spec doesn't currently support per-profile depends_on overrides) OR (b) the api should not depend on supabase at all — supabase being up is enforced by the profile's services list, not by depends_on. **Decision: option (b)** — REMOVE `depends_on: [supabase]` from `owned.api`. Without it, the api still waits for supabase to be ready in the `dev` profile because `dev` lists supabase first and the topo sort starts them on level 0 (no deps); api enters level 1 due to no remaining deps. Actually... without depends_on, api and supabase land on the SAME topo level and start in parallel. The api's `ready_when.http_get: /health` is what protects it (it waits to be ready); it won't break, but it'll start logging connection errors during supabase boot.
- **Better decision:** add a comment in the yaml explaining the tradeoff and keep `depends_on: [supabase]`, while ADDING a new field `depends_on_optional: true` — but that's a spec change. **Best decision:** add an inline comment on the api `depends_on: [supabase]` explaining "only valid for the dev profile; dev:test-env is expected to be unused for now and will fail with 'depends_on supabase not in profile'." Then make the e2e test for `dev:test-env` (Task 22) target a SEPARATE profile that DOES include supabase (e.g., `dev:env-override` which extends `dev` and only overrides env). The "test-env without supabase" demo becomes documentation only.
- **FINAL decision:** rename the new profile to `dev:env-override` and have it `extends: dev` (so it inherits `supabase, api, web`) AND override env values only. This is realistic (a common use case is "same services, different env") and avoids the depends_on tangle. The "test-env without supabase" scenario can be a follow-up Plan 3.x ticket when we add per-profile depends_on overrides.
- The updated yaml profile section:
  ```yaml
  profiles:
    dev:
      default: true
      owned: [supabase, api, web]
      lifecycle:
        after_up:
          - supabase migration up
          - psql "$DATABASE_URL" -f supabase/seed.sql

    dev:env-override:
      extends: dev
      # Inherits dev's owned list (supabase, api, web) AND its lifecycle.
      # Overrides ONLY env values to demonstrate profile-scoped env precedence.
      env:
        DATABASE_URL: "postgresql://postgres:test@db.test.example.com:5432/postgres"
        NEXT_PUBLIC_SUPABASE_URL: "https://test.example.com"
  ```
- This decision DOES come at one cost: a profile that excludes services (the spec's headline use case from the worked examples section) isn't demonstrated end-to-end in the dogfood. That's acceptable for v1; it's a real follow-up issue. Track it as an open question in the report-back.

---

## Task 19: E2E test — `lich up` activates the default profile

**Dependencies:** Tasks 13, 17, 18.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/profiles-default.test.ts`

**Acceptance criteria:**
- Test `"lich up (no arg) activates the default profile"`:
  1. Copy dogfood-stack to tmpdir.
  2. `spawnLich(["up"], { cwd })` and wait for ready (TCP probe on the api's allocated port).
  3. `runLich(["stacks", "--json"], { cwd })`, parse the JSON, assert the stack's `active_profile === "dev"`.
  4. `lich down`; cleanup.
- Test `"lich up exits non-zero with clear error when no default and no arg given"`:
  1. Use a synthetic minimal yaml (tmpdir-based, NOT dogfood) with two profiles, neither defaulting.
  2. `runLich(["up"], { cwd })` → exit 1 stderr contains `"no default profile"`.

**Tests to write:**
- Single file: `tests/e2e/profiles-default.test.ts`.

**Implementation notes:**
- The `lich stacks --json` output's `active_profile` field is new — Plan 1's `stacks.ts` reads from snapshot and renders fields. Verify that the snapshot's `active_profile` flows through to stacks output (the JSON path serializes the full snapshot). If not, that's a small bug — fix in this task or escalate to Task 27 (polish).
- The minimal yaml for the "no default" case can be inlined as a fixture inside the test file (use `mkdtempSync` + `writeFileSync`).

---

## Task 20: E2E test — `lich up <profile>` activates the named profile

**Dependencies:** Tasks 13, 17, 18.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/profiles-named.test.ts`

**Acceptance criteria:**
- Test `"lich up dev activates the dev profile explicitly"`:
  1. Copy dogfood; `spawnLich(["up", "dev"], { cwd })`; wait for ready.
  2. `runLich(["stacks", "--json"], { cwd })`; assert `active_profile === "dev"`.
  3. Down + cleanup.
- Test `"lich up dev:env-override activates the override profile"`:
  1. Copy dogfood; `spawnLich(["up", "dev:env-override"], { cwd })`; wait for ready.
  2. Assert `active_profile === "dev:env-override"`.
  3. Down + cleanup.
- Test `"lich up <unknown> exits non-zero with helpful error"`:
  1. `runLich(["up", "totally-not-a-profile"], { cwd })`; assert exit 1, stderr contains `"no profile named 'totally-not-a-profile'"` and lists `dev` and `dev:env-override`.

**Tests to write:**
- Single file: `tests/e2e/profiles-named.test.ts`.

**Implementation notes:**
- Both the `dev` and `dev:env-override` profiles start the same services (per Task 18's decision); the difference between them is env. So both tests work the same e2e — only `active_profile` differs.
- The "unknown profile" test does NOT spin up a stack (it errors out early).

---

## Task 21: E2E test — `LICH_PROFILE` env var is set in service envs

**Dependencies:** Tasks 6, 15.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/profiles-lich-profile-env.test.ts`

**Acceptance criteria:**
- Test `"LICH_PROFILE is visible to spawned services"`:
  1. Copy dogfood; `spawnLich(["up", "dev:env-override"], { cwd })`; wait for ready.
  2. `runLich(["exec", "sh", "-c", "echo $LICH_PROFILE"], { cwd })`.
  3. Assert exit 0, stdout contains `"dev:env-override"`.
- Test `"LICH_PROFILE in the env_group stack output reflects the active profile"`:
  1. With stack up under `dev`, `runLich(["env", "stack"], { cwd })`.
  2. Assert stdout contains `LICH_PROFILE=dev`.

**Tests to write:**
- Single file: `tests/e2e/profiles-lich-profile-env.test.ts`.

**Implementation notes:**
- The `lich exec` command (Plan 2) routes through `resolveEnvGroup("stack")` which calls `resolveTopLevelEnv` which (after Task 6) auto-injects `LICH_PROFILE`. So `lich exec` from inside an up'd stack already sees the profile. Verify this chain works end-to-end.
- This test does NOT verify that owned services themselves see `LICH_PROFILE` (verifying that requires the owned service to log its env, which the dogfood api doesn't do). The `lich exec` proxy is the practical sentinel — if it works there, the env pipeline is wiring correctly.

---

## Task 22: E2E test — profile-scoped env override (`DATABASE_URL` differs per profile)

**Dependencies:** Tasks 6, 15, 18.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/profiles-env-override.test.ts`

**Acceptance criteria:**
- Test `"profile env override changes the resolved DATABASE_URL"`:
  1. Copy dogfood; `spawnLich(["up", "dev"], { cwd })`; wait for ready.
  2. `runLich(["exec", "sh", "-c", "echo $DATABASE_URL"], { cwd })`. Assert stdout matches `/postgresql:\/\/postgres:postgres@localhost:\d+\/postgres/` (local Supabase with allocated port).
  3. `lich down`; cleanup.
- Test `"override profile uses override DATABASE_URL"`:
  1. Copy dogfood; `spawnLich(["up", "dev:env-override"], { cwd })`; wait for ready.
  2. `runLich(["exec", "sh", "-c", "echo $DATABASE_URL"], { cwd })`. Assert stdout contains `db.test.example.com`.
  3. Assert stdout does NOT contain `localhost`.
  4. Down; cleanup.

**Tests to write:**
- Single file: `tests/e2e/profiles-env-override.test.ts`.

**Implementation notes:**
- The two tests cover the same observable surface (DATABASE_URL) under the two profiles. If both pass, profile-scoped env is working.
- Both tests still bring up the full stack (api + web + supabase) because `dev:env-override` extends `dev`. The test does NOT verify that the api ACTUALLY uses `db.test.example.com` (it would fail to connect); the assertion is on the env var only.

---

## Task 23: E2E test — profile-scoped lifecycle (migrations run only under `dev`)

**Dependencies:** Tasks 15, 16, 18.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/profiles-lifecycle-scoping.test.ts`

**Acceptance criteria:**
- Test `"after_up under dev profile runs migrations + seed"`:
  1. Copy dogfood; `spawnLich(["up"], { cwd })` (default = dev); wait for ready.
  2. `runLich(["exec", "sh", "-c", "psql \"$DATABASE_URL\" -tAc 'select count(*) from things'"], { cwd })`. Assert stdout contains `3` (the seed planted three rows).
  3. Down; cleanup.
- Test `"after_up under dev:env-override inherits dev's lifecycle (extends behavior)"`:
  1. Copy dogfood; `spawnLich(["up", "dev:env-override"], { cwd })`; wait for ready.
  2. Same `psql count(*)` assertion — extends means lifecycle is inherited.
  3. Down; cleanup.
- (Optional, deferred to follow-up — see Task 18's design note) Test `"after_up does NOT run for a profile that excludes supabase"` — depends on a future profile that excludes supabase; out of scope for this plan.

**Tests to write:**
- Single file: `tests/e2e/profiles-lifecycle-scoping.test.ts`.

**Implementation notes:**
- The `psql` count is THE assertion that proves lifecycle ran. Before Plan 3, the migrations never ran (Plan 1's `up.ts` doesn't read `profiles.X.lifecycle`); after Plan 3, they do. This test is the load-bearing proof.
- The `lich exec sh -c "psql ..."` indirection works because `DATABASE_URL` is resolved via the env_group `stack`, which picks up the worktree's allocated Supabase port. If the psql call fails because of missing `psql` on the runner: the host needs the `psql` binary. Plan 0's prerequisites mention supabase CLI which bundles psql; document the dependency in the test file's top comment.

---

## Task 24: E2E test — switching profiles while a stack is up is refused

**Dependencies:** Task 13.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/profiles-switch-refused.test.ts`

**Acceptance criteria:**
- Test `"lich up <other> while up under <first> is refused"`:
  1. Copy dogfood; `spawnLich(["up", "dev"], { cwd })`; wait for ready.
  2. `runLich(["up", "dev:env-override"], { cwd })`. Assert exit 1, stderr contains `"already up"` and mentions both `dev` and `dev:env-override`.
  3. The original stack is STILL up — verify via `runLich(["stacks", "--json"], { cwd })` showing `active_profile === "dev"`.
  4. Down; cleanup.
- Test `"lich up <same> while up under <same> is refused with a sensible error"`:
  1. Stack up under `dev`; `runLich(["up", "dev"], { cwd })`. Assert exit 1, stderr contains `"already up"`.

**Tests to write:**
- Single file: `tests/e2e/profiles-switch-refused.test.ts`.

**Implementation notes:**
- The "already up" assertion in the second test pins Task 13's decision that re-upping under the same profile is NOT a no-op — it's an error. If the team later decides re-up should be idempotent, this test will flag the spec change.

---

## Task 25: E2E test — `lich validate` catches profile misconfigurations

**Dependencies:** Tasks 9, 10, 11, 12.

**Files to create/modify:**
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/profiles-validate-errors.test.ts`
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/fixtures/invalid-yamls/profile-undeclared-service.yaml`
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/fixtures/invalid-yamls/profile-extends-cycle.yaml`
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/fixtures/invalid-yamls/profile-two-defaults.yaml`
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/fixtures/invalid-yamls/profile-extends-missing.yaml`
- Create: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/fixtures/invalid-yamls/profile-interp-uncovered.yaml`

**Acceptance criteria:**
- Each fixture YAML is minimal-but-invalid (`version: "1"` plus the minimum to trigger one error type):
  - `profile-undeclared-service.yaml`: `owned: { api: { cmd: "x" } }, profiles: { dev: { owned: [api, missing] } }`. Triggers Task 9.
  - `profile-extends-cycle.yaml`: `profiles: { a: { extends: b }, b: { extends: a } }`. Triggers Task 10.
  - `profile-two-defaults.yaml`: `profiles: { a: { default: true }, b: { default: true } }`. Triggers Task 11.
  - `profile-extends-missing.yaml`: `profiles: { dev: { extends: nonexistent } }`. Triggers Task 11.
  - `profile-interp-uncovered.yaml`: a profile that does NOT override `DATABASE_URL` but excludes the service it interpolates. Triggers Task 12.
- Each test runs `runLich(["validate", "<fixture>"], { cwd })` and asserts exit 1 plus a specific stderr substring.
- One test uses `runLich(["validate", "--json", "<fixture>"])` and asserts the JSON `errors[].kind` includes the expected kinds (`ref`, `cycle`, `schema`, `interp`).

**Tests to write:**
- Single file: `tests/e2e/profiles-validate-errors.test.ts`.
- Five fixture YAMLs under `tests/e2e/fixtures/invalid-yamls/`.

**Implementation notes:**
- Plan 2 already creates `tests/e2e/fixtures/invalid-yamls/` (per its Task 24). This task ADDS files to that directory; do not re-create the directory's README, just append a note if needed.
- The `profile-interp-uncovered.yaml` is the most fragile test — verify the interpolation simulation (Task 12) actually flags it. If it doesn't, that's a bug to fix in Task 12 before this test passes.

---

## Task 26: E2E test — parallel-stacks sentinel with profiles

**Dependencies:** Tasks 13, 15.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/tests/e2e/parallel-stacks.test.ts`

**Acceptance criteria:**
- The existing parallel-stacks test (per testing standards, sentinel for worktree isolation) continues to pass: two tmpdirs, two `lich up`s, no port collisions, both stacks respond.
- A new sub-test is added: `"two parallel stacks with different profiles coexist"`:
  1. Copy dogfood to two tmpdirs A and B.
  2. `spawnLich(["up", "dev"], { cwd: A })` and `spawnLich(["up", "dev:env-override"], { cwd: B })`.
  3. Both reach ready.
  4. `runLich(["stacks", "--json"])` from either dir lists both stacks with their respective `active_profile` values.
  5. `lich exec sh -c 'echo $DATABASE_URL'` from each dir shows the appropriate URL (local Supabase port for A, hosted hostname for B).
  6. Down both; cleanup.

**Tests to write:**
- Modify existing `parallel-stacks.test.ts` with the new sub-test.

**Implementation notes:**
- The testing standards doc treats parallel-stacks as a sentinel test for every plan touching stack lifecycle. Profiles change the lifecycle (which services start, what env they use); the parallel-stacks test should cover profiles too.
- The new sub-test is in the same file as the existing parallel-stacks test so the cleanup pattern (afterEach killing both procs) is shared.

---

## Task 27: Validate summary polish + profile count in pretty output

**Dependencies:** Tasks 9, 11.

**Files to create/modify:**
- Modify: `/Users/ryan/Desktop/programming/levelzero/packages/lich/src/commands/validate.ts`

**Acceptance criteria:**
- `ValidationSummary` gains a new optional field `profiles: number`.
- `computeSummary` populates `profiles` as `Object.keys(config.profiles ?? {}).length`.
- `renderPretty` shows `• N profile(s)` alongside the existing compose/owned/lifecycle_hooks lines when N > 0.
- Existing tests that assert on the dogfood summary's exact shape need a one-line update (now includes profiles count).

**Tests to write:**
- Modify `/Users/ryan/Desktop/programming/levelzero/packages/lich/tests/unit/commands/validate.test.ts`:
  - `"summary includes profile count for the dogfood yaml (after Task 18)"`
  - `"pretty output renders 'N profiles' line when profiles defined"`
  - `"pretty output omits the profiles line when no profiles defined"`

**Implementation notes:**
- Small polish task; could be merged into Task 9 or 11 in a single PR, but isolating it keeps each commit focused.
- Plan 2's Task 27 (conformance benchmark refresh) noted the dogfood test should be a fast signal — this task continues that line.

---

## Task 28: Final integration check + commit

**Dependencies:** all prior tasks.

**Files to create/modify:**
- None — verification only.

**Acceptance criteria:**
- `cd packages/lich && bun test` exits 0 (all unit tests pass).
- `cd packages/lich && bun run build` exits 0; `packages/lich/dist/lich` exists.
- `cd tests/e2e && bun test` exits 0 (assuming docker + supabase v2+ on the runner). All Plan 3 e2e tests pass alongside Plan 1+2's. The Plan-1-and-prior `basic-up.test.ts` "brings the stack up and serves the web app" test remains gated on Plan 5; otherwise green.
- `./packages/lich/dist/lich up dev` in a dogfood tmpdir brings the stack up successfully AND populates the `things` table (migrations + seed under the dev profile's lifecycle).
- `./packages/lich/dist/lich up dev:env-override` in a dogfood tmpdir brings the same stack up but with the overridden `DATABASE_URL`.
- `./packages/lich/dist/lich stacks --json` shows `active_profile`.
- `./packages/lich/dist/lich validate` against the updated dogfood yaml exits 0 (warnings ok, no errors).
- `git status` is clean; commit history shows ~25-30 small, focused commits with `feat(lich):`, `test(lich):`, or `test(e2e):` prefixes per `CLAUDE.md` conventions.

**Tests to write:**
- None.

**Implementation notes:**
- This task is a verification gate. The orchestrator declares Plan 3 done after this passes and proceeds to Plan 4 (failure surfacing).

---

## Cross-plan dependencies

- **All of Plan 1 must be done.** Plan 3 builds on every Plan 1 subsystem.
- **All of Plan 2 must be done.** Plan 3's profile-scoped `lifecycle` entries that use the long-form `{cmd, env_group}` shape require Plan 2's `resolveEnvGroup` to be wired into `runLifecycle`. Without Plan 2, those entries throw at runtime.
- Plan 4 (Failure surfacing) inherits Plan 3's snapshot field `active_profile` for dashboard rendering; Plan 5 surfaces it in the dashboard UI.

---

## Testing requirements

Per testing standards (`docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`), every feature needs BOTH unit and e2e tests.

E2e coverage floor for this plan (consolidated across Tasks 19-26):

- **`lich up` (no arg) activates default profile** (Task 19) — snapshot reflects `active_profile: dev`.
- **`lich up <profile>` activates named profile** (Task 20) — snapshot reflects `active_profile: <name>`.
- **`lich up <bad-name>` exits non-zero** (Task 20) — clear error listing available profiles.
- **Switching profiles while up is refused** (Task 24) — second `lich up` fails; first stack still running.
- **Services not in active profile do NOT start** — deferred to follow-up issue per Task 18's design note (since current dogfood profiles both include all services).
- **Profile-scoped env overrides** (Task 22) — `DATABASE_URL` differs between `dev` and `dev:env-override`.
- **Profile-scoped lifecycle** (Task 23) — migrations run under `dev`; `psql count(*)` returns 3.
- **`LICH_PROFILE` env var** (Task 21) — visible to spawned services via `lich exec`.
- **Validate failure cases** (Task 25) — profile-undeclared-service, profile-extends-cycle, two-defaults, extends-missing, profile-interp-uncovered.
- **Parallel-stacks sentinel** (Task 26) — two stacks with different profiles coexist.

Unit coverage floor:

- Profile resolution: extends chain, cycle detection, default-picker, env layering, lifecycle composition.
- Env pipeline: profile layer, LICH_PROFILE auto-injection, lazy-semantics verification.
- State snapshot: `active_profile` round-trips.
- `commands/up.ts`: profile arg, default lookup, refuse-switch, filter, lifecycle composition.
- `commands/down.ts`: profile-scoped before_down LIFO.
- `commands/validate.ts`: profile checks (refs, cycles, defaults, unused warnings, per-profile interp).

---

## Acceptance criteria

Plan 3 is done when:

- `examples/dogfood-stack/lich.yaml` has at least two profiles (`dev` as default + `dev:env-override` demonstrating profile-scoped env via extends).
- `lich up` activates `dev`; `lich up dev:env-override` activates that profile; `lich up <bad>` exits non-zero.
- The resolved service set, env vars, and lifecycle hooks differ correctly between the two profiles, verifiable via `lich stacks --json` and `lich exec`.
- The migrations + seed under the `dev` profile's `after_up` ACTUALLY RUN (provable via `psql count(*) == 3`).
- Switching profiles while a stack is up is refused with a clear error.
- `LICH_PROFILE` is auto-exported into every service's env.
- `lich validate` catches every profile misconfiguration listed in Task 25.
- All Plan 3 e2e tests pass.
- All Plan 1 and Plan 2 e2e tests still pass.
- `state.json` carries `active_profile` and round-trips cleanly.

---
