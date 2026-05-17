# Plan 08 — Validation tools (impact / coverage / check)

**Goal:** Ship the three deterministic-validation commands an agent calls during authoring:
- `levelzero impact <path|symbol>` — list files that depend on the changed path/symbol (import graph)
- `levelzero coverage [--threshold N]` — unified coverage across unit + integration + e2e via vitest's coverage
- `levelzero check` — pluggable conformance-rule engine + v0 built-in rules

**Architecture:**
- `impact`: static import-graph scanning via `ts-morph`. v0 = file-level reverse-deps (no symbol granularity yet — that's a follow-on).
- `coverage`: shell-out to `vitest --coverage`, parse the JSON summary, emit unified report. Threshold flag fails the command if any file or service is below it.
- `check`: a `Rule` interface (`{ id, name, check(ctx): Promise<RuleResult> }`) + a registry + a few built-in rules (route coverage, schema/migration consistency, type-client freshness — though some need plans 05/09 landed first; gate those with a no-op when prereqs absent).

**Files:**
```
tools/cli/src/
  impact/
    graph.ts                    # ts-morph reverse-deps
  coverage/
    runner.ts                   # spawn vitest with coverage, parse JSON
  check/
    types.ts                    # Rule, RuleResult, RuleContext
    registry.ts                 # registerRule, runRules
    rules/
      route-coverage.ts         # stub (real rule lands with plan 09's route manifest)
      schema-migration.ts       # stub (real rule lands with plan 05)
      type-client-freshness.ts  # stub
  commands/
    impact.ts
    coverage.ts
    check.ts
```

## Tasks

| # | Title | Wave | Files |
|---|---|---|---|
| 08.1 | `Rule` interface + rule registry | 1 | `check/types.ts`, `check/registry.ts` |
| 08.2 | Impact graph (ts-morph reverse-deps) | 1 | `impact/graph.ts` |
| 08.3 | `levelzero impact` command | 2 | `commands/impact.ts` |
| 08.4 | Coverage runner (vitest spawn + JSON parse) | 2 | `coverage/runner.ts` |
| 08.5 | `levelzero coverage` command | 3 | `commands/coverage.ts` |
| 08.6 | `levelzero check` command + 3 stub rules | 3 | `commands/check.ts`, `check/rules/*` |
| 08.7 | Wire `impact`/`coverage`/`check` into bin + e2e | 4 | `bin.ts` + tests |

Wave 1 + 2 are parallel pairs. Wave 3 is parallel pair. Wave 4 is sequential single.

## New deps

- `ts-morph` (for import graph)
- `@vitest/coverage-v8` (for coverage support)

## Out of scope

- Symbol-level impact (file-level only in v0).
- Real rule implementations that need plans 05/09 landed — stubbed out, return "skipped" with a reason.

## Verification

- `levelzero impact tools/cli/src/registry.ts` returns files that import it (json array).
- `levelzero coverage` returns coverage summary; `--threshold 80` fails if any file under 80%.
- `levelzero check` runs all registered rules, returns pass/skip/fail per rule.
- Full suite green; tsc clean.
