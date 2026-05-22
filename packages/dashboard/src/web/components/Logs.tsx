import { useEffect, useMemo, useRef, useState } from 'react';
import { openLogStream } from '../api';
import { serviceColor, fmtClock } from '../lib/format';
import type { LogLine } from '../../types';
import type { StackView, ServiceView } from '../../types';

const MAX_LINES = 800;

const IconSearch = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);

// Highlight a substring (case-insensitive) inside a message.
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  try {
    // user types raw text; escape regex specials
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${esc})`, 'ig'));
    return (
      <>
        {parts.map((p, i) =>
          p.toLowerCase() === query.toLowerCase() ? (
            <mark key={i} className="hl">{p}</mark>
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
        <div key={line.id} className="log-line" data-level={line.level}>
          <span className="ts">{line.ts ? fmtClock(Number(line.ts)) : ''}</span>
          <span className="svc" style={{ color: serviceColor(line.service) }}>{line.service}</span>
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
  tail: boolean;
  setTail: (t: boolean) => void;
}

function LogsHeader({ query, setQuery, services, tail, setTail }: LogsHeaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && (document.activeElement as HTMLElement)?.tagName !== 'INPUT') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
          data-active="1"
          disabled
          title="filtering needs the merged log stream (LEV-244)"
        >
          all
        </button>
        {services.map((svc) => (
          <button
            key={svc.name}
            className="filter-chip"
            data-active="0"
            disabled
            title="filtering needs the merged log stream (LEV-244)"
            style={{ color: serviceColor(svc.name) }}
          >
            <span className="swatch" style={{ background: serviceColor(svc.name) }} />
            {svc.name}
          </button>
        ))}
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
  const viewportRef = useRef<HTMLDivElement>(null);

  // Stream the FIRST service of the stack. Multi-service merge is LEV-244;
  // until then the filter chips are inert and one service is shown.
  const service = stack.services[0]?.name;

  useEffect(() => {
    setLogs([]);
    if (!service) return;
    let n = 0;
    const close = openLogStream(stack.key, service, (e) => {
      setLogs((prev) => {
        const next = [
          ...prev,
          {
            id: `${stack.key}-${service}-${n++}`,
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
  }, [stack.key, service]);

  // Search filter — substring, or /pattern/ for regex (ported from logs.jsx).
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return logs;
    if (q.length >= 2 && q.startsWith('/') && q.endsWith('/')) {
      try {
        const re = new RegExp(q.slice(1, -1), 'i');
        return logs.filter((l) => re.test(l.line) || re.test(l.service));
      } catch {
        return logs;
      }
    }
    const lq = q.toLowerCase();
    return logs.filter(
      (l) => l.line.toLowerCase().includes(lq) || l.service.toLowerCase().includes(lq),
    );
  }, [logs, query]);

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
