# Lich v1 — Plan 4: Failure Surfacing

> **Status:** HIGH-LEVEL SHELL — task structure captured; per-task code/steps to be refined when this plan is ready to execute.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 4 ready_when/fail_when/capture, 5 failure UX, 6 dashboard failure visibility, 10 non-goals around restart policies)

**Required reading:** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`

**Goal:** Make failures detectable, recoverable, and visible. Add `fail_when.log_match` for services that fail without exiting, `ready_when.timeout` so hangs surface, `ready_when.capture` for grabbing dynamic values (tunnel URLs) from logs, automatic process-exit detection, and clean failure UX in the CLI. By end of plan, deliberately broken yaml variants all produce useful error messages with log context inline.

**Builds on:** Plan 1 (ready evaluators, owned-service runner, CLI output framework), Plan 3 (state directory with profile awareness for dashboard).

**Architecture:** Failure detection is layered on top of the existing ready/owned subsystems. Process-exit detection is a small extension to the owned-service supervisor — when a process exits unexpectedly (during startup, before ready, or after ready), state is updated. `fail_when` is a parallel watcher on the log stream that races with `ready_when`. `ready_when.timeout` is a deadline on the ready polling loop. `capture` extracts values when ready fires. Failure UX is a coordinated set of changes across CLI output (phased progress shows failures inline) and state directory (failure reason + last N log lines recorded).

---

## What this plan implements

From the spec section 4:

- **`fail_when` field** on owned services (also on `services` for completeness, though compose has its own restart policy)
- `fail_when.log_match: <regex>` — fail the service immediately if any stdout/stderr line matches
- **Automatic process-exit detection** (always on, no config) — owned services that exit unexpectedly are marked failed; subprocess wait → orchestrator failure path
- **`ready_when.timeout`** with default `60s` — exceeding marks failed
- **`ready_when.capture`** map — when ready fires, run regex(es) against the accumulated log buffer; expose via `${owned.<name>.captured.<key>}`

From the spec section 5 (CLI failure UX):

- `lich up` aborts on first failure during startup
- Failure message includes which service, the specific reason (exit code / ready timeout / fail_when match / capture failure), last 20 lines of that service's log inline
- Exits non-zero

From the spec section 5 (validate):

- Regex compile check for `ready_when.log_match`, `fail_when.log_match`, `ready_when.capture.*` — typos caught before runtime

From the spec section 6 (dashboard failure visibility):

- State directory snapshot includes failure reason + log context for failed services (dashboard can render in Plan 5)

From spec section 10 (non-goals):

- No restart policies in v1; document this explicitly
- No periodic liveness probes; document explicitly

---

## Subsystems introduced

### `ready/` (extended)

- `timeout.ts` — wrap any ready evaluator with a deadline; mark failed on timeout, include last 20 log lines in error
- `capture.ts` — when ready fires, run named regexes against the accumulated log buffer; store captures in state

### `failure/`

NEW subsystem for failure detection and reporting.

- `fail-when.ts` — parallel log watcher; races with ready, triggers failure on match
- `process-exit.ts` — owned-service exit handler; categorizes (during-startup, before-ready, after-ready) and reports
- `formatter.ts` — format a failure for CLI output (which service, reason, last N log lines inline)

### `state/snapshot.ts` (extended)

- Each service in the snapshot can be in state: `starting`, `healthy`, `initializing`, `ready`, `stopping`, `failed`
- Failed services record: `failure_reason`, `failure_log_tail` (last 20 lines)

### `config/validate.ts` (extended)

- Compile every `log_match` regex (in `ready_when` and `fail_when`) to catch syntax errors
- Compile every `capture` regex
- Same for any other regex fields if added

### `output/` (extended)

- New "Failure" phase in phased output
- Render failure reason + log tail inline (color highlighted)
- Exit non-zero with summary

---

## File structure delta

```
packages/lich/src/
  ready/
    timeout.ts                   # NEW
    capture.ts                   # NEW
  failure/
    fail-when.ts                 # NEW
    process-exit.ts              # NEW
    formatter.ts                 # NEW
  owned/
    supervisor.ts                # EXTEND for exit detection wiring
  state/
    snapshot.ts                  # EXTEND for failure fields
  config/
    validate.ts                  # EXTEND for regex compilation
  output/
    phased.ts                    # EXTEND for failure rendering

packages/lich/tests/unit/
  ready/timeout/
  ready/capture/
  failure/
  config/                         # add regex compile tests

tests/e2e/
  failure-process-exit.test.ts
  failure-ready-timeout.test.ts
  failure-fail-when.test.ts
  capture-tunnel-url.test.ts
```

---

## Task list (high-level)

1. **Extend JSON Schema** for `ready_when.timeout`, `ready_when.capture`, `fail_when`
2. **`ready_when.timeout`** — wrap each ready evaluator with deadline
3. **`ready_when.capture`** — extract regex matches from accumulated log buffer at ready time; expose via `${owned.<name>.captured.<key>}` in env interpolation
4. **`fail_when.log_match`** — parallel log watcher that races with ready
5. **Automatic process-exit detection** — owned supervisor catches child process exit, categorizes by lifecycle phase (during startup / before ready / after ready), reports failure
6. **State snapshot extensions** — service states gain `failed`; failure metadata recorded
7. **Failure UX in `lich up`** — phased output now shows failures inline with last 20 log lines, aborts startup
8. **Validate regex compile check** for all log_match / capture patterns
9. **Update dogfood-stack lich.yaml** — add `fail_when` on api (e.g. `EADDRINUSE|Cannot find module`), `ready_when.timeout: 90s` on supabase, `ready_when.capture` example (if dogfood-stack has a service that warrants capture, otherwise add a synthetic one or skip)
10. **E2e tests** for each failure mode

---

## Cross-plan dependencies

- Plan 1 (ready evaluators, owned supervisor, CLI output)
- Plan 3 (state snapshot active profile awareness — failures need to render with profile context)

---

## Testing requirements

E2e coverage floor — deliberately broken yaml variants:

- **Port already in use** — start a stack on port 4000, then `lich up` against a config that tries to use port 4000; expect failure message naming the conflict
- **Process exits 1 immediately** — owned service with `cmd: exit 1`; expect failure with exit code
- **Never becomes ready** — owned service with `ready_when: { http_get: /nope, timeout: 3s }`; expect timeout failure with log tail
- **`fail_when` triggers** — owned service that logs `EADDRINUSE` (e.g. via a stub script); expect immediate failure on match
- **`ready_when.capture` works** — define a service whose log emits a URL; capture it; verify `${owned.X.captured.url}` resolves correctly in another service's env
- **Regex compile failure caught at validate** — bad regex in `fail_when.log_match`; `lich validate` exits non-zero with file:line:col

Failure UX assertions:

- CLI stdout/stderr contains the failed service name, reason, and last 20 lines of its log
- Exit code non-zero
- State directory snapshot shows the failed service state
- Subsequent `lich logs` includes failure context

---

## Acceptance criteria

Plan 4 is done when:

- The dogfood-stack lich.yaml has at least one `fail_when` and one `ready_when.timeout` example
- `lich up` against the dogfood-stack still succeeds normally (no false positives)
- Each deliberately broken variant produces a clean, actionable error message
- `lich validate` catches regex syntax errors
- All Plan 4 e2e tests pass
- Plan 0's `basic-up.test.ts` second test still passes; first test still gated on Plan 5
