import { PostHog } from "posthog-node";
import { VERSION } from "../version.js";
import { getInstallationId } from "./installation-id.js";
import { isTelemetryEnabled } from "./config.js";

// PostHog public write key. Safe to embed in client code; PostHog scopes it
// to write-only event capture (cannot read or list anything).
const POSTHOG_API_KEY = "phc_sGvHNd7WNParEj4yL2unUFvUhuWSzvQneQgqR6K9P8Pe";
const POSTHOG_HOST = "https://us.i.posthog.com";

let client: PostHog | null = null;
let enabled: boolean | null = null;

function ensureClient(): PostHog | null {
  if (!isEnabled()) return null;
  if (client) return client;
  try {
    client = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      // Smallest batch so events fire quickly for short-lived CLI processes.
      flushAt: 1,
      flushInterval: 0,
      // Silence noisy errors — we never want telemetry to log to user's stderr.
      disableGeoip: true,
    });
    // posthog-node logs errors to console by default; mute.
    client.on("error", () => {});
  } catch {
    client = null;
  }
  return client;
}

function isEnabled(): boolean {
  if (enabled === null) enabled = isTelemetryEnabled();
  return enabled;
}

function platform(): string {
  return `${process.platform}-${process.arch}`;
}

/** Capture a CLI command invocation. Fire-and-forget; never throws. */
export function captureCommand(args: {
  command: string;
  exitCode: number;
  durationMs: number;
}): void {
  try {
    const ph = ensureClient();
    if (!ph) return;
    const distinctId = getInstallationId() ?? "anonymous";
    ph.capture({
      distinctId,
      event: "cli_command",
      properties: {
        command: args.command,
        exit_code: args.exitCode,
        duration_ms: args.durationMs,
        version: VERSION,
        platform: platform(),
      },
    });
  } catch {
    // never let telemetry break the CLI
  }
}

/**
 * Flush queued events and shut down the client. Call once before
 * `process.exit`. Pass shutdownTimeoutMs to posthog-node directly so it
 * manages its own in-flight requests instead of being abandoned mid-flush
 * by an outer Promise.race. Outer race is a hard ceiling at 6s in case
 * posthog-node's internal timer is broken.
 */
export async function flush(): Promise<void> {
  if (!client) return;
  try {
    await Promise.race([
      client.shutdown(5000),
      new Promise<void>((resolve) => setTimeout(resolve, 6000)),
    ]);
  } catch {
    // never throw from telemetry
  } finally {
    client = null;
  }
}

/** Test-only reset. */
export function _reset(): void {
  client = null;
  enabled = null;
}
