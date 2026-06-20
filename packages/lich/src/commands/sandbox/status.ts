import type { CommandHandler } from '../index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore, type GoldenManifest, type Fork } from '../../sandbox/snapshot-store.js';
import { TartBackend } from '../../sandbox/tart.js';
import type { SandboxBackend } from '../../sandbox/backend.js';
import { selectGoldensToEvict, type GcPolicy } from '../../sandbox/gc.js';
import { computeBakeInputsHash } from '../../sandbox/inputs-hash.js';
import { parseConfig } from '../../config/parse.js';
import { detectWorktree } from '../../worktree/detect.js';
import { pickDefaultProfile } from '../../profiles/default.js';

const DEFAULT_POLICY: GcPolicy = { keepPerProfile: 2, maxTotalBytes: 20 * 1e9 };

export interface StatusGoldenJson {
  inputsHash: string;
  shortHash: string;
  profileName: string;
  vmName: string;
  createdAt: string;
  ageSeconds: number;
  sizeBytes: number;
  liveForkCount: number;
  evictionCandidate: boolean;
}

export interface StatusForkJson {
  runVm: string;
  goldenHash: string;
  createdAt: string;
}

export interface StatusCurrentJson {
  bakeInputsHash: string | null;
  wouldFork: boolean;
  matchedGoldenHash: string | null;
}

export interface StatusJson {
  goldens: StatusGoldenJson[];
  forks: StatusForkJson[];
  current: StatusCurrentJson | null;
  policy: GcPolicy;
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes - hours * 60;
  if (hours < 24) return `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours - days * 24;
  return `${days}d ${remHours}h`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

export interface BuildStatusJsonInput {
  goldens: ReadonlyArray<GoldenManifest>;
  forks: ReadonlyArray<Fork>;
  liveForkCounts: ReadonlyMap<string, number>;
  liveGoldenHashes: ReadonlySet<string>;
  policy: GcPolicy;
  current: StatusCurrentJson | null;
  now?: number;
}

export function buildStatusJson(input: BuildStatusJsonInput): StatusJson {
  const now = input.now ?? Date.now();
  const evicted = new Set(
    selectGoldensToEvict(input.goldens, input.liveGoldenHashes, input.policy).map((g) => g.inputsHash),
  );
  const goldens: StatusGoldenJson[] = input.goldens.map((g) => {
    const created = Date.parse(g.createdAt);
    const ageSeconds = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 1000)) : 0;
    return {
      inputsHash: g.inputsHash,
      shortHash: g.inputsHash.slice(0, 12),
      profileName: g.profileName,
      vmName: g.vmName,
      createdAt: g.createdAt,
      ageSeconds,
      sizeBytes: g.sizeBytes ?? 0,
      liveForkCount: input.liveForkCounts.get(g.inputsHash) ?? 0,
      evictionCandidate: evicted.has(g.inputsHash),
    };
  });
  const forks: StatusForkJson[] = input.forks.map((f) => ({
    runVm: f.runVm,
    goldenHash: f.goldenHash,
    createdAt: f.createdAt,
  }));
  return { goldens, forks, current: input.current, policy: input.policy };
}

function resolvePolicy(config: Awaited<ReturnType<typeof parseConfig>>): GcPolicy {
  if (!config.ok) return DEFAULT_POLICY;
  const gc = config.config.runtime?.sandbox?.gc;
  return {
    keepPerProfile: gc?.keep_per_profile ?? DEFAULT_POLICY.keepPerProfile,
    maxTotalBytes: gc?.max_total_gb !== undefined ? gc.max_total_gb * 1e9 : DEFAULT_POLICY.maxTotalBytes,
  };
}

async function computeLiveness(
  store: SnapshotStore,
  backend: SandboxBackend,
): Promise<{ liveGoldenHashes: Set<string>; liveForkCounts: Map<string, number>; liveForks: Fork[] }> {
  const liveGoldenHashes = new Set<string>();
  const liveForkCounts = new Map<string, number>();
  const liveForks: Fork[] = [];
  for (const fork of store.forks()) {
    const state = await backend.inspect(fork.runVm);
    if (state.state === 'absent') continue;
    liveForks.push(fork);
    liveGoldenHashes.add(fork.goldenHash);
    liveForkCounts.set(fork.goldenHash, (liveForkCounts.get(fork.goldenHash) ?? 0) + 1);
  }
  return { liveGoldenHashes, liveForkCounts, liveForks };
}

async function resolveCurrent(
  store: SnapshotStore,
  backend: SandboxBackend,
  cwd: string,
): Promise<{ current: StatusCurrentJson | null; profileName: string | null }> {
  let worktreePath: string;
  try {
    const wt = detectWorktree(cwd);
    worktreePath = wt.path;
  } catch {
    return { current: null, profileName: null };
  }
  const lichYamlPath = join(worktreePath, 'lich.yaml');
  const parsed = await parseConfig(lichYamlPath);
  if (!parsed.ok) return { current: null, profileName: null };
  const sandbox = parsed.config.runtime?.sandbox;
  if (!sandbox) return { current: null, profileName: null };

  const profiles = parsed.config.profiles;
  const hasProfilesSection = profiles !== undefined && Object.keys(profiles).length > 0;
  let profileName: string;
  if (!hasProfilesSection) {
    profileName = 'default';
  } else {
    const pick = pickDefaultProfile(parsed.config);
    profileName = pick.name ?? 'default';
  }

  let bakeInputsHash: string | null = null;
  try {
    bakeInputsHash = await computeBakeInputsHash({
      worktreePath,
      lichYamlPath,
      profileName,
      bakeInputs: sandbox.bake_inputs,
    });
  } catch {
    return { current: { bakeInputsHash: null, wouldFork: false, matchedGoldenHash: null }, profileName };
  }

  const matched = store.findByHash(bakeInputsHash);
  if (!matched) {
    return { current: { bakeInputsHash, wouldFork: false, matchedGoldenHash: null }, profileName };
  }
  const state = await backend.inspect(matched.vmName);
  if (state.state === 'absent') {
    return { current: { bakeInputsHash, wouldFork: false, matchedGoldenHash: null }, profileName };
  }
  return { current: { bakeInputsHash, wouldFork: true, matchedGoldenHash: bakeInputsHash }, profileName };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function ageAgo(createdAt: string, now: number): string {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return '?';
  return formatAge(Math.max(0, (now - t) / 1000));
}

function printHuman(status: StatusJson, currentProfile: string | null, now: number): string {
  const out: string[] = [];
  out.push('GOLDENS');
  if (status.goldens.length === 0) {
    out.push('  (none)');
  } else {
    out.push(
      `${pad('hash', 13)}${pad('profile', 12)}${pad('age', 12)}${pad('size', 10)}${pad('forks', 7)}evict?`,
    );
    for (const g of status.goldens) {
      out.push(
        `${pad(g.shortHash, 13)}${pad(g.profileName, 12)}${pad(formatAge(g.ageSeconds), 12)}${pad(formatBytes(g.sizeBytes), 10)}${pad(String(g.liveForkCount), 7)}${g.evictionCandidate ? 'yes' : ''}`,
      );
    }
  }

  out.push('');
  out.push('FORKS');
  if (status.forks.length === 0) {
    out.push('  (none)');
  } else {
    out.push(`${pad('run vm', 30)}${pad('golden', 14)}created`);
    for (const f of status.forks) {
      out.push(`${pad(f.runVm, 30)}${pad(f.goldenHash.slice(0, 12), 14)}${ageAgo(f.createdAt, now)} ago`);
    }
  }

  if (status.current) {
    out.push('');
    out.push(`CURRENT${currentProfile ? ` (${currentProfile})` : ''}`);
    out.push(`bake inputs hash: ${status.current.bakeInputsHash ?? '(unavailable)'}`);
    if (status.current.wouldFork && status.current.matchedGoldenHash) {
      out.push(`would: fork (matches ${status.current.matchedGoldenHash.slice(0, 12)})`);
    } else {
      out.push('would: rebake (no matching golden)');
    }
    const gb = (status.policy.maxTotalBytes / 1e9).toFixed(1);
    out.push(`policy: keep ${status.policy.keepPerProfile}/profile, ${gb} GB total`);
  }

  return out.join('\n') + '\n';
}

export const sandboxStatus: CommandHandler = async (ctx) => {
  const storeDir = process.env.LICH_HOME
    ? join(process.env.LICH_HOME, 'sandboxes')
    : join(homedir(), '.lich', 'sandboxes');
  const store = new SnapshotStore(storeDir);
  const backend = new TartBackend();
  const now = Date.now();

  const cwd = process.cwd();
  const lichYamlPath = join(cwd, 'lich.yaml');
  const parsed = await parseConfig(lichYamlPath);
  const policy = resolvePolicy(parsed);

  const goldens = store.list();
  const { liveGoldenHashes, liveForkCounts, liveForks } = await computeLiveness(store, backend);
  const { current, profileName } = await resolveCurrent(store, backend, cwd);

  const status = buildStatusJson({
    goldens,
    forks: liveForks,
    liveForkCounts,
    liveGoldenHashes,
    policy,
    current,
    now,
  });

  if (ctx.argv.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return { ok: true };
  }

  process.stdout.write(printHuman(status, profileName, now));
  return { ok: true };
};
