import { describe, it, expect } from 'vitest';
import { getBuiltinServices } from '../../src/services/builtins';

describe('getBuiltinServices', () => {
  it('includes postgres as a DockerService', () => {
    const list = getBuiltinServices();
    const pg = list.find((s) => s.name === 'postgres');
    expect(pg).toBeDefined();
    expect(pg!.kind).toBe('docker');
  });

  it('includes api as an OwnedService that depends on postgres', () => {
    const list = getBuiltinServices();
    const api = list.find((s) => s.name === 'api');
    expect(api).toBeDefined();
    expect(api!.kind).toBe('owned');
    expect(api!.portNames).toEqual(['api-http']);
    if (api!.kind === 'owned') {
      expect(api!.cwd).toBe('apps/api');
      expect(api!.command).toBe('bun run dev');
      expect(api!.dependsOn).toContain('postgres');
      expect(api!.urlName).toBe('api');
      expect(api!.envContributions({ 'api-http': 3001 }).API_URL).toBe(
        'http://localhost:3001',
      );
    }
  });

  it('includes web as an OwnedService that depends on api', () => {
    const list = getBuiltinServices();
    const web = list.find((s) => s.name === 'web');
    expect(web).toBeDefined();
    expect(web!.kind).toBe('owned');
    expect(web!.portNames).toEqual(['web-http']);
    if (web!.kind === 'owned') {
      expect(web!.cwd).toBe('apps/web');
      expect(web!.command).toBe('bun run dev');
      expect(web!.dependsOn).toContain('api');
      expect(web!.urlName).toBe('web');
      expect(web!.envContributions({ 'web-http': 3002 }).WEB_URL).toBe(
        'http://localhost:3002',
      );
    }
  });

  it('returns exactly postgres + api + web', () => {
    const list = getBuiltinServices();
    expect(list.map((s) => s.name).sort()).toEqual(['api', 'postgres', 'web']);
  });
});
