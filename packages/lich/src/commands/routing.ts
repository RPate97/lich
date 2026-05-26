import { readDaemonUrl } from "../daemon/pid-file.js";

export interface RunRoutingInput {
  json?: boolean;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export interface RunRoutingResult {
  exitCode: number;
}

interface RoutingEntry {
  hostname: string;
  upstream_url: string;
}

export async function runRouting(
  input: RunRoutingInput = {},
): Promise<RunRoutingResult> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  let dashboardUrl: string | null;
  try {
    dashboardUrl = await readDaemonUrl();
  } catch (e) {
    err.write(`lich routing: failed to read daemon URL: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }

  if (dashboardUrl === null) {
    err.write(
      `lich routing: no daemon is running for this LICH_HOME ` +
        `(run \`lich up\` to start one)\n`,
    );
    return { exitCode: 1 };
  }

  const url = `${dashboardUrl.replace(/\/$/, "")}/api/routing`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    err.write(
      `lich routing: failed to reach daemon at ${url}: ${(e as Error).message}\n`,
    );
    return { exitCode: 1 };
  }

  if (res.status === 503) {
    const body = await res.text().catch(() => "");
    err.write(
      `lich routing: daemon does not expose /api/routing ` +
        `(rebuild the daemon binary?)\n` +
        (body ? `  detail: ${body}\n` : ""),
    );
    return { exitCode: 1 };
  }

  if (res.status !== 200) {
    const body = await res.text().catch(() => "");
    err.write(
      `lich routing: GET /api/routing returned ${res.status}\n` +
        (body ? `  body: ${body}\n` : ""),
    );
    return { exitCode: 1 };
  }

  let entries: RoutingEntry[];
  try {
    entries = (await res.json()) as RoutingEntry[];
  } catch (e) {
    err.write(
      `lich routing: failed to parse /api/routing response: ${(e as Error).message}\n`,
    );
    return { exitCode: 1 };
  }

  if (input.json) {
    out.write(JSON.stringify(entries, null, 2) + "\n");
    return { exitCode: 0 };
  }

  if (entries.length === 0) {
    out.write("no routes\n");
    out.write(
      "(the daemon is running but has no routing entries — run `lich up` in a worktree)\n",
    );
    return { exitCode: 0 };
  }

  // Routing keys omit ".lich.localhost"; the proxy strips it before lookup, so re-append it for display.
  const SUFFIX = ".lich.localhost";
  const rendered = entries.map((e) => ({
    full: `${e.hostname}${SUFFIX}`,
    upstream: e.upstream_url,
  }));
  const hostHeader = "host";
  const maxHostLen = Math.max(
    hostHeader.length,
    ...rendered.map((r) => r.full.length),
  );

  out.write(`${hostHeader.padEnd(maxHostLen)} → upstream\n`);
  for (const r of rendered) {
    out.write(`${r.full.padEnd(maxHostLen)} → ${r.upstream}\n`);
  }
  return { exitCode: 0 };
}
