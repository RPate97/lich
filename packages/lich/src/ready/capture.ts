/**
 * `ready_when.capture` evaluator — extract named values from a service's
 * log buffer at the moment readiness fires (Plan 4 Task 6).
 *
 * Use case: dynamic values that only exist at runtime — a Cloudflare tunnel
 * URL printed once on startup, a port chosen by the framework when `0` is
 * passed, an auth token freshly minted by a dev tool — and which downstream
 * services need to see in their env. The user declares the regexes in
 * `ready_when.capture`; after `ready_when` fires (i.e. the service is up),
 * lich runs each regex against the accumulated log buffer and surfaces the
 * matches as `${owned.<name>.captured.<key>}` for later services to
 * interpolate.
 *
 * ### Why synchronous?
 *
 * `runCapture` only inspects `LogTail.buffer`, which is already populated by
 * the polling loop. There's no I/O — every byte was read by the LogTail's
 * existing tick mechanism — so making this async would just add overhead and
 * a wider failure surface. The orchestrator calls `runCapture` IMMEDIATELY
 * after `ready_when` resolves, so the buffer contains everything the service
 * has logged since `LogTail.start()`.
 *
 * ### Single-group convention
 *
 * Each regex captures EITHER its full match (`group 0`, when the pattern has
 * no `(...)`) OR its first capturing group (`group 1`, when present). This
 * keeps the user-facing API trivially simple:
 *
 *   - `"https://[a-z-]+\\.trycloudflare\\.com"`       → whole-URL match
 *   - `"Listening on port (\\d+)"`                    → just the port number
 *
 * We deliberately do not support multiple groups in v1. If a user needs to
 * extract two distinct values from one line, they declare two captures with
 * separate patterns. This eliminates the "which group did I mean?" question
 * and keeps validation easy: as long as the regex compiles, the extractor
 * knows exactly what to return.
 *
 * ### First-match semantics
 *
 * Each regex matches at most once per call. We use `RegExp.exec` (without
 * the `g` flag) so the engine stops at the first hit — which is the right
 * behavior for "grab the URL the service printed at startup," the dominant
 * use case. If the service prints the same URL on every request the user
 * still gets the first one (the moment-of-readiness snapshot).
 *
 * ### Miss semantics
 *
 * A regex that compiles but finds no match in the buffer raises
 * {@link CaptureMissError}. Per the plan-4 spec: a missing capture fails the
 * service. The thinking is that capture exists precisely to flow values into
 * downstream env; an unresolved capture means a downstream service will get
 * an empty string for a value the user explicitly named as required, which
 * is a louder failure than a silent empty string.
 *
 * The error fires on the FIRST missing key encountered (insertion order of
 * the `patterns` object). Users see one missing key per run; fix that and
 * the next run surfaces the next miss if any. This is intentional — a
 * "collect all misses" pass would invite users to chase symptoms in
 * isolation rather than understand the structural reason the captures
 * aren't appearing.
 */

import type { LogTail } from "../logs/tail.js";

/**
 * Thrown when a `ready_when.capture` regex compiles but finds no match in
 * the service's log buffer at the moment ready fires.
 *
 * The orchestrator wraps this in a `FailureInput` of kind `capture_miss`
 * (Plan 4 Task 9) so the failure block surfaces the key alongside the
 * service's log tail. The error message names the key first because the
 * key is what the user typed in their lich.yaml; the pattern is recoverable
 * but secondary context.
 */
export class CaptureMissError extends Error {
  /** The `ready_when.capture` key whose regex didn't match. */
  readonly key: string;
  /** The regex pattern (as originally declared by the user). */
  readonly pattern: string;

  constructor(opts: { key: string; pattern: string }) {
    super(
      `ready_when.capture key "${opts.key}" did not match any line in the service log ` +
        `(pattern: ${opts.pattern})`,
    );
    this.name = "CaptureMissError";
    this.key = opts.key;
    this.pattern = opts.pattern;
  }
}

/** Arguments to {@link runCapture}. */
export interface RunCaptureOptions {
  /**
   * The per-service {@link LogTail}. We only read `.buffer` — never
   * subscribe, never mutate. The caller has typically just observed the
   * ready evaluator resolve, so the buffer contains everything the service
   * emitted between `start()` and ready.
   */
  tail: LogTail;
  /**
   * The user-declared `ready_when.capture` map: regex pattern strings keyed
   * by the capture name. We compile each pattern here (cheap, and the
   * dedicated validate step has already ensured they compile cleanly), then
   * match against the buffer.
   */
  patterns: Record<string, string>;
}

/**
 * Run each `ready_when.capture` regex against the service's log buffer and
 * return a `Record` mapping capture key → matched value.
 *
 * - Compiles each pattern with the `u` flag (matches the validate step's
 *   compile policy so behaviour is identical across the two passes).
 * - For each key, finds the first match. If the regex has at least one
 *   capturing group, returns group 1; otherwise returns the full match
 *   (group 0).
 * - On the first key with no match, throws {@link CaptureMissError}. The
 *   error names the key first (it's what the user typed); the pattern is
 *   appended for debugging.
 *
 * Synchronous because the buffer is already populated — calling this just
 * does in-memory regex work.
 */
export function runCapture(opts: RunCaptureOptions): Record<string, string> {
  const { tail, patterns } = opts;
  // Snapshot the buffer once. The LogTail's poll loop may run concurrently
  // with this call, but `buffer` is just a string getter; reading it twice
  // could observe two different lengths. One read keeps the behaviour
  // deterministic for the duration of this call.
  const buffer = tail.buffer;
  const result: Record<string, string> = {};

  // Iterate in declaration order so the FIRST missing key is the one
  // surfaced — gives the user a stable, predictable error when they have
  // multiple captures and one isn't appearing.
  for (const [key, pattern] of Object.entries(patterns)) {
    // The `u` flag matches the validate step's compile policy
    // (`src/config/validate.ts` will use the same flag). Without it, a
    // pattern like `\d` works fine but a pattern with surrogate-pair-aware
    // escapes would compile here and fail at validate, or vice versa.
    // Keeping the flags identical means "passes validate" implies
    // "compiles cleanly here".
    //
    // We do NOT use the `g` flag — `exec` without `g` always starts from
    // position 0 and returns the first match, which is the behaviour we
    // want ("grab the URL the service printed at startup"). With `g`,
    // `exec` would track `lastIndex` on the regex object, which is
    // stateful and unwanted here.
    const re = new RegExp(pattern, "u");
    const match = re.exec(buffer);
    if (match === null) {
      throw new CaptureMissError({ key, pattern });
    }

    // Group semantics per Plan 4 spec:
    //   - if the regex defines at least one capturing group, take group 1
    //   - otherwise, take the full match (group 0)
    //
    // The `match` array is `[full, group1, group2, ...]`. `match.length`
    // is the number of group slots INCLUDING group 0. `match.length > 1`
    // means at least one user-declared `(...)` group exists.
    //
    // We coerce to string with `?? ""` for the rare case where group 1
    // matched an optional path that evaluated to undefined (e.g. `(a)?`
    // where the parenthesised portion didn't participate). The empty
    // string is the conservative choice — the user explicitly named that
    // group, so an empty match is semantically "matched, no content"
    // rather than "no match at all" (which would be a CaptureMissError).
    if (match.length > 1) {
      result[key] = match[1] ?? "";
    } else {
      result[key] = match[0];
    }
  }

  return result;
}
