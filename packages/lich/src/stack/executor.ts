import type { RunUpInput, RunUpResult } from "../commands/up.js";
import type { RunDownInput, RunDownResult } from "../commands/down.js";
import type { RunExecInput, RunExecResult } from "../commands/exec.js";
import type { RunLogsInput, RunLogsResult } from "../commands/logs.js";

export interface StackExecutor {
  up(input: RunUpInput): Promise<RunUpResult>;
  down(input: RunDownInput): Promise<RunDownResult>;
  exec(input: RunExecInput): Promise<RunExecResult>;
  logs(input: RunLogsInput): RunLogsResult;
}
