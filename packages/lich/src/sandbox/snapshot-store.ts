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
}
