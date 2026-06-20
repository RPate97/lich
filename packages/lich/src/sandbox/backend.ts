// SandboxBackend: low-level VMM abstraction. Wraps a hypervisor capable
// of running Linux microVMs and CoW-cloning their disk for warm-fork.
// V0 ships TartBackend (Mac); FirecrackerBackend (Linux) is V1.
//
// Warm-fork here is disk-level, not memory-level: a golden VM is baked,
// shut down cleanly, and CoW-cloned; each fork boots fresh against the
// baked disk. Apple Virtualization.framework cannot suspend Linux guests,
// so memory-snapshot fork is not available on this substrate.
//
// This is NOT a user-facing API. The user-facing surface is `runtime.sandbox`
// in lich.yaml, which `SandboxRuntime` (src/sandbox/runtime.ts) orchestrates
// on top of this interface.

export interface SandboxConfig {
  /** Logical name. Unique per host. Use `naming.ts` to derive deterministic names. */
  name: string;
  /** Image identifier (e.g. "lich-sandbox-base:latest"). */
  image: string;
  /** Memory in MB. Default 4096. */
  memoryMb?: number;
  /** Virtual CPU count. Default 4. */
  cpus?: number;
  /** Host directories to mount read-write into the guest. */
  mounts?: ReadonlyArray<{ hostPath: string; guestPath: string; readOnly?: boolean }>;
}

export type SandboxLifecycleState =
  | 'absent'
  | 'stopped'
  | 'running'
  | 'unknown';

export interface SandboxState {
  name: string;
  state: SandboxLifecycleState;
  /** Present only when state === 'running'. */
  ip?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Working directory in the guest. */
  cwd?: string;
  /** Env vars to set in the guest shell. */
  env?: Record<string, string>;
  /** Hard timeout in ms. */
  timeoutMs?: number;
  /** If true, stream stdout/stderr to the host's stdout/stderr in real time. */
  inheritStdio?: boolean;
}

export interface SandboxBackend {
  /** Idempotent: returns silently if the VM already exists with the same config. */
  create(config: SandboxConfig): Promise<void>;
  /** Boot a created VM. Idempotent if already running. */
  start(name: string): Promise<void>;
  /**
   * Graceful in-guest shutdown that flushes the disk, then awaits stopped.
   * Required before clone: a hard stop drops unsynced writes, so the baked
   * data would not survive into the fork. Idempotent if already stopped.
   */
  stop(name: string): Promise<void>;
  /** Hard destroy: stops if running, then removes the VM and its disk. Idempotent. */
  destroy(name: string): Promise<void>;
  /**
   * CoW-clone a stopped VM's disk. The clone inherits the baked disk state
   * (migrations, installed deps, build output); it boots fresh, not warm.
   * Source must be stopped via stop() first so all writes are flushed.
   */
  clone(source: string, dest: string): Promise<void>;
  /** Run a command inside the guest. Requires the VM to be running. */
  exec(name: string, cmd: ReadonlyArray<string>, opts?: ExecOptions): Promise<ExecResult>;
  /** Returns the guest's IP on the host network. Requires running. */
  ip(name: string): Promise<string>;
  /** List all VMs known to the backend. */
  list(): Promise<ReadonlyArray<SandboxState>>;
  /** Inspect a single VM. Returns 'absent' state if unknown. */
  inspect(name: string): Promise<SandboxState>;
}
