import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  FrontendAdapter,
  GenerateClientInput,
} from '../../../src/adapters/frontend/types';
import type { RouteManifest } from '../../../src/adapters/backend/types';

describe('FrontendAdapter types', () => {
  it('GenerateClientInput carries routes + outDir', () => {
    const routes = { routes: [] } as unknown as RouteManifest;
    const input: GenerateClientInput = { routes, outDir: '/abs/out' };
    expect(input.outDir).toBe('/abs/out');
  });

  it('FrontendAdapter has the expected method shape', () => {
    expectTypeOf<FrontendAdapter>().toMatchTypeOf<{
      name: string;
      generateClient(input: GenerateClientInput): Promise<{ files: string[] }>;
    }>();
  });
});
