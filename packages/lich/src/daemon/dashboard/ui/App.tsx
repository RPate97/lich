import { useEffect, useMemo, useRef, useState } from 'react';
import { usePolledStacks } from './hooks/usePolledStacks';
import { Sidebar } from './components/Sidebar';
import { Main } from './components/Main';
import type { StackView } from './api';

export function App() {
  const { stacks: raw, error } = usePolledStacks();

  const stacks = useMemo(() => {
    const ts = (s: StackView) =>
      s.started_at ? new Date(s.started_at).getTime() : 0;
    return [...raw].sort((a, b) => ts(b) - ts(a));
  }, [raw]);

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (selectedId === undefined && stacks.length > 0) {
      setSelectedId(stacks[0]!.id);
    }
  }, [stacks, selectedId]);

  // Clear selection when the stack disappears so auto-select can pick a fresh one
  useEffect(() => {
    if (selectedId && !stacks.some((s) => s.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [stacks, selectedId]);

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
