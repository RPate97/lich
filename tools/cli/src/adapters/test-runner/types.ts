export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  raw?: string;
}

export interface TestRunInput {
  cwd: string;
  pattern?: string;
  env?: Record<string, string>;
  watch?: boolean;
  timeoutMs?: number;
}

export interface TestRunnerAdapter {
  name: string;
  run(input: TestRunInput): Promise<TestResult>;
}
