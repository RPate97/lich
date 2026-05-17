import { describe, it, expect, expectTypeOf } from 'vitest';
import type { PortlessAdapter, URLEntry } from '../../../src/adapters/portless/types';

describe('PortlessAdapter types', () => {
  it('URLEntry carries host + target with optional service', () => {
    const e: URLEntry = { host: 'app.example.test', target: 'http://127.0.0.1:3000' };
    expect(e.host).toBe('app.example.test');
    expect(e.target).toBe('http://127.0.0.1:3000');
  });

  it('URLEntry accepts an optional service tag', () => {
    const e: URLEntry = { host: 'api.example.test', target: 'http://127.0.0.1:4000', service: 'backend' };
    expect(e.service).toBe('backend');
  });

  it('PortlessAdapter has the expected method shape', () => {
    expectTypeOf<PortlessAdapter>().toMatchTypeOf<{
      name: string;
      available(): Promise<boolean>;
      register(input: { host: string; target: string }): Promise<void>;
      unregister(host: string): Promise<void>;
      list(): Promise<URLEntry[]>;
    }>();
  });
});
