import { useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { LogViewer } from './LogViewer';
import type { ServiceView } from '../../types';

/** One service line in the stack drawer, with an expandable live-log panel. */
export function ServiceRow({
  stackKey,
  service,
}: {
  stackKey: string;
  service: ServiceView;
}) {
  const [showLogs, setShowLogs] = useState(false);
  return (
    <div className="space-y-2 border-b py-2">
      <div className="flex items-center gap-2">
        <span
          className={
            service.status === 'up'
              ? 'h-2 w-2 rounded-full bg-green-500'
              : 'h-2 w-2 rounded-full bg-gray-400'
          }
        />
        <span className="font-medium">{service.name}</span>
        <Badge variant="outline">{service.kind}</Badge>
        {service.url ? (
          <a href={service.url} target="_blank" rel="noreferrer">
            <Button variant="link" size="sm">
              {service.url}
            </Button>
          </a>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setShowLogs((v) => !v)}
        >
          {showLogs ? 'Hide logs' : 'Logs'}
        </Button>
      </div>
      {showLogs ? <LogViewer stackKey={stackKey} service={service.name} /> : null}
    </div>
  );
}
