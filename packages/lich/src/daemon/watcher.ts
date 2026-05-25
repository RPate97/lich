/**
 * State directory watcher with debounced refresh (LEV-405, Plan 5 Task 3).
 *
 * The lich daemon needs to react when any stack's on-disk state changes —
 * the dashboard re-reads `state.json` to refresh the UI, and the reverse
 * proxy rebuilds its routing table. Rather than poll every stack directory
 * on a timer, we attach a single recursive watcher to the state root
 * (`~/.lich/stacks` or the test override) and fire a single coalesced
 * callback whenever anything underneath changes.
 *
 * ## Why chokidar instead of `fs.watch`
 *
 * `fs.watch` has well-documented cross-platform inconsistencies:
 *
 *   - macOS coalesces writes and produces a single `change` event for what
 *     Linux reports as two events
 *   - Linux requires explicit `recursive: true`; macOS supports it but with
 *     different semantics
 *   - Both throw if the watched path does not exist (we want to tolerate
 *     this for fresh-install scenarios)
 *
 * Chokidar smooths these out and gives us a uniform event surface
 * (`add`, `change`, `unlink`, `addDir`, `unlinkDir`) regardless of platform.
 *
 * ## Why debouncing matters
 *
 * `lich up` writes `state.json` multiple times during startup: initial
 * snapshot → after port allocation → after each service comes up → after
 * lifecycle hooks. Without debouncing, the daemon would rebuild its
 * routing table and refresh the dashboard 5+ times per `lich up`. A 100ms
 * debounce window coalesces these bursts into a single `onChange()` call
 * — fast enough that human latency is imperceptible, slow enough that
 * write bursts collapse to one tick.
 *
 * ## What this module does NOT do
 *
 * The watcher is a pure observer. It does not read state.json, does not
 * interpret events, does not filter by file name. It just fires the
 * opaque `onChange()` callback after a debounce window. The daemon wires
 * the callback to "have routing.ts and stacks-view.ts re-read everything"
 * — keeping the watcher reusable across consumers.
 *
 * ## Tolerance for missing stateRoot
 *
 * On a fresh install, `<LICH_HOME>/stacks` may not exist yet. The watcher
 * creates the directory on `start()` so chokidar has something to attach
 * to. This avoids a class of platform-specific errors (`ENOENT` from
 * `fs.watch` on Linux) and lets the daemon start cleanly before any
 * `lich up` has run.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { mkdir } from "node:fs/promises";

export interface StateWatcherOpts {
  /**
   * The directory to watch recursively. In production this is
   * `<LICH_HOME>/stacks` (resolved via `state/directory.ts`'s `stateRoot()`).
   * Tests pass a fresh tmpdir so file events don't leak into real state.
   */
  stateRoot: string;
  /**
   * Callback invoked after a debounce window has elapsed following any
   * file event under `stateRoot`. Bursts of events within the debounce
   * window collapse to a single call.
   */
  onChange: () => void;
  /**
   * The debounce window in milliseconds. Defaults to 100ms — enough to
   * coalesce the multi-write burst from a single `lich up`, short enough
   * that no human notices the latency.
   */
  debounceMs?: number;
}

/**
 * Default debounce window. Justified above in the JSDoc; chosen empirically
 * from the v0 dashboard's observation that `lich up` produces 5+ state
 * writes within ~50ms.
 */
const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Watches a state directory recursively and fires a debounced callback on
 * any change. The class is designed to be reusable across daemon
 * subsystems (dashboard, proxy) and is safe to start/stop multiple times.
 */
export class StateWatcher {
  private readonly stateRoot: string;
  private readonly onChange: () => void;
  private readonly debounceMs: number;

  /** Active chokidar instance, set between start() and stop(). */
  private watcher: FSWatcher | null = null;

  /** Pending debounce timer, set when an event arrives within the window. */
  private debounceTimer: NodeJS.Timeout | null = null;

  /** Guards against double-start; idempotent per the spec. */
  private started = false;

  constructor(opts: StateWatcherOpts) {
    this.stateRoot = opts.stateRoot;
    this.onChange = opts.onChange;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Begin watching the state root.
   *
   * Idempotent: a second call while the watcher is already running is a
   * no-op (does not double-attach event listeners, does not double-fire
   * callbacks).
   *
   * Tolerates a missing `stateRoot` by creating it before attaching the
   * watcher — chokidar tolerates the path being created later too, but
   * pre-creating sidesteps a class of platform-specific timing issues
   * (Linux `fs.watch` underneath chokidar can race with directory
   * creation).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Pre-create the watched directory so chokidar has a stable target.
    // Best-effort: failures here mean the daemon won't have a useful
    // watcher, but we don't want to crash the whole daemon startup. The
    // chokidar.watch call below will surface a clearer error if the
    // directory truly can't be created or accessed.
    await mkdir(this.stateRoot, { recursive: true }).catch(() => {});

    this.watcher = chokidar.watch(this.stateRoot, {
      // Skip the burst of `add` events for files that already exist
      // when the watcher starts — we only care about subsequent changes.
      // The daemon's initial state load is a separate code path
      // (it just reads stateRoot directly).
      ignoreInitial: true,
      // Keep the event loop alive while the watcher is active. The
      // daemon owns its own shutdown path; chokidar's persistent flag
      // mirrors `Bun.serve`'s "keeps the process running" behavior.
      persistent: true,
    });

    // Wire each file-system event to the debounced trigger. We listen
    // for the same set chokidar emits for recursive watches: file
    // create/change/delete and directory create/delete. We do not bind
    // `error` to onChange (errors are logged separately to avoid
    // surprising the consumer with no-arg "the state changed" pings
    // when actually something failed) — for v1 we silently swallow
    // them; the daemon's own watchdog catches a permanently-broken
    // watcher via the auto-shutdown heartbeat.
    const trigger = () => this.triggerDebounced();
    this.watcher.on("add", trigger);
    this.watcher.on("change", trigger);
    this.watcher.on("unlink", trigger);
    this.watcher.on("addDir", trigger);
    this.watcher.on("unlinkDir", trigger);

    // Wait for chokidar's initial scan to complete before resolving.
    // Without this, callers who immediately write a file after start()
    // returns may race the watcher's underlying fs.watch handles being
    // attached — the file event would be missed. Chokidar emits 'ready'
    // exactly once when the initial scan is done.
    await new Promise<void>((resolve) => {
      // `this.watcher` is non-null here — we just assigned it above. The
      // cast keeps strict-null-checks happy without an extra branch.
      const w = this.watcher as FSWatcher;
      w.once("ready", () => resolve());
    });
  }

  /**
   * Stop watching. Cleans up the chokidar instance and any pending
   * debounce timer so no further `onChange` calls fire.
   *
   * Idempotent: safe to call before `start()`, after `stop()`, or
   * multiple times in a row.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Cancel any in-flight debounce so the consumer doesn't get a final
    // onChange after they asked us to stop.
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher !== null) {
      // chokidar's close returns a promise that resolves once all
      // underlying fd handles are released. We await it so callers
      // that immediately follow stop() with a directory deletion don't
      // race the watcher's last events.
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Schedule (or reschedule) the debounced onChange callback.
   *
   * Behavior: every incoming event resets a timer to `debounceMs`. The
   * callback fires once when the timer elapses with no further events.
   * This is the classic "trailing-edge debounce" — the daemon sees the
   * cumulative result of a burst of writes rather than a flood of
   * intermediate states.
   */
  private triggerDebounced(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Run the callback in a try/catch so a consumer's bug doesn't
      // tear down the watcher. The watcher is meant to keep firing
      // regardless of what the consumer does with each event.
      try {
        this.onChange();
      } catch {
        // Intentionally swallow — see the comment above. A consumer
        // that wants observability should add its own error wrapper
        // inside the callback.
      }
    }, this.debounceMs);
  }
}
