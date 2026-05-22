import { useEffect, useRef, useState } from 'react';
import { openLogStream } from '../api';
import type { LogEvent } from '../../types';

const MAX_LINES = 1000;

/**
 * Live log panel for one service. Opens an SSE stream on mount, closes it on
 * unmount. Auto-scrolls to the bottom unless the user has scrolled up.
 */
export function LogViewer({ stackKey, service }: { stackKey: string; service: string }) {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    setLines([]);
    const close = openLogStream(stackKey, service, (e) => {
      setLines((prev) => {
        const next = [...prev, e];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });
    return close;
  }, [stackKey, service]);

  useEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    // "stuck to bottom" if within 20px of the end
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 20;
  };

  return (
    <div
      ref={boxRef}
      onScroll={onScroll}
      className="bg-muted h-64 overflow-auto rounded p-2 font-mono text-xs"
    >
      {lines.length === 0 ? (
        <div className="text-muted-foreground">waiting for log output…</div>
      ) : (
        lines.map((l, i) => (
          <div key={i} className={l.level === 'error' ? 'text-red-500' : undefined}>
            {l.ts ? <span className="text-muted-foreground">{l.ts} </span> : null}
            {l.line}
          </div>
        ))
      )}
    </div>
  );
}
