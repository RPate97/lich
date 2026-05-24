# Lich v1 — Plan 4: Failure Surfacing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md` (sections 4 ready_when/fail_when/capture, 5 failure UX, 6 dashboard failure visibility, 10 non-goals around restart policies)

**Required reading:** `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`

**Goal:** Make failures detectable, recoverable, and visible. Add `fail_when.log_match` for services that fail without exiting, `ready_when.timeout` so hangs surface, `ready_when.capture` for grabbing dynamic values (tunnel URLs) from logs, automatic process-exit detection, and clean failure UX in the CLI. By end of plan, deliberately broken yaml variants all produce useful error messages with log context inline.

**Builds on:** Plan 1 (ready evaluators, owned-service runner, CLI output framework), Plan 3 (state directory with profile awareness for dashboard).

**Architecture:** Failure detection is layered on top of existing ready/owned subsystems. A new `LogTail` primitive opens a separate read fd on each owned service's log file (the supervisor already writes via file-fd stdio per `packages/lich/src/owned/supervisor.ts` — see the long comment around the `openSync(spec.logPath, "a")` call), polls for new bytes, splits on newlines, and emits new-line events to N consumers. `fail_when.log_match`, `ready_when.capture`, and (later) the dashboard live-tail all subscribe to the same `LogTail` so a service's log is read once but consumed by many. Process-exit detection becomes a small extension to the owned-service start path — `up.ts` already does early-exit detection via a 100ms race; Plan 4 promotes that to a always-on watcher so post-ready exits also surface. `ready_when.timeout` is a deadline on the ready polling loop. Failure UX is a coordinated change across the output layer (a dedicated `failure` block renders service + reason + log tail) and state directory (failure reason + log tail recorded in `state.json`).

**Why a `LogTail` primitive?** Today `ready/log-match.ts` and `commands/logs.ts` each independently poll-tail log files with near-identical loops. Plan 4 adds at least two more consumers (`fail_when.log_match` racing against `ready_when`, and `ready_when.capture` extracting values once ready fires). Wiring each one with its own poll loop would (a) duplicate the read-bytes-and-split-on-newlines machinery four times, (b) re-open and re-read the same file four times per tick, and (c) make the test surface explode. The supervisor already uses `stdio: ["ignore", logFd, logFd]` to write the log via a raw fd — there is no Node-side stream to tap. So we explicitly need a **separate-fd file reader**. `LogTail` encapsulates that read-side machinery once and feeds N subscribers.

---

## What this plan implements

From spec section 4:

- **`fail_when` field** on owned services (also accepted on `services` for shape symmetry, though compose has its own restart policy and we don't add behavior there)
- `fail_when.log_match: <regex>` — fail the service immediately if any stdout/stderr line matches
- **Automatic process-exit detection** (always on, no config) — owned services that exit unexpectedly at any lifecycle stage are marked failed; the orchestrator surfaces the failure path
- **`ready_when.timeout`** with default `60s` — exceeding marks the service failed
- **`ready_when.capture`** map — when ready fires, run regex(es) against the accumulated log buffer; expose via `${owned.<name>.captured.<key>}`

From spec section 5 (CLI failure UX):

- `lich up` aborts on first failure during startup
- Failure message includes which service, the specific reason (exit code / ready timeout / fail_when match / capture failure), last 20 lines of that service's log inline
- Exits non-zero

From spec section 5 (validate):

- Regex compile check for `ready_when.log_match`, `fail_when.log_match`, `ready_when.capture.*` — typos caught before runtime. (Schema already compiles ready_when/fail_when log_match per `config/validate.ts`; capture is new.)

From spec section 6 (dashboard failure visibility):

- State directory snapshot includes failure reason + log tail for failed services (dashboard renders these in Plan 5)

From spec section 10 (non-goals):

- No restart policies in v1; documented explicitly
- No periodic liveness probes; documented explicitly

---

## Subsystems introduced

### `logs/` (NEW)

The `LogTail` primitive. Single file, single class.

- `tail.ts` — `class LogTail`. Opens an O_RDONLY fd on a log file path. On `start()`, polls (or uses `fs.watch` fallback) for size growth. On growth, reads new bytes from the prior offset, splits at newlines, emits a `'line'` event with each complete line. Carries trailing partial line across ticks. Supports multiple subscribers (`onLine(cb)`). Supports `stop()` for clean shutdown. Idempotent across already-existing log content (initial read picks up whatever's already there before subscribing, but each subscriber sees only lines emitted after `.onLine()` is registered — see Task 2 design notes).

### `ready/` (extended)

- `timeout.ts` — wrap any ready evaluator (`waitForHttpReady`, `waitForTcpReady`, `waitForLogMatch`) with a deadline. On expiry, abort the wrapped evaluator's signal and throw `ReadyTimeoutError` (Plan 4's new error type) carrying the duration that elapsed.
- `capture.ts` — given a `LogTail`, an accumulated log buffer (all bytes read since service started, kept by `LogTail.buffer`), and a `capture: { key: regex }` map, run each regex against the buffer when ready fires. Return a `Record<string, string>` of captured values. First match wins per key. Missing match → `CaptureMissError` with the key + regex that failed.

### `failure/` (NEW subsystem)

- `fail-when.ts` — wraps a `LogTail` subscription. On any line match, fires an AbortSignal-like rejection. Composes with `ready_when` via `Promise.race` in the orchestrator.
- `process-exit.ts` — `class ProcessExitWatcher`. Wraps an `OwnedHandle`. On `handle.exited`, categorizes the exit by stage (`during_startup` if before ready evaluator fires, `before_ready` if during ready wait, `after_ready` if after ready). Carries the exit code/signal and the log tail.
- `formatter.ts` — pure function `formatFailure({ service, reason, logTail, kind }) → string`. Used by `output/` to render the failure block in pretty + json mode. Tested in isolation.

### `state/snapshot.ts` (extended)

- Service snapshot gains `failure_reason?: string` and `failure_log_tail?: string[]` fields (last 20 lines, newline-stripped)
- The `failed` state already exists in `ServiceState`; Plan 4 starts populating the new fields when transitioning to it

### `config/validate.ts` (extended)

- Capture regex compile check: walk `config.owned[*].ready_when.capture` and `RegExp(pattern, "u")` each one (current code only compiles `log_match`; capture is missing)
- Schema-level: tighten `ready_when.timeout` from "any" to "duration string (`30s`, `2m`, etc.) or integer ms" with a regex check; tighten `ready_when.capture` to "object of (key→regex-string)"; tighten `fail_when` from "any object" to "object with optional `log_match: string`"

### `output/` (extended)

- New `Output.failure(block: FailureBlock)` method. Pretty mode renders a red banner + reason + indented log tail. JSON mode emits a `failure` event with structured fields. Quiet mode emits only the final error.
- The existing `Output.error(...)` is retained for non-service failures (yaml parse errors, dep graph cycles); `failure(...)` is the per-service equivalent that includes log context.

### `up.ts` (extended)

- After spawning each owned service, start a `LogTail` for it. The same LogTail feeds `fail_when` (immediately subscribes), `ready_when.log_match` (replaces direct `waitForLogMatch` callsite — log-match becomes a thin wrapper over LogTail), and capture (consumes accumulated buffer after ready fires).
- Replace the 100ms early-exit race in `startOwned` with `ProcessExitWatcher` so post-ready exits are detected too.
- Wrap each ready evaluator with `withTimeout` (default 60s, override via `ready_when.timeout`).
- On per-service failure, populate `snap.failure_reason` and `snap.failure_log_tail` before re-throwing so the snapshot persists those fields. Pass the failure to `output.failure(...)`.

---

## File structure delta

```
packages/lich/src/
  logs/
    tail.ts                          # NEW — LogTail primitive
  ready/
    log-match.ts                     # MODIFY — refactor to subscribe to LogTail
    timeout.ts                       # NEW — withTimeout wrapper
    capture.ts                       # NEW — capture extraction
  failure/
    fail-when.ts                     # NEW — fail_when log watcher
    process-exit.ts                  # NEW — categorizing process-exit watcher
    formatter.ts                     # NEW — failure-block formatter
  state/
    snapshot.ts                      # EXTEND — failure_reason + failure_log_tail fields
  config/
    schema.ts                        # EXTEND — tighten ready_when.timeout/capture, fail_when
    validate.ts                      # EXTEND — capture regex compile check
  output/
    index.ts                         # EXTEND — Output.failure() interface
    pretty.ts                        # EXTEND — renderFailure()
    json.ts                          # EXTEND — emit failure event
    quiet.ts                         # EXTEND — failure passthrough
  commands/
    up.ts                            # EXTEND — wire LogTail + watchers; populate failure fields
    logs.ts                          # OPTIONAL FOLLOW-UP — refactor onto LogTail (not blocking)

packages/lich/tests/unit/
  logs/
    tail.test.ts                     # NEW
  ready/
    timeout.test.ts                  # NEW
    capture.test.ts                  # NEW
    log-match.test.ts                # MODIFY — adjust for LogTail-based impl
  failure/
    fail-when.test.ts                # NEW
    process-exit.test.ts             # NEW
    formatter.test.ts                # NEW
  config/
    validate-capture-regex.test.ts   # NEW
    schema-fail-when.test.ts         # NEW
    schema-ready-when-timeout.test.ts # NEW
    schema-ready-when-capture.test.ts # NEW
  output/
    pretty-failure.test.ts           # NEW
    json-failure.test.ts             # NEW
  state/
    snapshot-failure-fields.test.ts  # NEW
  commands/
    up-failure-wiring.test.ts        # NEW — unit-level orchestration test

tests/e2e/
  failure-process-exit.test.ts       # NEW
  failure-ready-timeout.test.ts      # NEW
  failure-fail-when.test.ts          # NEW
  failure-port-already-in-use.test.ts # NEW
  failure-validate-bad-regex.test.ts # NEW
  capture-log-value.test.ts          # NEW

examples/dogfood-stack/
  lich.yaml                          # MODIFY — add fail_when, ready_when.timeout, capture demo
```

---

## Cross-plan dependencies

- Plan 1 (ready evaluators in `packages/lich/src/ready/`, owned supervisor in `packages/lich/src/owned/supervisor.ts`, CLI output in `packages/lich/src/output/`)
- Plan 3 (state snapshot active-profile awareness — failure UX needs to show which profile was active)

---

## Testing requirements

Per `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`, every task ships unit + e2e tests. E2e coverage floor — deliberately broken yaml variants the suite MUST cover:

- **Port already in use** — start a stub on port X, then `lich up` against a config that pins port X; expect failure naming the conflict (Task 23 — `failure-port-already-in-use.test.ts`)
- **Process exits 1 immediately** — owned service `cmd: exit 1`; expect failure with exit code + log tail (Task 22 — `failure-process-exit.test.ts`)
- **Never becomes ready** — owned service `ready_when: { http_get: /nope, timeout: 3s }`; expect timeout failure with log tail (Task 21 — `failure-ready-timeout.test.ts`)
- **`fail_when` triggers** — owned service whose `cmd` emits `EADDRINUSE` then hangs (e.g. `cmd: 'echo EADDRINUSE; sleep 60'`); expect immediate failure on match (Task 20 — `failure-fail-when.test.ts`)
- **`ready_when.capture` works** — owned service whose log emits a URL on a fixed line; capture it; verify `${owned.X.captured.url}` resolves correctly in another service's env (Task 24 — `capture-log-value.test.ts`)
- **Regex compile failure caught at validate** — bad regex in `fail_when.log_match`; `lich validate` exits non-zero with file:line:col (Task 25 — `failure-validate-bad-regex.test.ts`)

Failure UX assertions (cross-cutting across all e2e failure tests):

- CLI stdout/stderr contains the failed service name, reason, and last 20 lines of its log
- Exit code non-zero
- State directory snapshot has the service in `failed` state with `failure_reason` and `failure_log_tail` populated
- Subsequent `lich logs <service>` shows the full log (not truncated)

---

## Acceptance criteria

Plan 4 is done when:

- The dogfood-stack lich.yaml has at least one `fail_when`, one `ready_when.timeout`, and one `ready_when.capture` example
- `lich up` against the dogfood-stack still succeeds normally (no false positives)
- Each deliberately broken variant produces a clean, actionable error message with last 20 log lines inline
- `lich validate` catches regex syntax errors in capture (was already done for log_match)
- `lich validate` catches malformed `ready_when.timeout` (e.g. `timeout: "forever"`) and malformed `fail_when` shapes
- All Plan 4 e2e tests pass
- Plan 0's `basic-up.test.ts` second test still passes; first test still gated on Plan 5
- `state.json` snapshots for failed services include `failure_reason` and `failure_log_tail`
- A future agent can read this plan and the spec and add a new ready_when condition type without touching `LogTail` (proves the primitive is at the right abstraction level)

---

## Task list (bite-sized, ~30-90 min each)

> Tasks are numbered in dependency order. Each task is its own commit. The early tasks (1-3) establish the `LogTail` primitive; tasks 4-7 build the high-level failure surfaces; tasks 8-16 thread the wiring through the orchestrator and state; tasks 17-25 are integration + e2e + dogfood.

---

### Task 1: `LogTail` skeleton — file structure, type interfaces, no-op start/stop

**Dependencies:** none

**Files to create:**
- `packages/lich/src/logs/tail.ts`

**Acceptance criteria:**
- `class LogTail` exported with constructor `(opts: { logPath: string; intervalMs?: number })`
- `start(): Promise<void>` resolves immediately, opens the read fd lazily on first poll, no-op if already started
- `stop(): Promise<void>` closes the read fd, idempotent
- `onLine(cb: (line: string) => void): () => void` returns an unsubscribe function (does nothing yet — wired in Task 2)
- `buffer: string` getter returns "" for now (wired in Task 2)
- TypeDoc comments on every public surface explaining the file-fd-reader design and why a separate primitive exists (anchor: link to the supervisor comment about Node-pipe stdio causing Next.js hangs)

**Tests to write:**
- `packages/lich/tests/unit/logs/tail.test.ts`:
  - `it("constructs without throwing for a path that doesn't exist yet")` — sets up class against a not-yet-existing file
  - `it("start() resolves and stop() is idempotent")` — verifies the lifecycle methods don't throw on degenerate use
  - `it("onLine() returns an unsubscribe function that is safe to call multiple times")` — registration shape

**Implementation notes:**
This is purely the skeleton. The poll loop and event emission land in Task 2. Splitting the skeleton out makes the test commit demonstrate the API shape independently of the runtime behavior, which makes code review faster. The constructor accepts `intervalMs` (default 100ms — same as `log-match.ts` today) and `signal?: AbortSignal` (for shutdown propagation, used in Task 3). Do NOT use `node:events` `EventEmitter` here — keep it dependency-free with a simple `Set<callback>` so the unsubscribe semantics are obvious. The class is intentionally NOT exposed via a factory function — the consumers need a stable handle they can call `.stop()` on at shutdown.

---

### Task 2: `LogTail` poll loop + line emission to subscribers

**Dependencies:** Task 1

**Files to modify:**
- `packages/lich/src/logs/tail.ts`

**Acceptance criteria:**
- After `start()`, an internal `setInterval` polls `stat(logPath)` at `intervalMs`
- On size growth: opens the file, reads from prior offset, closes, splits on `/\r?\n/`, emits each complete line via every registered `onLine` callback
- Trailing partial line carries across ticks via internal `pending` buffer
- File doesn't exist yet → silently keep polling (matches `log-match.ts` behavior)
- Lines emitted to subscribers registered AFTER lines were already read are NOT replayed (subscribe order matters; document this clearly so consumers like `capture` use the `.buffer` getter for retrospection)
- Internal accumulated `buffer: string` getter exposes ALL bytes read since `start()` was called — used by capture
- `stop()` clears the interval, closes any open fd, prevents further emission even if a poll was in flight

**Tests to write:**
- `packages/lich/tests/unit/logs/tail.test.ts` (extended):
  - `it("emits each line to a single subscriber as the file grows")`
  - `it("emits each line to multiple subscribers (fan-out)")` — register two callbacks, verify both fire
  - `it("does not re-emit lines that were already read before subscribing")` — subscribe AFTER content exists
  - `it("carries a trailing partial line across ticks")` — write `"hello"` (no newline), tick, write `" world\n"`, expect one line `"hello world"`
  - `it("buffer getter returns the full accumulated content")` — exposes byte-for-byte history
  - `it("stop() halts emission even if a poll is in flight")` — call stop() during a poll
  - `it("survives the log file not existing at start()")` — file appears later
  - `it("handles file truncation gracefully")` — file shrinks; don't crash; document we don't re-read (rotation is out of scope, same as log-match.ts says)

**Implementation notes:**
Use the exact polling shape from `packages/lich/src/ready/log-match.ts` lines 50-142 — that code has been battle-tested through Plan 1. The key new behavior is the `Set<callback>` fan-out plus the always-on `buffer` accumulator. Keep buffer accumulation bounded — if it grows past, say, 1 MB, drop the oldest half. (Real services don't emit that much before becoming ready, but a hung service that logs in a loop shouldn't OOM lich.) The 1 MB cap is a sensible default; comment it inline. Do NOT use `fs.watch` — its cross-platform semantics are inconsistent (macOS fires once per write, Linux fires per chunk, Windows is its own world). Polling at 100ms is fast enough for our use cases and predictable.

---

### Task 3: `LogTail` shutdown via AbortSignal + integration test against supervisor

**Dependencies:** Task 2

**Files to modify:**
- `packages/lich/src/logs/tail.ts`

**Files to create:**
- `packages/lich/tests/unit/logs/tail-supervisor-integration.test.ts`

**Acceptance criteria:**
- Constructor accepts `signal?: AbortSignal`. When the signal fires, `stop()` is called automatically.
- After abort, `start()` is a no-op (don't restart after shutdown).
- Integration test: spawn a real owned service via `startOwnedService` (use a 200ms shell loop that writes "tick" every 50ms), attach a `LogTail`, assert it sees at least 3 "tick" lines, stop the service, verify the LogTail closes cleanly.

**Tests to write:**
- `packages/lich/tests/unit/logs/tail.test.ts` (extended):
  - `it("auto-stops when the provided AbortSignal fires")`
- `packages/lich/tests/unit/logs/tail-supervisor-integration.test.ts`:
  - `it("reads lines from a real supervisor-spawned service's log")` — uses the same `LICH_HOME` tmpdir pattern as `supervisor.test.ts`. Spawns `sh -c 'for i in 1 2 3 4 5; do echo "tick $i"; sleep 0.05; done'` via `startOwnedService`. Subscribes to LogTail. Asserts 5 ticks observed. This test is the proof-of-concept that the fd-separation works end-to-end with the supervisor's file-fd stdio.

**Implementation notes:**
The integration test is the load-bearing one for this task — it proves the architectural premise that `LogTail` reading from a separate fd doesn't race with the supervisor's writing fd. Use the helpers from `supervisor.test.ts` (`LICH_HOME`, `ensureStackDir`, `serviceLogPath`) verbatim. The 5-tick test runs in ~300ms total. Do not let it sleep arbitrary durations — wait on a deferred that resolves on the 5th tick.

---

### Task 4: Refactor `ready/log-match.ts` to subscribe via LogTail

**Dependencies:** Task 3

**Files to modify:**
- `packages/lich/src/ready/log-match.ts`
- `packages/lich/tests/unit/ready/log-match.test.ts`

**Acceptance criteria:**
- `waitForLogMatch` no longer opens its own fd / runs its own poll loop
- New signature: `waitForLogMatch({ tail: LogTail, pattern: RegExp, signal?: AbortSignal }): Promise<void>`
- Behavior preserved: resolves on first line matching `pattern`, rejects on signal abort
- Existing log-match tests adapted to construct a `LogTail` first, then pass it in. All tests still pass.

**Tests to write/modify:**
- `packages/lich/tests/unit/ready/log-match.test.ts`:
  - Existing tests refactored to use the new signature
  - `it("matches a line that arrived BEFORE subscription via the LogTail buffer")` — NEW; tests the retroactive-match behavior (because consumers may subscribe after a chunk of log content already exists)

**Implementation notes:**
This is a deliberate cleanup task. We could leave the old API around for back-compat, but `log-match.ts` is internal to lich and only `up.ts` calls it. Cleaner to refactor now while there's exactly one caller. The retroactive-match behavior is important: `up.ts` will spawn a service, then construct LogTail, then subscribe to log-match — there's a non-zero window where the service may have already printed the ready line. The fix is `waitForLogMatch` checks `tail.buffer.split('\n')` for an existing match BEFORE subscribing. Document this design decision inline.

---

### Task 5: `ready_when.timeout` wrapper

**Dependencies:** Task 4 (so log-match takes the same shape as the others)

**Files to create:**
- `packages/lich/src/ready/timeout.ts`

**Files to modify:**
- `packages/lich/src/config/types.ts` — tighten `ReadyWhen.timeout` from `unknown` to `string | number | undefined`
- `packages/lich/src/config/schema.ts` — tighten `timeout` field to a `pattern: "^[0-9]+(ms|s|m|h)?$"` string OR an integer

**Acceptance criteria:**
- `withTimeout(promise, ms): Promise<T>` wraps any promise; on timeout, rejects with `ReadyTimeoutError` (carries `ms` and an optional `phase` label)
- `parseDuration(value: string | number): number` — accepts `"30s"`, `"2m"`, `"500ms"`, `"1h"`, or a raw integer (milliseconds); throws on parse failure
- Schema rejects `timeout: "forever"` with a useful message; accepts `"60s"`, `"2m"`, `60000`

**Tests to write:**
- `packages/lich/tests/unit/ready/timeout.test.ts`:
  - `it("resolves when the wrapped promise resolves before the deadline")`
  - `it("rejects with ReadyTimeoutError when the deadline elapses")`
  - `it("ReadyTimeoutError carries the configured duration in ms")`
  - `it("parseDuration accepts seconds, minutes, hours, ms, and raw integers")` — table-driven
  - `it("parseDuration rejects malformed strings with a useful message")`
- `packages/lich/tests/unit/config/schema-ready-when-timeout.test.ts`:
  - `it("accepts ready_when.timeout: '30s' / '2m' / 500 (int)")` — happy path
  - `it("rejects ready_when.timeout: 'forever' with a useful error")`
  - `it("rejects ready_when.timeout: -1 (negative)")` — also `0`

**Implementation notes:**
Don't use the existing `withTimeout`-like pattern in `supervisor.ts` (that's specific to stop_cmd). The `ReadyTimeoutError` class lives in `ready/timeout.ts` and is exported. Plan 4's `formatter.ts` will detect it via `instanceof` and render the phase + duration. Default timeout per spec is `60s`; that default is applied in `up.ts` (Task 14), NOT in this file — keep `withTimeout` content-agnostic.

---

### Task 6: `ready_when.capture` evaluator

**Dependencies:** Task 3 (uses LogTail.buffer)

**Files to create:**
- `packages/lich/src/ready/capture.ts`

**Files to modify:**
- `packages/lich/src/config/types.ts` — tighten `ReadyWhen.capture` from `Record<string, unknown>` to `Record<string, string>` (string is the regex pattern)
- `packages/lich/src/config/schema.ts` — tighten capture's `additionalProperties` from `true` to `{ type: "string" }`

**Acceptance criteria:**
- `runCapture({ tail: LogTail, patterns: Record<string, string> }): Record<string, string>` synchronous, called after ready fires
- For each `key, regex` pair: compile regex (already validated by `validate`), run against `tail.buffer`, take first match (full match group 0 by default, or group 1 if defined). Result: `{ key: matchedValue }`.
- Missing match (regex compiles but no occurrence in buffer) → throws `CaptureMissError({ key, pattern })` with a useful message naming the key
- Schema rejects `capture: { url: 42 }` (regex must be string)

**Tests to write:**
- `packages/lich/tests/unit/ready/capture.test.ts`:
  - `it("captures named values from the LogTail buffer when patterns match")` — uses a LogTail seeded with `"https://abc-def.trycloudflare.com is ready\n"`, captures `{ url: 'https://[a-z-]+\\.trycloudflare\\.com' }`, asserts `{ url: 'https://abc-def.trycloudflare.com' }`
  - `it("uses match group 1 if the regex defines a capture group")` — pattern `Listening on port (\d+)` against `"Listening on port 8080"` returns `{ port: '8080' }`
  - `it("throws CaptureMissError naming the missing key when no match found")` 
  - `it("evaluates all keys independently; one miss doesn't block other keys")` — actually no: per the spec, missing capture fails the service; document this and ensure CaptureMissError fires on the first miss
- `packages/lich/tests/unit/config/schema-ready-when-capture.test.ts`:
  - `it("accepts capture as a string-to-string map")`
  - `it("rejects capture: { url: 42 } with a useful error")`
  - `it("rejects capture: { url: { regex: '...' } } — must be a flat string map")` — keep the API simple

**Implementation notes:**
`runCapture` is synchronous because it only inspects the already-populated `LogTail.buffer`. No I/O. Returns the `Record` for the caller to merge into the interpolation context. The capture values flow into the env interpolation pipeline (Task 12). Document that capture supports a single regex group: `(...)` — match group 1 — or no group (full match). No support for multiple groups in v1; if a user wants that, they nest captures. Keep this simple.

---

### Task 7: `fail_when.log_match` watcher

**Dependencies:** Task 3 (subscribes to LogTail)

**Files to create:**
- `packages/lich/src/failure/fail-when.ts`

**Files to modify:**
- `packages/lich/src/config/types.ts` — tighten `FailWhen` from `Record<string, unknown>` to `{ log_match?: string }`
- `packages/lich/src/config/schema.ts` — tighten `failWhenSchema` from `additionalProperties: true` to `{ properties: { log_match: { type: "string" } }, additionalProperties: false }`

**Acceptance criteria:**
- `watchFailWhen({ tail: LogTail, pattern: RegExp, signal?: AbortSignal }): Promise<never>` — returns a promise that NEVER resolves but REJECTS with `FailWhenMatchedError({ matchedLine })` if any line matches `pattern`
- Designed to be racing-compatible: callers wrap it in `Promise.race` with the `ready_when` promise so whichever fires first wins
- Aborted signal causes clean rejection (so the orchestrator can cancel it without leaks)
- Schema rejects `fail_when: { exit_code: 1 }` (unknown field; only log_match in v1)

**Tests to write:**
- `packages/lich/tests/unit/failure/fail-when.test.ts`:
  - `it("rejects with FailWhenMatchedError on first matching line")`
  - `it("never resolves on its own (stays pending until match, signal, or stop)")` — assert promise is still pending after 200ms with no match
  - `it("can race against a Promise.resolve and lose")` — `Promise.race([watchFailWhen(...), Promise.resolve('ready')])` → resolves to `'ready'`
  - `it("races against another rejection and wins if it matches first")`
  - `it("cleans up the subscription when signal aborts")` — no lingering callbacks
  - `it("matches a line already in the LogTail buffer before subscription")` — same retroactive-match behavior as log-match (use case: fail_when's pattern was already emitted during early startup)
- `packages/lich/tests/unit/config/schema-fail-when.test.ts`:
  - `it("accepts fail_when: { log_match: 'EADDRINUSE' }")`
  - `it("rejects fail_when: { log_match: 42 }")`
  - `it("rejects fail_when: { exit_code: 1 } — unknown field")`

**Implementation notes:**
The "never resolves on its own" property is the crucial design contract — fail_when is a sentinel, not a state. The orchestrator races it with ready_when; if ready_when wins, the orchestrator must call the unsubscribe returned by watchFailWhen so the sentinel doesn't fire late and crash. Document this in the function's JSDoc as a contract callers MUST honor. Test the contract directly: a test should `Promise.race`, then sleep 200ms, then assert the test didn't blow up.

---

### Task 8: `ProcessExitWatcher` — categorize owned-service exits by lifecycle stage

**Dependencies:** none directly, but conceptually pairs with Task 7

**Files to create:**
- `packages/lich/src/failure/process-exit.ts`

**Acceptance criteria:**
- `class ProcessExitWatcher` constructed with `(handle: OwnedHandle, opts: { readSignal: () => 'during_startup' | 'before_ready' | 'after_ready' })`
- `wait(): Promise<ProcessExitFailure>` — resolves when `handle.exited` resolves with a non-zero exit OR a signal kill; returns `{ kind, exitCode, signalName, stage }`. Resolves with `null` if the process exits cleanly (code 0). NEVER rejects unless `handle.exited` rejects, which it shouldn't per the OwnedHandle contract.
- `stage` is derived by calling `opts.readSignal()` at the moment of exit — so the orchestrator can flip the signal as the service progresses through its lifecycle
- Helper `formatProcessExitFailure(failure): string` — pure formatter for the error message

**Tests to write:**
- `packages/lich/tests/unit/failure/process-exit.test.ts`:
  - `it("resolves to a failure object when handle.exited resolves with non-zero code")` — uses a fake `OwnedHandle`-shaped object
  - `it("resolves to null when handle.exited resolves with code 0")`
  - `it("captures the stage label from readSignal() at the moment of exit")` — fake readSignal returns "before_ready"
  - `it("translates signal kill (SIGKILL) into a SignalExitFailure with signalName")` 
  - `it("formatProcessExitFailure renders exit code and stage in a readable way")` — string-content assertion

**Implementation notes:**
`OwnedHandle.exited` already exists (see `packages/lich/src/owned/supervisor.ts`). This watcher adds the stage-labeling semantic that `up.ts` needs but the supervisor doesn't care about. The `readSignal` callback is a closure over a mutable variable in `up.ts` — when the orchestrator transitions a service from "starting" to "ready", it flips the closure's value. This avoids the watcher needing to know about service-state, keeping it dumb.

---

### Task 9: Failure formatter — pure function that renders the failure block

**Dependencies:** Tasks 5, 6, 7, 8 (uses the error types they introduce)

**Files to create:**
- `packages/lich/src/failure/formatter.ts`

**Acceptance criteria:**
- Exported function `formatFailure(input: FailureInput): FailureBlock` — pure, no I/O
- `FailureInput`: discriminated union of `{ kind: 'exit', service, exit }`, `{ kind: 'timeout', service, ms, phase }`, `{ kind: 'fail_when', service, matchedLine }`, `{ kind: 'capture_miss', service, captureKey }`
- `FailureBlock` shape: `{ title: string; reason: string; logTail: string[]; hint?: string }`
- Title examples: `"service \"api\" failed"`, `"service \"api\" did not become ready in 30s"`, `"service \"api\" matched fail_when pattern"`
- `logTail` accepts a string buffer (the LogTail.buffer at the time of failure) and returns the last 20 lines (newline-stripped), or empty if buffer is empty
- Hints: e.g. for `EADDRINUSE` log match → `"hint: run \`lich stacks\` to find what's using the port"`; for timeout → `"hint: increase ready_when.timeout or check the service is actually responding"`

**Tests to write:**
- `packages/lich/tests/unit/failure/formatter.test.ts`:
  - One `it()` per kind covering happy path
  - `it("trims the log tail to the last 20 lines")` — feed 50 lines, assert 20
  - `it("handles empty log tail")` — produces a useful block without log content
  - `it("provides a port-conflict hint when the fail_when pattern looks like EADDRINUSE")`
  - `it("provides a timeout hint when the kind is 'timeout'")`

**Implementation notes:**
Hints are best-effort. Match on the well-known patterns from `examples/dogfood-stack/lich.yaml`:`EADDRINUSE|Cannot find module`. Don't try to be clever about other patterns — that's an open-ended rabbit hole. Document the hints in a comment block so users / future maintainers know the full set.

---

### Task 10: Extend `state/snapshot.ts` with failure fields

**Dependencies:** none

**Files to modify:**
- `packages/lich/src/state/snapshot.ts`

**Acceptance criteria:**
- `ServiceSnapshot` interface gains optional `failure_reason?: string` and `failure_log_tail?: string[]`
- Both fields are written into `state.json` only when the service state is `failed`
- Round-trips correctly: write → read → fields preserved
- Schema-compatible — old state.json files without these fields still parse

**Tests to write:**
- `packages/lich/tests/unit/state/snapshot-failure-fields.test.ts`:
  - `it("writes failure_reason and failure_log_tail when service.state is 'failed'")`
  - `it("reads back failure_reason and failure_log_tail from a snapshot")`
  - `it("does not include failure fields when state is not 'failed'")` — keeps the file clean
  - `it("parses an old snapshot without the failure fields")` — back-compat

**Implementation notes:**
This is a minimal, pure-data change. No behavior. Other tasks (especially Task 14) populate the new fields when transitioning services to `failed`. The `failure_log_tail` field is a `string[]` not a single string so each line is JSON-array-rendered cleanly in the snapshot.

---

### Task 11: Extend `Output.failure()` interface + pretty/json/quiet renderers

**Dependencies:** Task 9 (uses `FailureBlock` shape)

**Files to modify:**
- `packages/lich/src/output/index.ts`
- `packages/lich/src/output/pretty.ts`
- `packages/lich/src/output/json.ts`
- `packages/lich/src/output/quiet.ts`

**Acceptance criteria:**
- `Output` interface gains `failure(block: FailureBlock): void`
- Pretty mode: renders a red banner with the title, the reason, the log tail indented (one line per `logTail[i]`), and the hint in cyan
- JSON mode: emits a single line `{ "type": "failure", "title", "reason", "log_tail", "hint" }`
- Quiet mode: emits the same JSON line on stderr (so even quiet users see failures)

**Tests to write:**
- `packages/lich/tests/unit/output/pretty-failure.test.ts`:
  - `it("renders the failure block with red title and indented log tail")` — uses a captured stream + ANSI-strip helper
  - `it("renders without color on non-TTY streams")`
- `packages/lich/tests/unit/output/json-failure.test.ts`:
  - `it("emits a single ndjson line of type 'failure'")`

**Implementation notes:**
Keep the renderer dumb — it takes a `FailureBlock`, prints it. The formatter (Task 9) is responsible for content; the renderer is responsible for presentation. The existing `Output.error()` stays — it's for non-service failures (yaml parse errors, missing files). `Output.failure()` is specifically for per-service failures with log context. The two have visibly different shapes in pretty mode (failure has indented log tail; error doesn't).

---

### Task 12: Capture context — extend interpolation to support `${owned.X.captured.Y}`

**Dependencies:** Task 6 (capture extractor)

**Files to modify:**
- `packages/lich/src/config/interpolation.ts`
- `packages/lich/src/env/resolve.ts`

**Acceptance criteria:**
- `InterpolationContext.owned[name]` interface gains optional `captured?: Record<string, string>`
- `${owned.<name>.captured.<key>}` resolves against `ctx.owned[name].captured[key]`
- Unknown capture key → `InterpolationError` naming the key
- `SUPPORTED_SHAPES` list updated to include `owned.<name>.captured.<key>`
- `validate.ts`'s `checkInterpolations` recognizes the new shape and validates against declared captures

**Tests to write:**
- `packages/lich/tests/unit/config/interpolation.test.ts` (extended):
  - `it("resolves ${owned.X.captured.Y} against ctx.owned.X.captured.Y")` 
  - `it("throws InterpolationError with a useful message when the capture key is missing")`
  - `it("differentiates between a missing service vs a missing capture key")` — two different error messages
- `packages/lich/tests/unit/commands/validate.test.ts` (extended) — assuming validate tests exist; add:
  - `it("flags ${owned.X.captured.Y} when X.ready_when.capture doesn't declare Y")`
  - `it("flags ${owned.X.captured.Y} when X doesn't declare ready_when.capture at all")`

**Implementation notes:**
The capture values get plumbed into the interpolation context at runtime in Task 14 (the up orchestrator). This task only wires the interpolation engine + validate to know about the new shape. The schema doesn't need a change — capture values are computed at runtime, not declared in the yaml.

---

### Task 13: Capture regex compile-check in validate

**Dependencies:** Task 6 (capture exists in the schema)

**Files to modify:**
- `packages/lich/src/config/validate.ts`

**Acceptance criteria:**
- `checkRegexes()` walks `config.owned[*].ready_when.capture` and compiles each value with `RegExp(pattern, "u")`
- A bad capture regex produces a `kind: 'regex'` ValidationError with the location `/owned/<name>/ready_when/capture/<key>`
- Existing log_match checks (already in validate.ts lines 269-310) are untouched
- `lich validate` against a yaml with `capture: { url: "[bad" }` exits 1 with the regex compile error

**Tests to write:**
- `packages/lich/tests/unit/config/validate-capture-regex.test.ts`:
  - `it("compiles each regex in ready_when.capture and reports compile failures")` — bad regex
  - `it("accepts a yaml with valid capture regexes")` — happy path
  - `it("locates the error at /owned/<name>/ready_when/capture/<key>")`

**Implementation notes:**
Trivial extension to the existing `checkRegexes` function. Mirror the structure for the existing `log_match` walks. Path-format strings must match what the rest of validate uses (`${path} (/owned/${name}/...)`).

---

### Task 14: Wire `LogTail` + watchers into `up.ts` per-owned-service

**Dependencies:** Tasks 3, 5, 6, 7, 8, 9, 10, 11, 12

**Files to modify:**
- `packages/lich/src/commands/up.ts`

**Acceptance criteria:**
- In `startOwned`, AFTER `startOwnedService` succeeds:
  - Construct `LogTail({ logPath, signal })` and `start()` it (record in a per-stack registry for shutdown)
  - Construct `ProcessExitWatcher(handle, { readSignal: () => currentStage })` where `currentStage` is a local mutable variable
- In `waitReady`, when `ready_when` is defined:
  - Wrap each evaluator (`waitForHttpReady`, `waitForTcpReady`, `waitForLogMatch`) with `withTimeout(p, parseDuration(ready.timeout ?? "60s"))`
  - If `fail_when.log_match` is set, run `Promise.race([ready, watchFailWhen({tail, pattern}), exitWatcher.wait()])` so whichever fires first wins
  - If `ready_when.capture` is set, after ready fires, call `runCapture({ tail, patterns: ready.capture })` and stash captures into the interpolation context for downstream services
- On any failure: build a `FailureInput`, call `formatFailure`, call `output.failure(block)`, set `snap.failure_reason = block.reason` and `snap.failure_log_tail = block.logTail`, then re-throw so the existing per-level allSettled aggregator catches it
- After all services in a level fail, the per-level error block emits a useful summary (not "failed to start services in step N/total" with stack traces — the per-service `output.failure(...)` already showed the rich content)
- LogTails are `.stop()`'d in the catch-all + cleanup path (add to `cancelledCleanup` and to the catch-all)
- Capture values from earlier services flow into LATER services' env via the interpolation context — verify in unit test

**Tests to write:**
- `packages/lich/tests/unit/commands/up-failure-wiring.test.ts`:
  - `it("populates snap.failure_reason and snap.failure_log_tail when a service fails")` — uses a fake config that triggers process-exit
  - `it("threads captured values from one service into the next service's env")` — small synthetic config
  - `it("races fail_when against ready_when and surfaces fail_when's reason when it fires first")`
  - `it("calls .stop() on all LogTails when up cancels")` — verify no leaked timers via a captured fake LogTail

**Implementation notes:**
This is the largest task. Break it down internally: start by wiring LogTail construction (gated on a feature flag if needed during dev), then add ProcessExitWatcher, then withTimeout, then watchFailWhen race, then capture wiring. Keep `up.ts`'s current structure — don't rewrite the per-level loop. The capture context flow is subtle: `up.ts` currently builds `interpCtx` inside `waitReady` at line 854. With captures, that context needs to be MUTABLE between services in the same up — services in later levels see captures from earlier levels. Lift the context into the `UpState` interface so it's persisted across the per-level loop.

---

### Task 15: Owned-service log tail registry — shutdown ordering

**Dependencies:** Task 14

**Files to modify:**
- `packages/lich/src/commands/up.ts`

**Acceptance criteria:**
- `UpState` interface gains `logTails: Map<string, LogTail>` 
- `cancelledCleanup` includes a step to `.stop()` every LogTail before/after stopping owned handles (order: LogTail.stop() first so we stop reading the file before the supervisor closes its write fd — avoids a late read on a torn-down fd)
- The catch-all block stops all LogTails on any failure path
- The happy path (stack up successfully) leaves LogTails RUNNING — they keep tailing for any future fail_when match. Stopped on `lich down` or process exit.

**Tests to write:**
- `packages/lich/tests/unit/commands/up-failure-wiring.test.ts` (extended):
  - `it("stops all LogTails on cancellation")`
  - `it("stops all LogTails on the catch-all error path")`
  - `it("leaves LogTails running on successful up")` — verify the Map isn't cleared

**Implementation notes:**
The "leave LogTails running on success" behavior is intentional — it means a service that emits an `EADDRINUSE` line 5 minutes after startup still triggers fail_when, the failure is recorded to state.json, and the dashboard (Plan 5) can render it. Document this in `up.ts` so a future agent doesn't "clean up" the running tails. The Plan-5 dashboard work will further extend the lifetime of LogTails (subscribe a third consumer for live tail). Plan 4 doesn't need to ship that consumer, just leave the API ready for it.

---

### Task 16: `lich down` stops LogTails

**Dependencies:** Task 15

**Files to modify:**
- `packages/lich/src/commands/down.ts`

**Acceptance criteria:**
- `lich down` reads the per-stack state, identifies running LogTails (per the in-process registry maintained by `up.ts` — note that down runs in a different process, so this is essentially a no-op unless lich becomes a long-running daemon in Plan 5)
- For Plan 4 scope: simply ensure that when the supervisor is told to stop a service, any LogTail registered in the SAME process for that service is also stopped. This is the case during cancellation (Task 15). Down running in a separate process inherits no LogTail state — it kills the supervised processes and cleans up the file fds via the OS.

**Tests to write:**
- `packages/lich/tests/unit/commands/down.test.ts` (extended) — only if there's something testable; otherwise just document the no-op behavior in code comments

**Implementation notes:**
This task is small and may not need code changes at all — its purpose is to make the cross-plan dependency explicit. The interesting behavior (LogTails outliving `up` for fail_when post-startup detection) lives in Plan 5 when the daemon owns long-running state. Plan 4's contract is: in the single `lich up` process, LogTails follow the supervisor lifecycle. In `lich down`, the supervisor's stop_cmd kills the process and the OS reclaims the fd.

---

### Task 17: Always-on post-ready exit detection in `up.ts`

**Dependencies:** Task 14

**Files to modify:**
- `packages/lich/src/commands/up.ts`

**Acceptance criteria:**
- Remove the 100ms `sentinelMs` early-exit race (lines 756-769 today)
- Replace with a `ProcessExitWatcher` that watches the entire `up` window. If a service exits between ready and `lich up` returning successfully, the up still fails.
- After `lich up` returns successfully, the watchers continue (they're tied to the LogTail lifetime per Task 15). For Plan 4 scope, post-up exits update `state.json` via a background tick — but Plan 4 doesn't need to actively notify a user who's left the terminal. Plan 5 dashboard surfaces this.

**Tests to write:**
- `packages/lich/tests/unit/commands/up-failure-wiring.test.ts` (extended):
  - `it("fails the up when a service exits after ready but before up returns")` — uses a fake config with a service that becomes ready then exits 1 within 500ms
  - `it("fails immediately on a service that exits before becoming ready")` — covers the case the old sentinelMs race covered

**Implementation notes:**
This is the cleanup task that promotes the 100ms hack into a proper watcher. Be careful: the old race had a benefit — it forced an early check so the orchestrator didn't sit waiting on ready_when for a service that had already died. The new watcher must achieve the same effect, by racing in `waitReady` (Task 14). Verify with a test that the orchestrator doesn't hang waiting on ready_when after a process has died.

---

### Task 18: `--no-browser` flag for failure UX (deferred; document only)

**Dependencies:** none

**Files to modify:**
- `docs/superpowers/plans/2026-05-23-lich-v1-plan-4-failure-surfacing.md` — this section can be deleted; this task is here as a placeholder for a tiny chore

**Acceptance criteria:**
- None — this task is deliberately empty. The `--no-browser` flag belongs to Plan 5 (dashboard). Listed here only to make sure no one mistakes it for Plan 4 work.

**Implementation notes:**
SKIP this task. It exists as a deliberate negative space marker — agents reading the plan won't mistakenly add browser-opening behavior to failure paths. Remove this section before commit if desired; harmless to leave.

---

### Task 19: Update dogfood-stack lich.yaml — add fail_when, timeout, capture demos

**Dependencies:** Tasks 5, 6, 7 (schema accepts the new fields)

**Files to modify:**
- `examples/dogfood-stack/lich.yaml`

**Acceptance criteria:**
- `owned.api.fail_when.log_match: "EADDRINUSE|Cannot find module"` (already in the file per Plan 0 Task 11 — verify still present after this plan's changes)
- `owned.supabase.ready_when.timeout: "120s"` (supabase startup is slow; current value is `90s` per dogfood-stack; bump as needed)
- `owned.web.ready_when.timeout: "60s"` (current value is `60s` — keep)
- ADD a synthetic owned service to demonstrate capture, e.g.:
  ```yaml
  owned:
    tunnel_demo:
      cmd: 'echo "starting"; sleep 0.5; echo "Listening on http://localhost:54999 (demo)"; sleep 99999'
      ready_when:
        log_match: "Listening on"
        capture:
          listen_url: "http://localhost:\\d+"
      fail_when:
        log_match: "PANIC|FATAL"
  ```
  Then in env:
  ```yaml
  env:
    TUNNEL_DEMO_URL: "${owned.tunnel_demo.captured.listen_url}"
  ```
  Profile (dev) includes `tunnel_demo` so it starts on `lich up`.
- `lich validate examples/dogfood-stack/lich.yaml` exits 0
- Manual `lich up` in `examples/dogfood-stack/` brings up the stack including `tunnel_demo`; `lich env stack` shows `TUNNEL_DEMO_URL=http://localhost:54999`

**Tests to write:**
- No new test file — the existing `tests/e2e/basic-up.test.ts` continues to pass against the updated yaml, which proves the synthetic service is benign. Updated by Tasks 22, 23, 24 in e2e for the deliberately broken variants.

**Implementation notes:**
The synthetic `tunnel_demo` exists purely to exercise the capture path. Don't worry about it being silly — it's a test fixture. The dogfood-stack's purpose IS being lich's test surface. The `cmd: 'echo ...; sleep 99999'` pattern is deliberate: emit a log line that matches `ready_when.log_match`, then hang so the service stays alive. Future Plan 5 dashboard work uses the same service for the "live tail" demo.

---

### Task 20: E2e — `fail_when.log_match` triggers and surfaces correctly

**Dependencies:** Tasks 7, 11, 14, 19

**Files to create:**
- `tests/e2e/failure-fail-when.test.ts`

**Acceptance criteria:**
- Test arrange: copy dogfood-stack to tmpdir; inject an owned service with `cmd: 'echo "EADDRINUSE somewhere"; sleep 99999'` and `fail_when.log_match: "EADDRINUSE"` into the lich.yaml
- Run `lich up`; expect exit code non-zero within ~10s
- Assert stdout/stderr contains the service name, the matched line, and the hint about port conflicts
- Read `state.json`: assert the offending service has `state: "failed"`, `failure_reason` contains "EADDRINUSE", `failure_log_tail` is non-empty
- Assert `lich logs <service>` returns the full log of that service (not just the tail)

**Tests to write:**
- The file itself; follow the recipe from `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md` § "The e2e test recipe"
- Use the `afterEach` cleanup pattern with `lichProc.kill('SIGINT')`

**Implementation notes:**
This is a deliberately-broken-config test. Mutate the lich.yaml in the tmpdir BEFORE running `lich up` — read it, parse, inject the bad service, write back. Avoids depending on a separate fixtures directory.

---

### Task 21: E2e — `ready_when.timeout` fires and surfaces correctly

**Dependencies:** Tasks 5, 11, 14, 19

**Files to create:**
- `tests/e2e/failure-ready-timeout.test.ts`

**Acceptance criteria:**
- Test arrange: copy dogfood-stack, inject `owned: { hang: { cmd: 'sleep 99999', ready_when: { http_get: '/nope', timeout: '3s' } } }` into lich.yaml; add `hang` to the dev profile
- Run `lich up`; expect exit non-zero within ~10s
- Assert stdout contains service name + "did not become ready within 3s" + log tail
- Assert `state.json` has the service `failed` with `failure_reason` containing "timeout"
- Other services in the level NOT failed if they did become ready (verify the failure is scoped to `hang`)

**Implementation notes:**
The 3s timeout is the actual measurement; the test wall-clock budget is ~10s for safety. Pick a `cmd` that doesn't open any port so the http_get genuinely never resolves.

---

### Task 22: E2e — process exits immediately (during startup) is detected

**Dependencies:** Tasks 8, 11, 14, 17

**Files to create:**
- `tests/e2e/failure-process-exit.test.ts`

**Acceptance criteria:**
- Test arrange: copy dogfood-stack, inject `owned: { exiter: { cmd: 'exit 1' } }` into lich.yaml; add to dev profile
- Run `lich up`; expect exit non-zero within ~5s
- Assert stdout contains service name, exit code 1, and the log tail (which will be empty — the service emitted nothing; verify the failure block still renders cleanly)
- Assert `state.json` has the service `failed` with `failure_reason` containing "exit code 1"
- Second test case: cmd that runs for 500ms emitting some lines, THEN exits 1. Verify log tail captures those lines.

**Implementation notes:**
Two `it()` blocks: the immediate-exit case and the brief-run-then-exit case. They share `arrange` helpers. Make sure the second case sleeps long enough that the log emission has time to flush to disk before exit (otherwise the log tail will be empty due to async write timing — use `>` redirection in the cmd to force flush, or `sleep 0.2` after the echos).

---

### Task 23: E2e — port already in use is detected and surfaced

**Dependencies:** Tasks 11, 14

**Files to create:**
- `tests/e2e/failure-port-already-in-use.test.ts`

**Acceptance criteria:**
- Test arrange: start a stub HTTP server on port X in the test process; modify lich.yaml to pin an owned service's port to X
- Run `lich up`; expect exit non-zero within ~30s
- Assert stdout names the port + the conflict; if Next.js / Express prints `EADDRINUSE`, the existing `fail_when.log_match: "EADDRINUSE|Cannot find module"` on the `api` service catches it
- Cleanup: tear down the stub HTTP server in afterEach

**Implementation notes:**
The port-already-in-use detection isn't a new lich feature in v1 — it's the user's framework that emits `EADDRINUSE`. Lich's `fail_when` catches the user's log. So this test exercises the FULL chain: user framework writes log → LogTail reads log → fail_when matches → orchestrator aborts. The stub server in the test should be a trivial `createServer((_, res) => res.end())` listening on a fixed port. Mutate the lich.yaml to pin that port via `port: { env: PORT, host_port: <X> }`.

---

### Task 24: E2e — `ready_when.capture` extracts a log value and threads it into another service

**Dependencies:** Tasks 6, 12, 14, 19

**Files to create:**
- `tests/e2e/capture-log-value.test.ts`

**Acceptance criteria:**
- Uses the `tunnel_demo` synthetic service added in Task 19 (already in the dogfood-stack)
- Adds another owned service in the test that depends on tunnel_demo and reads `$TUNNEL_DEMO_URL` from env, echoing it to its log
- Run `lich up`; wait for the second service to emit the URL; verify it matches the actual captured value
- Verify the captured value also appears in `state.json` (Task 14 should have stashed captures somewhere readable — at minimum, the interpolation context's resolved env should be visible via `lich env stack`)
- Run `lich exec sh -c 'echo $TUNNEL_DEMO_URL'`; verify the captured URL is in the output

**Implementation notes:**
This is the most complex e2e test in Plan 4. The cleanest assertion path is `lich exec sh -c 'echo $VAR'` — directly verify the env-level integration works. The "another service" approach is secondary; if the exec test passes, the wiring is right.

---

### Task 25: E2e — `lich validate` catches malformed regex in `fail_when` and `capture`

**Dependencies:** Task 13

**Files to create:**
- `tests/e2e/failure-validate-bad-regex.test.ts`

**Acceptance criteria:**
- Test arrange: copy dogfood-stack, inject `fail_when: { log_match: "[invalid(" }` into the lich.yaml
- Run `lich validate`; expect exit non-zero, stderr contains "invalid regex" + the location `/owned/<name>/fail_when/log_match`
- Second case: bad regex in `ready_when.capture.url`; same assertion
- Third case: invalid `ready_when.timeout: "forever"`; expect schema error

**Implementation notes:**
This is the e2e analog of the unit tests for validate (Tasks 5, 13). Run `lich validate` via `runLich` (sync) — no need for spawn. Multi-`it()` block file covering each malformed-config case.

---

## Final commit message convention

Each task commits as `feat(<scope>): <imperative>` matching the repo's conventional-commits style. Examples:

- `feat(logs): LogTail primitive skeleton`
- `feat(logs): LogTail poll loop + line emission`
- `feat(ready): timeout wrapper + duration parsing`
- `feat(ready): capture extractor`
- `feat(failure): fail_when log watcher`
- `feat(failure): process-exit categorizer`
- `feat(state): failure_reason + failure_log_tail snapshot fields`
- `feat(up): wire LogTail + watchers per owned service`
- `feat(dogfood): add fail_when + capture demos`
- `test(e2e): fail_when triggers and surfaces correctly`

---

## What Plan 5 will tackle

For preview / continuity: Plan 5 introduces the daemon process. The daemon owns long-running state, including LogTails that survive a `lich up` process exit. The dashboard UI subscribes to LogTails for live tail. The failure_log_tail field this plan adds to `state.json` powers the dashboard's failure-state-rendering. So Plan 4's failure UX is "user runs lich up, sees the failure inline"; Plan 5 extends it to "dashboard shows the failure even if the user closed their terminal."