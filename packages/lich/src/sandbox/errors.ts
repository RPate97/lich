export class SandboxError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SandboxError';
  }
}

export class SandboxNotFoundError extends SandboxError {
  constructor(readonly sandboxName: string) {
    super(`sandbox '${sandboxName}' not found`);
    this.name = 'SandboxNotFoundError';
  }
}

export class SandboxAlreadyExistsError extends SandboxError {
  constructor(readonly sandboxName: string) {
    super(`sandbox '${sandboxName}' already exists`);
    this.name = 'SandboxAlreadyExistsError';
  }
}

export class TartCommandError extends SandboxError {
  constructor(
    readonly command: ReadonlyArray<string>,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`tart ${command.join(' ')} failed with exit ${exitCode}: ${stderr}`);
    this.name = 'TartCommandError';
  }
}
