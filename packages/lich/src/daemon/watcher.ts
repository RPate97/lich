import chokidar, { type FSWatcher } from "chokidar";
import { mkdir } from "node:fs/promises";

export interface StateWatcherOpts {
  stateRoot: string;
  onChange: () => void;
  debounceMs?: number;
}

// 100ms coalesces the multi-write burst from a single `lich up` (initial
// snapshot → port allocation → per-service ready → lifecycle hooks).
const DEFAULT_DEBOUNCE_MS = 100;

/** Watches a state directory recursively and fires a debounced callback on any change. */
export class StateWatcher {
  private readonly stateRoot: string;
  private readonly onChange: () => void;
  private readonly debounceMs: number;

  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(opts: StateWatcherOpts) {
    this.stateRoot = opts.stateRoot;
    this.onChange = opts.onChange;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** Idempotent: a second call while running is a no-op. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Pre-create the watched directory to sidestep Linux fs.watch racing directory creation.
    await mkdir(this.stateRoot, { recursive: true }).catch(() => {});

    this.watcher = chokidar.watch(this.stateRoot, {
      ignoreInitial: true,
      persistent: true,
    });

    const trigger = () => this.triggerDebounced();
    this.watcher.on("add", trigger);
    this.watcher.on("change", trigger);
    this.watcher.on("unlink", trigger);
    this.watcher.on("addDir", trigger);
    this.watcher.on("unlinkDir", trigger);

    // Await 'ready' so callers writing immediately after start() don't race the initial scan.
    await new Promise<void>((resolve) => {
      const w = this.watcher as FSWatcher;
      w.once("ready", () => resolve());
    });
  }

  /** Idempotent: safe to call before start(), after stop(), or repeatedly. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher !== null) {
      // Await close so callers that immediately delete the directory don't race the last events.
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private triggerDebounced(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      try {
        this.onChange();
      } catch {
        // Swallow so a consumer bug doesn't tear down the watcher.
      }
    }, this.debounceMs);
  }
}
