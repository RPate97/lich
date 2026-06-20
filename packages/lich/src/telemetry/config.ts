import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Quick sync probe of lich.yaml for `runtime.telemetry: <bool>`. Avoids the
 * full async parseConfig pipeline because telemetry runs on every command's
 * fast path. Block-style yaml only (the common case). Flow-style or unusual
 * indentation falls through to undefined and the user can still opt out via
 * env var or user config.
 */
export function readLichYamlTelemetry(cwd: string): boolean | undefined {
  try {
    const path = join(cwd, "lich.yaml");
    if (!existsSync(path)) return undefined;
    const yaml = readFileSync(path, "utf8");
    const match = yaml.match(/^runtime:\s*\n(?:[ \t][^\n]*\n)*?[ \t]+telemetry:\s*(true|false)\b/m);
    if (!match) return undefined;
    return match[1] === "true";
  } catch {
    return undefined;
  }
}

/**
 * Opt-out hierarchy (any of these disables telemetry):
 *
 *   1. `LICH_TELEMETRY=0` (or "false", "off", "no") env var
 *   2. `<LICH_HOME>/config.json` with `{ "telemetry": false }`
 *   3. lich.yaml `runtime.telemetry: false` (passed in via opts)
 *
 * Synchronous; called early in command dispatch and on every `captureCommand`
 * call. Cheap because all paths are file-system reads of small files.
 */
export interface TelemetryConfigOpts {
  /** Env to read; defaults to `process.env`. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Path to user config; defaults to `<LICH_HOME>/config.json`. */
  userConfigPath?: string;
  /** Value from `lich.yaml` runtime.telemetry, when known. `undefined` = no opinion. */
  lichYamlTelemetry?: boolean;
}

export function isTelemetryEnabled(opts: TelemetryConfigOpts = {}): boolean {
  const env = opts.env ?? process.env;
  if (envSaysDisabled(env)) return false;
  if (userConfigSaysDisabled(opts.userConfigPath ?? defaultUserConfigPath())) return false;
  if (opts.lichYamlTelemetry === false) return false;
  return true;
}

function defaultUserConfigPath(): string {
  return join(process.env.LICH_HOME ?? join(homedir(), ".lich"), "config.json");
}

function envSaysDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.LICH_TELEMETRY;
  if (raw === undefined) return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "0" || trimmed === "false" || trimmed === "off" || trimmed === "no";
}

function userConfigSaysDisabled(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.telemetry === false;
  } catch {
    return false;
  }
}
