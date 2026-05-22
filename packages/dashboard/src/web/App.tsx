import { useEffect, useMemo, useRef, useState } from 'react';
import { usePolledStacks } from './hooks/usePolledStacks';
import { Sidebar } from './components/Sidebar';
import { Main } from './components/Main';
import type { StackView } from '../types';

export function App() {
  const { stacks: raw } = usePolledStacks();

  // Newest first — the sidebar lists newest at top and the newest auto-selects.
  const stacks = useMemo(
    () =>
      [...raw].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [raw],
  );

  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);

  // Auto-select the newest stack once, on first arrival of data.
  useEffect(() => {
    if (selectedKey === undefined && stacks.length > 0) {
      setSelectedKey(stacks[0]!.key);
    }
  }, [stacks, selectedKey]);

  // Arrival animation: flag keys that appeared since the previous poll.
  const prevKeysRef = useRef<Set<string>>(new Set());
  const [arrivedKeys, setArrivedKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(stacks.map((s) => s.key));
    const fresh = new Set<string>();
    for (const k of current) if (!prevKeysRef.current.has(k)) fresh.add(k);
    prevKeysRef.current = current;
    if (fresh.size > 0) {
      setArrivedKeys(fresh);
      const t = setTimeout(() => setArrivedKeys(new Set()), 900);
      return () => clearTimeout(t);
    }
  }, [stacks]);

  const selected: StackView | undefined =
    stacks.find((s) => s.key === selectedKey) ?? stacks[0];
  const newestKey = stacks[0]?.key;

  return (
    <div className="app">
      <Sidebar
        stacks={stacks}
        selectedKey={selected?.key}
        onSelect={setSelectedKey}
        newestKey={newestKey}
        arrivedKeys={arrivedKeys}
      />
      {selected ? (
        <Main stack={selected} />
      ) : (
        <main className="main">
          <div className="empty">
            No stacks running. Start one with <span className="kbd">lich up</span>.
          </div>
        </main>
      )}
    </div>
  );
}
