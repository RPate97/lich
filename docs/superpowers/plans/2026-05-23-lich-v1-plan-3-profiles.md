# Lich v1 — Plan 3: Profiles

> **Status:** HIGH-LEVEL SHELL — task structure captured; per-task code/steps to be refined when this plan is ready to execute.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 3 profiles primitive, 4 profiles schema reference, 5 lich up [profile])

**Required reading:** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`

**Goal:** Add named slices of the stack. Profiles define which services start AND what env they run with AND what lifecycle hooks fire. Enables the user's "dev:full vs dev:lite vs dev:test-env" workflows. By end of plan, the dogfood-stack defines at least two profiles, `lich up [profile]` works, profile-scoped env overrides work, and profile-scoped lifecycle works.

**Builds on:** Plan 1 (services, owned, env, lifecycle), Plan 2 (env_groups for context — profiles use the same env primitives but a different layering).

**Architecture:** Profiles are a separate resolver that, given a profile name, computes (a) the resolved set of services and owned processes to start, (b) the profile-layered env (top-level + profile-scoped per-key), and (c) the composed lifecycle hooks (top-level + profile-scoped, with LIFO for before_down). The lich up command takes an optional profile argument; if omitted, uses the default. State directory records which profile is active so dashboard (Plan 5) can surface it.

---

## What this plan implements

From the spec section 3 + 4:

- **`profiles`** top-level config section
- Each profile: `services`, `owned`, `extends`, `default`, `env`, `env_files`, `env_from`, `lifecycle`
- Profile resolution: recursive `extends`, compute union of services/owned, layer env per-key, compose lifecycle
- Default profile (`default: true`) used by `lich up` with no arg
- Services and owned NOT in any profile never start; validate warns
- Switching profiles while a stack is up is refused

From the spec section 4 (env):

- Profile-scoped `env`, `env_files`, `env_from` layered on top of top-level per-key
- Lazy per-key interpolation (refactor of Plan 1's interpolation for this)
- Auto-exported `LICH_PROFILE` env var (in addition to `LICH_WORKTREE` and `LICH_STACK_ID` from Plan 1)

From the spec section 4 (lifecycle):

- Profile-scoped `lifecycle` block (before_up, after_up, before_down)
- Composition: top-level runs first, profile runs second for `before_*` / `after_*`; reversed (LIFO) for `before_down`
- Shorthand string form vs long-form `{cmd, env_group}` for lifecycle entries

From the spec section 5:

- `lich up [profile]` — argument selects profile
- `lich validate` gains profile reference checks (services/owned in profile lists exist, extends cycles, single default enforcement, unused-services warning)

---

## Subsystems introduced

### `profiles/`

- `resolve.ts` — given profile name, walk extends, compute resolved set
- `validate-extends.ts` — cycle detection over profile extends graph
- `start-set.ts` — produce the ordered list of services to start for a profile

### `env/resolve.ts` (extended)

- Add profile layer to per-key precedence: host process.env → top-level env_from → top-level env_files → top-level env → **profile env_from → profile env_files → profile env** → per-service overrides
- Implement lazy per-key interpolation (compile-time check that a key's value can be resolved against the active profile's resolved service set; deferred evaluation)

### `lifecycle/executor.ts` (extended)

- Accept both top-level and profile-scoped lifecycle blocks
- Run in the correct order (top-level → profile for before/after, reverse for before_down)
- Honor the long-form `{cmd, env_group}` for env_group selection per hook

### `commands/up.ts` (extended)

- Accept profile name argument
- Refuse if a stack is already up (or in a different profile)
- Write active profile name into state directory

### `state/snapshot.ts` (extended)

- Record `active_profile` in state.json

### `config/validate.ts` (extended)

- Validate profile-referenced names exist
- Walk extends for cycles
- Enforce at most one `default: true`
- Warn on services/owned not referenced by any profile
- Per-profile interpolation simulation: catch refs to services not in the profile's resolved set

---

## File structure delta

```
packages/lich/src/
  profiles/
    resolve.ts
    validate-extends.ts
    start-set.ts
  env/
    resolve.ts                   # EXTEND for profile layer + lazy per-key
  lifecycle/
    executor.ts                  # EXTEND for profile composition
  commands/
    up.ts                        # EXTEND for profile arg + state write
  state/
    snapshot.ts                  # EXTEND for active_profile
  config/
    schema.ts                    # EXTEND for profiles section
    validate.ts                  # EXTEND for profile checks

packages/lich/tests/unit/
  profiles/
  env/                           # add profile-layering test cases
  lifecycle/                     # add profile-composition test cases

tests/e2e/
  profiles-resolution.test.ts
  profiles-env-override.test.ts
  profiles-lifecycle-scoping.test.ts
  profiles-switch-refused.test.ts

examples/dogfood-stack/lich.yaml  # MODIFY — define at least 2 profiles (dev default, dev:test-env pointing at hosted)
```

---

## Task list (high-level)

1. **Extend JSON Schema** for profiles
2. **Profile resolver** with extends + cycle detection + start-set computation
3. **Extend env pipeline** for profile layer (per-key precedence)
4. **Lazy per-key interpolation** — refactor Plan 1's interpolation
5. **Profile-scoped lifecycle** + composition rules
6. **`lich up [profile]`** argument + state recording
7. **Refuse profile switch while stack up**
8. **Auto-export `LICH_PROFILE`** env var
9. **`lich validate`** profile checks: name resolution, cycle detection, default uniqueness, unused warning, per-profile interpolation simulation
10. **Update `examples/dogfood-stack/lich.yaml`** — add `dev` default profile + `dev:test-env` overriding env to point at fake hosted backend; move migrations into the `dev` profile lifecycle (not top-level)
11. **E2e tests** per the testing standards floor

---

## Cross-plan dependencies

- Plan 1 (env pipeline, lifecycle executor, CLI up command, state directory)
- Plan 2 (env_groups — for the long-form `{cmd, env_group}` lifecycle entries that use a named group)

---

## Testing requirements

E2e coverage floor:

- **`lich up` (no arg) activates default profile** — services in that profile start; others don't.
- **`lich up <profile>` activates named profile** — verifiable via `lich stacks` or service discovery.
- **`lich up <bad-name>` exits non-zero** with a clear error.
- **Profile extends works** — child includes parent's services/owned + its own.
- **Switching profiles while up is refused** — start dev, attempt `lich up dev:test-env`, expect error.
- **Services not in active profile do NOT start** — verifiable via process listing.
- **Profile-scoped env overrides** — `DATABASE_URL` differs between dev (local) and dev:test-env (hosted).
- **Profile-scoped lifecycle** — migrations run for dev, do NOT run for dev:test-env.
- **`LICH_PROFILE` env var** — visible in service env (e.g. via `lich exec sh -c 'echo $LICH_PROFILE'`).
- **Validate failure cases** — profile references nonexistent service, extends cycle, two `default: true`, unused-service warning, per-profile interpolation ref to non-included service.

---

## Acceptance criteria

Plan 3 is done when:

- `examples/dogfood-stack/lich.yaml` has at least two profiles (`dev` as default + `dev:test-env` pointing at hosted)
- `lich up` activates `dev`; `lich up dev:test-env` activates that one
- The resolved service set, env vars, and lifecycle hooks differ correctly between the two profiles, verifiable e2e
- `lich validate` catches profile misconfigurations
- All Plan 3 e2e tests pass
