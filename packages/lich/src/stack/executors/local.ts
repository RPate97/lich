import { runUp, type RunUpInput, type RunUpResult } from "../../commands/up.js";
import { runDown, type RunDownInput, type RunDownResult } from "../../commands/down.js";
import { runExec, type RunExecInput, type RunExecResult } from "../../commands/exec.js";
import { runLogs, type RunLogsInput, type RunLogsResult } from "../../commands/logs.js";
import type { StackExecutor } from "../executor.js";

export class LocalStackExecutor implements StackExecutor {
  up(input: RunUpInput): Promise<RunUpResult> { return runUp(input); }
  down(input: RunDownInput): Promise<RunDownResult> { return runDown(input); }
  exec(input: RunExecInput): Promise<RunExecResult> { return runExec(input); }
  logs(input: RunLogsInput): RunLogsResult { return runLogs(input); }
}
