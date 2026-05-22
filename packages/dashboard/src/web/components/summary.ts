import type { StackView } from '../../types';

export interface Summary {
  running: number;
  partial: number;
  down: number;
  servicesLive: number;
}

/** Aggregate counts for the dashboard's top summary cards. */
export function summarize(stacks: StackView[]): Summary {
  return {
    running: stacks.filter((s) => s.status === 'running').length,
    partial: stacks.filter((s) => s.status === 'partial').length,
    down: stacks.filter((s) => s.status === 'down').length,
    servicesLive: stacks.reduce(
      (n, s) => n + s.services.filter((v) => v.status === 'up').length,
      0,
    ),
  };
}
