import { useState } from 'react';
import { usePolledStacks } from './hooks/usePolledStacks';
import { SummaryCards } from './components/SummaryCards';
import { StackTable } from './components/StackTable';
import { StackDrawer } from './components/StackDrawer';
import type { StackView } from '../types';

export function App() {
  const { stacks, error, lastUpdated } = usePolledStacks();
  const [selected, setSelected] = useState<StackView | undefined>(undefined);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">lich dashboard</h1>
        <span className="text-muted-foreground text-sm">
          {error
            ? `poll error: ${error}`
            : lastUpdated
              ? `updated ${Math.round((Date.now() - lastUpdated) / 1000)}s ago`
              : 'loading…'}
        </span>
      </header>
      <SummaryCards stacks={stacks} />
      <StackTable stacks={stacks} onSelect={setSelected} />
      <StackDrawer stack={selected} onClose={() => setSelected(undefined)} />
    </div>
  );
}
