import { useEffect, useState } from 'react';
import type { StackView } from '../../types';
import { fetchStacks } from '../api';

const POLL_MS = 2000;

export interface PolledStacks {
  stacks: StackView[];
  error: string | undefined;
  /** Epoch ms of the last successful poll, or undefined before the first. */
  lastUpdated: number | undefined;
}

/** Poll GET /api/stacks every 2s. Keeps the last good data on a failed poll. */
export function usePolledStacks(): PolledStacks {
  const [state, setState] = useState<PolledStacks>({
    stacks: [],
    error: undefined,
    lastUpdated: undefined,
  });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { stacks } = await fetchStacks();
        if (!cancelled) setState({ stacks, error: undefined, lastUpdated: Date.now() });
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, error: (err as Error).message }));
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return state;
}
