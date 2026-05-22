import { describe, it, expect } from 'vitest';
import { summarize } from '../src/web/components/summary';
import type { StackView } from '../src/types';

const stack = (status: StackView['status'], up: number): StackView => ({
  key: 'k', path: '/p', branch: 'b', createdAt: '', status,
  worktreeMissing: false, urls: {},
  services: Array.from({ length: up }, (_, i) => ({
    name: `s${i}`, kind: 'owned', status: 'up',
  })),
});

describe('summarize', () => {
  it('counts statuses and live services', () => {
    const out = summarize([stack('running', 2), stack('partial', 1), stack('down', 0)]);
    expect(out).toEqual({ running: 1, partial: 1, down: 1, servicesLive: 3 });
  });
});
