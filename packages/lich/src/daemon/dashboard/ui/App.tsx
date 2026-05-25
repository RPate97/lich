// App.tsx — top-level shell for the lich dashboard SPA.
//
// Sidebar lists every stack the daemon knows about (polled every 2s); Main
// renders the currently-selected stack's detail. v1 differences from v0:
//   - Uses `id`/`worktree_name` (StackView wire shape) instead of `key`/`branch`.
//   - Sort key for "newest first" is `started_at` (StackView's ISO timestamp).
//   - No metrics polling — the CPU/RAM widget is gone per the v1 design.

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePolledStacks } from './hooks/usePolledStacks';
import { Sidebar } from './components/Sidebar';
import { Main } from './components/Main';
import type { StackView } from './api';

export function App() {
  const { stacks: raw, error } = usePolledStacks();

  // Newest first — the sidebar lists newest at top and the newest auto-selects.
  // Stacks without a `started_at` timestamp sort to the end (they shouldn't
  // happen in practice; defensive against the schema's optionality).
  const stacks = useMemo(() => {
    const ts = (s: StackView) =>
      s.started_at ? new Date(s.started_at).getTime() : 0;
    return [...raw].sort((a, b) => ts(b) - ts(a));
  }, [raw]);

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  // Auto-select the newest stack once, on first arrival of data.
  useEffect(() => {
    if (selectedId === undefined && stacks.length > 0) {
      setSelectedId(stacks[0]!.id);
    }
  }, [stacks, selectedId]);

  // If the currently-selected stack disappears (lich down), clear the
  // selection so the auto-select logic can pick a fresh one.
  useEffect(() => {
    if (selectedId && !stacks.some((s) => s.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [stacks, selectedId]);

  // Arrival animation: flag ids that appeared since the previous poll.
  const prevIdsRef = useRef<Set<string>>(new Set());
  const [arrivedIds, setArrivedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(stacks.map((s) => s.id));
    const fresh = new Set<string>();
    for (const id of current) {
      if (!prevIdsRef.current.has(id)) fresh.add(id);
    }
    prevIdsRef.current = current;
    if (fresh.size > 0) {
      setArrivedIds(fresh);
      const t = setTimeout(() => setArrivedIds(new Set()), 900);
      return () => clearTimeout(t);
    }
  }, [stacks]);

  const selected: StackView | undefined =
    stacks.find((s) => s.id === selectedId) ?? stacks[0];
  const newestId = stacks[0]?.id;

  return (
    <div className="app">
      <Sidebar
        stacks={stacks}
        selectedId={selected?.id}
        onSelect={setSelectedId}
        newestId={newestId}
        arrivedIds={arrivedIds}
      />
      {selected ? (
        <Main stack={selected} />
      ) : (
        <main className="main">
          <div className="empty">
            {error ? (
              <span>
                Couldn't reach the dashboard API:{' '}
                <code style={{ color: 'var(--status-unhealthy)' }}>{error}</code>
              </span>
            ) : (
              <span>
                No stacks running. Start one with{' '}
                <span className="kbd">lich up</span>.
              </span>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
