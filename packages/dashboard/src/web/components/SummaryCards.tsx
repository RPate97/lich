import { Card, CardHeader, CardTitle, CardDescription } from './ui/card';
import { summarize } from './summary';
import type { StackView } from '../../types';

export function SummaryCards({ stacks }: { stacks: StackView[] }) {
  const s = summarize(stacks);
  const cards = [
    { label: 'Running', value: s.running },
    { label: 'Partial', value: s.partial },
    { label: 'Down', value: s.down },
    { label: 'Services live', value: s.servicesLive },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardHeader>
            <CardDescription>{c.label}</CardDescription>
            <CardTitle className="text-3xl">{c.value}</CardTitle>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
