import type { OutputMode } from "../output/index.js";
import { runDown } from "./down.js";
import { runUp } from "./up.js";

export interface RunRestartInput {
  cwd?: string;
  outputMode?: OutputMode;
  out?: NodeJS.WritableStream;
  signal?: AbortSignal;
}

export interface RunRestartResult {
  exitCode: number;
  stackId?: string;
  services?: Array<{ name: string; state: string }>;
}

/** Whole-stack restart: down, then up. First non-zero exit short-circuits. */
export async function runRestart(
  input: RunRestartInput,
): Promise<RunRestartResult> {
  const downResult = await runDown({
    cwd: input.cwd,
    outputMode: input.outputMode,
    out: input.out,
    signal: input.signal,
  });
  if (downResult.exitCode !== 0) {
    return { exitCode: downResult.exitCode };
  }

  const upResult = await runUp({
    cwd: input.cwd,
    outputMode: input.outputMode,
    out: input.out,
    signal: input.signal,
  });

  return {
    exitCode: upResult.exitCode,
    ...(upResult.stackId !== undefined && { stackId: upResult.stackId }),
    ...(upResult.services !== undefined && { services: upResult.services }),
  };
}
