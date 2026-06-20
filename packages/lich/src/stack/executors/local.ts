import { runUpLocal, type RunUpInput, type RunUpResult } from "../../commands/up.js";
import { runDownLocal, type RunDownInput, type RunDownResult } from "../../commands/down.js";
import { runExecLocal, type RunExecInput, type RunExecResult } from "../../commands/exec.js";
import { runLogsLocal, type RunLogsInput, type RunLogsResult } from "../../commands/logs.js";
import type { StackExecutor } from "../executor.js";

export class LocalStackExecutor implements StackExecutor {
  up(input: RunUpInput): Promise<RunUpResult> { return runUpLocal(input); }
  down(input: RunDownInput): Promise<RunDownResult> { return runDownLocal(input); }
  exec(input: RunExecInput): Promise<RunExecResult> { return runExecLocal(input); }
  logs(input: RunLogsInput): RunLogsResult { return runLogsLocal(input); }
}
