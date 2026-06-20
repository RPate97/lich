export interface SyncStartOpts {
  name: string;
  hostPath: string;
  target: string;
  guestPath: string;
  ignore: ReadonlyArray<string>;
  extraFlags?: ReadonlyArray<string>;
}

export interface SandboxSync {
  /** Establish a session and resolve after the initial sync completes. */
  start(opts: SyncStartOpts): Promise<void>;
  flush(name: string): Promise<void>;
  /** Idempotent: tearing down a missing session is not an error. */
  terminate(name: string): Promise<void>;
  status(name: string): Promise<string>;
}

// A host-arch node_modules in a Linux guest is a silent breakage, and .git
// bloats the transfer; both are always excluded regardless of caller config.
export const ALWAYS_IGNORE: ReadonlyArray<string> = ["node_modules", ".git"];
export const DEFAULT_IGNORE: ReadonlyArray<string> = [
  ...ALWAYS_IGNORE,
  "dist",
  ".next",
  "build",
  ".turbo",
];
