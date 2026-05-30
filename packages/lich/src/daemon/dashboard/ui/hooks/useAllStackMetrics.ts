import { useEffect, useRef, useState } from 'react';
import { fetchStackMetrics, type StackMetricsSnapshot } from '../api';

const POLL_MS = 4000;

export interface AllStackMetrics {
  /** stack_id → latest sampled snapshot. */
  byStack: Record<string, StackMetricsSnapshot>;
}

const EMPTY: AllStackMetrics = { byStack: {} };

/**
 * Snapshot every stack's metrics on a 4s tick. Lighter than fanning out N
 * SSE streams — the sidebar only needs a coarse "RAM hog?" cue.
 * Pauses while the tab is hidden.
 */
export function useAllStackMetrics(stackIds: string[]): AllStackMetrics {
  const [state, setState] = useState<AllStackMetrics>(EMPTY);
  const idsRef = useRef<string[]>(stackIds);
  idsRef.current = stackIds;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async (): Promise<void> => {
      const ids = idsRef.current;
      if (ids.length === 0) return;
      const results = await Promise.all(
        ids.map((id) =>
          fetchStackMetrics(id).catch(() => null as StackMetricsSnapshot | null),
        ),
      );
      if (cancelled) return;
      const next: Record<string, StackMetricsSnapshot> = {};
      for (let i = 0; i < ids.length; i++) {
        const r = results[i];
        if (r) next[ids[i]] = r;
      }
      setState({ byStack: next });
    };

    const start = (): void => {
      if (timer !== null) return;
      void tick();
      timer = setInterval(() => void tick(), POLL_MS);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };

    if (typeof document === 'undefined' || !document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, []);

  return state;
}
