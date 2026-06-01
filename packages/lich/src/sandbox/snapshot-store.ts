// SnapshotStore: tracks the manifest of golden snapshots on disk.
// The actual VM data is owned by Tart (in ~/.tart/vms/); we only track
// metadata (which hash → which golden VM name → which profile).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface GoldenManifest {
  inputsHash: string;
  vmName: string;
  profileName: string;
  lichYamlSnapshot: string;
  createdAt: string;
  /** Disk size in bytes; absent on legacy manifests pre-GC. Treated as 0 by gc.selectGoldensToEvict. */
  sizeBytes?: number;
}

export interface Fork {
  runVm: string;
  goldenHash: string;
  createdAt: string;
}

export class SnapshotStore {
  constructor(private readonly storeDir: string) {
    mkdirSync(storeDir, { recursive: true });
  }

  private get manifestPath(): string {
    return join(this.storeDir, 'manifest.json');
  }

  private readAll(): GoldenManifest[] {
    if (!existsSync(this.manifestPath)) return [];
    try {
      const content = readFileSync(this.manifestPath, 'utf8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeAll(entries: GoldenManifest[]): void {
    mkdirSync(dirname(this.manifestPath), { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(entries, null, 2));
  }

  findByHash(inputsHash: string): GoldenManifest | undefined {
    return this.readAll().find(e => e.inputsHash === inputsHash);
  }

  list(): ReadonlyArray<GoldenManifest> {
    return this.readAll();
  }

  upsert(entry: GoldenManifest): void {
    const all = this.readAll().filter(e => e.inputsHash !== entry.inputsHash);
    all.push(entry);
    this.writeAll(all);
  }

  remove(inputsHash: string): boolean {
    const before = this.readAll();
    const after = before.filter(e => e.inputsHash !== inputsHash);
    if (after.length === before.length) return false;
    this.writeAll(after);
    return true;
  }

  clear(): void {
    this.writeAll([]);
  }

  listByProfile(profileName: string): GoldenManifest[] {
    return this.readAll()
      .filter(e => e.profileName === profileName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Forks live in a sibling file so concurrent fork-recording and golden-bake
  // don't race on the same on-disk JSON.
  private get forksPath(): string {
    return join(this.storeDir, 'forks.json');
  }

  private readForks(): Fork[] {
    if (!existsSync(this.forksPath)) return [];
    try {
      const content = readFileSync(this.forksPath, 'utf8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeForks(entries: Fork[]): void {
    mkdirSync(dirname(this.forksPath), { recursive: true });
    writeFileSync(this.forksPath, JSON.stringify(entries, null, 2));
  }

  recordFork(fork: Fork): void {
    const all = this.readForks().filter(e => e.runVm !== fork.runVm);
    all.push(fork);
    this.writeForks(all);
  }

  removeFork(runVm: string): boolean {
    const before = this.readForks();
    const after = before.filter(e => e.runVm !== runVm);
    if (after.length === before.length) return false;
    this.writeForks(after);
    return true;
  }

  forks(): ReadonlyArray<Fork> {
    return this.readForks();
  }

  forksOf(goldenHash: string): ReadonlyArray<Fork> {
    return this.readForks().filter(e => e.goldenHash === goldenHash);
  }

  clearForks(): void {
    this.writeForks([]);
  }
}
