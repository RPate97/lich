import { useState } from 'react';
import { usePolledStacks } from './hooks/usePolledStacks';
import { SummaryCards } from './components/SummaryCards';
import { StackTable } from './components/StackTable';
import { StackDrawer } from './components/StackDrawer';
import { AppSidebar } from './components/app-sidebar';
import { SiteHeader } from './components/site-header';
import { SidebarInset, SidebarProvider } from './components/ui/sidebar';
import type { StackView } from '../types';

export function App() {
  const { stacks, error, lastUpdated } = usePolledStacks();
  const [selected, setSelected] = useState<StackView | undefined>(undefined);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <SiteHeader lastUpdated={lastUpdated} error={error} />
        <main className="space-y-6 p-6">
          <SummaryCards stacks={stacks} />
          <StackTable stacks={stacks} onSelect={setSelected} />
          <StackDrawer stack={selected} onClose={() => setSelected(undefined)} />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
