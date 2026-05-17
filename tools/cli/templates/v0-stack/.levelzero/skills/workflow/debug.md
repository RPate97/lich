---
name: debug
description: How to diagnose a failing test or runtime error in a levelzero project
applies-to: workflow
---

# Debugging a failure

When something breaks, resist the urge to guess. Each step below narrows
the search space; do them in order so you stop as soon as the root cause
shows itself.

## 1. Read the failure carefully

- Copy the full failing test output or stack trace into your scratchpad.
  The first non-framework frame is almost always the right place to look.
- If the failure is a type error, run `levelzero types` to get the
  unfiltered TypeScript output — Vitest's pretty-printer sometimes hides
  the underlying diagnostic.

## 2. Inspect the runtime

- Use `levelzero logs api --tail 100` (or `--service web`) to see what the
  dev process actually emitted around the failure. Add `--grep <pattern>`
  to filter, or `--since -5m` for a time window.
- If you suspect a request didn't even reach the handler, check
  `levelzero logs` without a service filter — middleware and the router
  log there.

## 3. Check the data layer

- Run `levelzero db inspect` to see the live schema. If a migration was
  generated but not applied, this is where it surfaces — the schema on
  disk and the schema in the database will disagree.
- For data-shape bugs, query the database directly through the inspector
  rather than adding `console.log` to the handler.

## 4. Reproduce in isolation

- Re-run only the failing test: `vitest run path/to/file.test.ts -t "<name>"`.
  A 200ms loop beats a 30-second suite for hypothesis testing.
- Once you have a minimal repro, add it as a permanent regression test
  before fixing the bug. Then run `levelzero check` to confirm no
  conformance rule regressed alongside your fix.
