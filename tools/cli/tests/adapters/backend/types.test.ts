import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  BackendAdapter,
  RouteManifest,
  RouteEntry,
} from '../../../src/adapters/backend/types';

describe('BackendAdapter types', () => {
  it('RouteEntry carries method + path', () => {
    const entry: RouteEntry = {
      method: 'GET',
      path: '/api/users/:id',
      handlerName: 'getUserById',
    };
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/users/:id');
    expect(entry.handlerName).toBe('getUserById');
  });

  it('RouteEntry handlerName is optional', () => {
    const entry: RouteEntry = {
      method: 'POST',
      path: '/api/users',
    };
    expect(entry.handlerName).toBeUndefined();
  });

  it('RouteEntry method covers all HTTP verbs', () => {
    expectTypeOf<RouteEntry['method']>().toEqualTypeOf<
      'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
    >();
  });

  it('RouteManifest has ISO8601 timestamp + routes array', () => {
    const manifest: RouteManifest = {
      generatedAt: '2026-05-16T00:00:00.000Z',
      routes: [
        { method: 'GET', path: '/api/health' },
      ],
    };
    expect(manifest.generatedAt).toBe('2026-05-16T00:00:00.000Z');
    expect(manifest.routes).toHaveLength(1);
    expect(manifest.routes[0]!.method).toBe('GET');
  });

  it('BackendAdapter has the expected method shape', () => {
    expectTypeOf<BackendAdapter>().toMatchTypeOf<{
      name: string;
      extractRoutes(projectRoot: string): Promise<RouteManifest>;
    }>();
  });
});
