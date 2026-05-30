import { useEffect, useReducer, useRef } from 'react';
import {
  openMetricsStream,
  type ServiceMetrics,
  type StackMetricsSnapshot,
} from '../api';

/** ~60s of history at the daemon's 2s cadence — keep 30 frames per series. */
export const RING_SIZE = 30;

export interface StackMetricsState {
  /** Latest sample, or null until the first frame arrives. */
  latest: StackMetricsSnapshot | null;
  /** Oldest → newest mem_bytes per service. */
  memBytesByService: Record<string, number[]>;
  /** Oldest → newest cpu_pct per service. */
  cpuPctByService: Record<string, number[]>;
  /** Oldest → newest stack-total mem_bytes. */
  totalMemBytes: number[];
  /** Oldest → newest stack-total cpu_pct. */
  totalCpuPct: number[];
}

const EMPTY_STATE: StackMetricsState = {
  latest: null,
  memBytesByService: {},
  cpuPctByService: {},
  totalMemBytes: [],
  totalCpuPct: [],
};

type Action =
  | { type: 'reset' }
  | { type: 'frame'; snap: StackMetricsSnapshot };

function pushBounded(arr: number[], v: number): number[] {
  const next = arr.length >= RING_SIZE ? arr.slice(1) : arr.slice();
  next.push(v);
  return next;
}

function reduce(state: StackMetricsState, action: Action): StackMetricsState {
  if (action.type === 'reset') return EMPTY_STATE;

  const snap = action.snap;
  const memByService = { ...state.memBytesByService };
  const cpuByService = { ...state.cpuPctByService };

  // Track service set so a renamed/removed service doesn't leak into the
  // history pane after a hot-edit of lich.yaml.
  const seen = new Set<string>();
  for (const svc of snap.services) {
    seen.add(svc.name);
    memByService[svc.name] = pushBounded(
      memByService[svc.name] ?? [],
      svc.mem_bytes,
    );
    cpuByService[svc.name] = pushBounded(
      cpuByService[svc.name] ?? [],
      svc.cpu_pct,
    );
  }
  for (const name of Object.keys(memByService)) {
    if (!seen.has(name)) delete memByService[name];
  }
  for (const name of Object.keys(cpuByService)) {
    if (!seen.has(name)) delete cpuByService[name];
  }

  return {
    latest: snap,
    memBytesByService: memByService,
    cpuPctByService: cpuByService,
    totalMemBytes: pushBounded(state.totalMemBytes, snap.total.mem_bytes),
    totalCpuPct: pushBounded(state.totalCpuPct, snap.total.cpu_pct),
  };
}

/** Find a service's latest metrics by name. */
export function findServiceMetrics(
  snap: StackMetricsSnapshot | null,
  name: string,
): ServiceMetrics | undefined {
  if (!snap) return undefined;
  return snap.services.find((s) => s.name === name);
}

/**
 * Subscribe to /api/stacks/<id>/metrics/stream for the given stack id.
 * Reset on id change. Pause the EventSource while the tab is hidden
 * (re-opens on visible) so a background tab doesn't keep the daemon busy.
 */
export function useStackMetrics(stackId: string | undefined): StackMetricsState {
  const [state, dispatch] = useReducer(reduce, EMPTY_STATE);

  // Tab visibility flag is shared across re-renders so the effect only
  // re-subscribes on id changes, not every visibility flip.
  const visibleRef = useRef<boolean>(
    typeof document === 'undefined' ? true : !document.hidden,
  );

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!stackId) return;

    let closer: (() => void) | null = null;
    let cancelled = false;

    const open = (): void => {
      if (cancelled || closer) return;
      closer = openMetricsStream(stackId, (snap) => {
        if (!cancelled) dispatch({ type: 'frame', snap });
      });
    };

    const close = (): void => {
      if (closer) {
        try {
          closer();
        } catch {
          /* ignore */
        }
        closer = null;
      }
    };

    const onVisibility = (): void => {
      const visible = !document.hidden;
      visibleRef.current = visible;
      if (visible) {
        open();
      } else {
        close();
      }
    };

    if (visibleRef.current) open();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [stackId]);

  return state;
}
