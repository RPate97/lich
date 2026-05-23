import { useEffect, useState } from 'react';
import type { StackMetrics } from '../../types';
import { fetchStackMetrics } from '../api';

const POLL_MS = 3000;

export interface PolledMetrics {
  metrics: StackMetrics | undefined;
  error: string | undefined;
}

/**
 * Poll GET /api/stacks/:key/metrics every 3s while `key` is set.
 * Returns `{ metrics: undefined, error: undefined }` when `key` is undefined
 * and stops polling. Keeps the last good metrics on a failed poll.
 */
export function usePolledMetrics(key: string | undefined): PolledMetrics {
  const [state, setState] = useState<PolledMetrics>({
    metrics: undefined,
    error: undefined,
  });

  useEffect(() => {
    if (key === undefined) {
      setState({ metrics: undefined, error: undefined });
      return;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const metrics = await fetchStackMetrics(key);
        if (!cancelled) setState({ metrics, error: undefined });
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
  }, [key]);

  return state;
}
