# Lich v1 — Plan 6: Onramp + Cleanup

> **Status:** HIGH-LEVEL SHELL — task structure captured; per-task code/steps to be refined when this plan is ready to execute.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 7 onramp, 9 implementation cleanup)

**Required reading:** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`

**Goal:** Ship the `lich:instrument` agent skill that translates an existing project into a `lich.yaml`. Rewrite the root README for v1. Delete all v0 packages now that their useful subsystems have been ported. Update CLAUDE.md to remove "don't touch v0 code" caveats. Final polish for release.

**Builds on:** All previous plans. Cleanup is meaningful only once v1 functionality is complete.

**Architecture:** The `lich:instrument` skill is a markdown file in `packages/lich/skills/` that walks an agent through reading a project's existing setup and producing a `lich.yaml`. Cleanup is mostly deletion + small doc updates. The README rewrite is the public-facing pitch.

---

## What this plan implements

From the spec section 7 (onramp):

- **`lich:instrument` agent skill** — markdown that walks an agent through: run `lich init`, read project files (package.json/Gemfile/requirements.txt/go.mod, compose files, .env.example, README, scripts/), fill in the skeleton, validate, verify with `lich up`, show user a diff
- Skill explicitly: NOT framework-specific; translation task not knowledge task
- Skill looks for stack-aware scripts and offers to wrap them as `commands:` entries

From the spec section 1 + 9 (cleanup):

- Rewrite root README — current state of v1, install, quickstart with dogfood-stack, link to spec
- Delete v0 packages: `packages/core/`, all `packages/plugin-*`, `packages/template-v0-stack/`, `packages/create-stack-v0/`, `packages/dashboard/` (after Plan 5 ports the UI bits we keep)
- Update CLAUDE.md to remove "v0 packages still present, don't touch" warnings since they'll be gone
- Archive directories (`docs/archive-v0/`, `docs/superpowers/{specs,plans}/archive-v0/`) STAY — they're historical record, not active guidance

Release polish:

- Version bump in `packages/lich/package.json` to `1.0.0` (or `0.1.0` if we want to signal "first release but still early")
- Initial CHANGELOG
- Distribution: GitHub Releases binary for Mac arm64+x86, Linux arm64+x86; npm wrapper that installs the binary

---

## Subsystems introduced / modified

### `packages/lich/skills/lich-instrument.md`

The agent skill. Probably 200-400 lines: walkthrough, common project shapes to look for, when to defer to the user, what to put where in the lich.yaml, validation/verification loop.

### Root `README.md` (rewritten)

Replace the current v0 README + WIP notice with a real v1 README:
- The one-paragraph pitch
- Quickstart with the dogfood-stack
- Link to the spec for depth
- Link to the testing standards for contributors
- Installation instructions

### `CLAUDE.md` (updated)

- Remove the "v0 packages still here, don't touch" caveats
- Remove references to `packages/core/`, plugin packages, etc. (they're gone)
- Update the project layout map to reflect post-cleanup structure
- Update the "Current state" section to reflect v1 shipped

### Deletions

- `packages/core/`
- `packages/plugin-better-auth/`
- `packages/plugin-dotenv/`
- `packages/plugin-hono/`
- `packages/plugin-infisical/`
- `packages/plugin-kafka/`
- `packages/plugin-next/`
- `packages/plugin-playwright/`
- `packages/plugin-portless/`
- `packages/plugin-postgres/`
- `packages/plugin-prisma/`
- `packages/plugin-redis/`
- `packages/plugin-shadcn/`
- `packages/plugin-typed-client/`
- `packages/plugin-vitest/`
- `packages/template-v0-stack/`
- `packages/create-stack-v0/`
- `packages/dashboard/` (after Plan 5 has copied what it needs)

### Distribution

- `packages/lich/package.json` `bin` field → installs the compiled binary
- Build scripts for cross-platform binaries
- GitHub Action (optional in v1) to build + attach binaries to releases

---

## File structure delta

```
packages/lich/
  skills/
    lich-instrument.md           # NEW

README.md                         # REWRITE
CLAUDE.md                         # UPDATE (remove v0 caveats)
packages/lich/package.json        # UPDATE (version, scripts, bin)
packages/lich/CHANGELOG.md        # NEW (initial)

# Deletions:
packages/core/                    # DELETE
packages/plugin-*/                # DELETE (all 14)
packages/template-v0-stack/       # DELETE
packages/create-stack-v0/         # DELETE
packages/dashboard/               # DELETE
```

---

## Task list (high-level)

1. **Write `lich-instrument.md` skill** — walkthrough, common project shapes, validate-then-up verification loop
2. **Test `lich:instrument` against a non-dogfood project** — e.g. a random create-next-app + postgres compose; verify the skill produces a working lich.yaml
3. **Rewrite root `README.md`** — v1 pitch, quickstart, links
4. **Update `CLAUDE.md`** — remove v0 caveats, update layout map, mark v1 as shipped
5. **Delete all v0 packages** — `packages/core/`, plugin packages, template, scaffolder, dashboard
6. **Verify nothing imports from deleted packages** — `grep -r "@levelzero/" packages/lich/` should return nothing
7. **Update workspaces in root `package.json`** — remove deleted packages from workspace globs
8. **Version bump + CHANGELOG** — `packages/lich/package.json` version, initial CHANGELOG
9. **Cross-platform binary builds** — verify `bun build --compile` works for Mac arm64+x86 and Linux arm64+x86
10. **npm wrapper** — `npm install -g lich` installs the binary
11. **Final e2e regression run** — ensure deleting v0 packages didn't break anything; all Plan 0-5 e2e tests still pass
12. **Plan a v1 release** — git tag, GitHub release, optionally announcement post

---

## Cross-plan dependencies

- All of Plans 1-5 must be done. Plan 6 is final cleanup + onramp; v0 deletion can't happen until v1 is fully self-contained.
- Plan 5 must have ported the dashboard UI before `packages/dashboard/` is deleted.

---

## Testing requirements

E2e coverage for `lich:instrument`:

- **Skill produces a valid yaml** — run the skill against `examples/dogfood-stack/` with its `lich.yaml` deleted; the skill should reproduce a working config. Verify `lich validate` passes and `lich up` works.
- **Skill works on a different project shape** — e.g. `create-next-app` + Postgres compose; verify the skill produces something runnable.
- Skill DOES NOT silently fix bad-spec issues — surface them to the user.

E2e for cleanup:

- After deletion, `lich up` against the dogfood-stack still works (no regressions from removed packages)
- All previous plans' e2e suites still pass
- No imports from deleted packages anywhere

E2e for distribution:

- `bun build --compile` produces a working binary on each target platform
- `npm install -g lich` installs the binary on a clean machine

---

## Acceptance criteria

Plan 6 is done when:

- `packages/lich/skills/lich-instrument.md` exists and works on at least 2 different project shapes
- Root README is a real v1 README (no WIP notice)
- CLAUDE.md has no v0 caveats; layout map is accurate
- All v0 packages are deleted from the repo
- All e2e tests pass against the cleaned-up repo
- A working binary builds on Mac and Linux
- `packages/lich/package.json` version is set; CHANGELOG exists
- Optional: git tag and GitHub release for `v1.0.0`

When all of the above hold, lich v1 is shipped.
