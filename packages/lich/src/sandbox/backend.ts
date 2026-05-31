// SandboxBackend: low-level VMM abstraction. Wraps a hypervisor capable
// of running Linux microVMs and supporting suspend/clone/resume for
// warm-fork. V0 ships TartBackend (Mac); FirecrackerBackend (Linux) is V1.
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
  | 'suspended'
  | 'unknown';

export interface SandboxState {
  name: string;
  state: SandboxLifecycleState;
  /** Present only when state === 'running' or 'suspended' (post-resume). */
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
  /** Graceful stop. Idempotent if already stopped. */
  stop(name: string): Promise<void>;
  /** Hard destroy: stops if running, then removes the VM and its disk. Idempotent. */
  destroy(name: string): Promise<void>;
  /** Pause + persist memory + device state. Resumable. */
  suspend(name: string): Promise<void>;
  /** Resume from a suspended state. */
  resume(name: string): Promise<void>;
  /** CoW-clone an existing VM (typically suspended). The clone inherits state. */
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
