// Logs.tsx — live tail of the selected stack's merged log stream.
//
// Adapted from the v0 dashboard. Wire format change: events now use the
// `id`/`worktree_name` stack identifiers and the v1 `ServiceView` from
// `api.ts`. The SSE protocol from `/api/stacks/:id/logs` is unchanged.

import { useEffect, useMemo, useRef, useState } from 'react';
import { openMergedLogStream } from '../api';
import { serviceColor, fmtClock } from '../lib/format';
import type { LogEvent, ServiceView, StackView } from '../api';

const MAX_LINES = 800;

interface LogLine {
  id: string;
  service: string;
  line: string;
  ts?: string;
  level: 'info' | 'warn' | 'error' | 'debug';
}

const IconSearch = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);

// Highlight a substring (case-insensitive) inside a message.
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  try {
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${esc})`, 'ig'));
    return (
      <>
        {parts.map((p, i) =>
          p.toLowerCase() === query.toLowerCase() ? (
            <mark key={i} className="hl">
              {p}
            </mark>
          ) : (
            <span key={i}>{p}</span>
          ),
        )}
      </>
    );
  } catch {
    return <>{text}</>;
  }
}

function LogLevel({ level }: { level: string }) {
  return <span className={`lvl lvl-${level}`}>{level}</span>;
}

// ── Stream view (default) ────────────────────────────────────────────────────

function LogStream({ logs, query }: { logs: LogLine[]; query: string }) {
  return (
    <div className="log-stream">
      {logs.map((line) => (
        <div
          key={line.id}
          className="log-line"
          data-level={line.level}
          data-no-ts={line.ts ? undefined : '1'}
        >
          {line.ts ? <span className="ts">{fmtClock(line.ts)}</span> : null}
          <span className="svc" style={{ color: serviceColor(line.service) }}>
            {line.service}
          </span>
          <span className="msg">
            <LogLevel level={line.level} />
            <Highlighted text={line.line} query={query} />
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Header bar (search + filters + tail toggle) ─────────────────────────────

interface LogsHeaderProps {
  query: string;
  setQuery: (q: string) => void;
  services: ServiceView[];
  activeServices: Set<string>;
  onChipClick: (name: string | null) => void;
  tail: boolean;
  setTail: (t: boolean) => void;
}

function LogsHeader({
  query,
  setQuery,
  services,
  activeServices,
  onChipClick,
  tail,
  setTail,
}: LogsHeaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        (document.activeElement as HTMLElement)?.tagName !== 'INPUT'
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const allActive = activeServices.size === 0;

  return (
    <div className="logs-hd">
      <div className="search">
        <IconSearch />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search logs · regex with /pattern/"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>/</kbd>
      </div>

      <div className="service-filters">
        <button
          className="filter-chip all"
          data-active={allActive ? '1' : '0'}
          onClick={() => onChipClick(null)}
        >
          all
        </button>
        {services.map((svc) => {
          const active = activeServices.has(svc.name);
          return (
            <button
              key={svc.name}
              className="filter-chip"
              data-active={active ? '1' : '0'}
              onClick={() => onChipClick(svc.name)}
              // Only adopt the service hue when active — inactive chips
              // stay muted so the filter bar reads as "what's selected"
              // rather than "every service forever colored."
              style={active ? { color: serviceColor(svc.name) } : undefined}
            >
              <span
                className="swatch"
                style={{ background: serviceColor(svc.name) }}
              />
              {svc.name}
            </button>
          );
        })}
      </div>

      <div className="log-toolbar">
        <button
          className="tail-toggle"
          data-on={tail ? '1' : '0'}
          onClick={() => setTail(!tail)}
          title={tail ? 'Pause live tail' : 'Resume live tail'}
        >
          <span className="tail-dot" />
          {tail ? 'tailing' : 'paused'}
        </button>
      </div>
    </div>
  );
}

// ── Combined Logs component ─────────────────────────────────────────────────

export function Logs({ stack }: { stack: StackView }) {
  const [query, setQuery] = useState('');
  const [tail, setTail] = useState(true);
  const [logs, setLogs] = useState<LogLine[]>([]);
  // Empty set = "all" (no filter). Non-empty = show only listed services.
  const [activeServices, setActiveServices] = useState<Set<string>>(new Set());
  const viewportRef = useRef<HTMLDivElement>(null);

  const handleChipClick = (name: string | null) => {
    if (name === null) {
      setActiveServices(new Set());
    } else {
      setActiveServices((prev) => {
        const next = new Set(prev);
        if (next.has(name)) {
          next.delete(name);
        } else {
          next.add(name);
        }
        return next;
      });
    }
  };

  // Subscribe to the merged multi-service log stream for this stack. We key
  // the effect on `stack.id` (not the services array reference) so React
  // doesn't tear down/rebuild the SSE connection every time the stacks
  // poller swaps in a new array with the same content.
  useEffect(() => {
    setLogs([]);
    if (stack.services.length === 0) return;
    let n = 0;
    const close = openMergedLogStream(stack.id, (e: LogEvent) => {
      const service = e.service ?? stack.services[0]?.name ?? 'unknown';
      setLogs((prev) => {
        const next = [
          ...prev,
          {
            id: `${stack.id}-${service}-${n++}`,
            service,
            line: e.line,
            ts: e.ts,
            level: (e.level ?? 'info') as LogLine['level'],
          },
        ];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });
    return close;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stack.id]);

  // Service filter — applied client-side on top of the merged stream.
  const serviceFiltered = useMemo(() => {
    if (activeServices.size === 0) return logs;
    return logs.filter((l) => activeServices.has(l.service));
  }, [logs, activeServices]);

  // Search filter — substring, or /pattern/ for regex.
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return serviceFiltered;
    if (q.length >= 2 && q.startsWith('/') && q.endsWith('/')) {
      try {
        const re = new RegExp(q.slice(1, -1), 'i');
        return serviceFiltered.filter(
          (l) => re.test(l.line) || re.test(l.service),
        );
      } catch {
        return serviceFiltered;
      }
    }
    const lq = q.toLowerCase();
    return serviceFiltered.filter(
      (l) =>
        l.line.toLowerCase().includes(lq) ||
        l.service.toLowerCase().includes(lq),
    );
  }, [serviceFiltered, query]);

  // Auto-scroll while tailing.
  useEffect(() => {
    if (tail && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [filtered.length, tail]);

  return (
    <div className="logs">
      <LogsHeader
        query={query}
        setQuery={setQuery}
        services={stack.services}
        activeServices={activeServices}
        onChipClick={handleChipClick}
        tail={tail}
        setTail={setTail}
      />
      <div className="log-viewport" ref={viewportRef}>
        <LogStream logs={filtered} query={query} />
        {filtered.length === 0 && (
          <div className="empty">
            {query ? `No logs match "${query}"` : 'No logs to show'}
          </div>
        )}
      </div>
    </div>
  );
}
