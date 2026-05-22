// logs.jsx — log viewer + 3 variants (stream / table / grouped)

const IconSearch = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);

// Highlight a substring (case-insensitive) inside a message.
function Highlighted({ text, query }) {
  if (!query) return text;
  try {
    // user types raw text; escape regex specials
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${esc})`, "ig"));
    return parts.map((p, i) =>
      p.toLowerCase() === query.toLowerCase()
        ? <mark key={i} className="hl">{p}</mark>
        : <React.Fragment key={i}>{p}</React.Fragment>
    );
  } catch {
    return text;
  }
}

function LogLevel({ level }) {
  return <span className={`lvl lvl-${level}`}>{level}</span>;
}

// ── Stream view (default) ────────────────────────────────────────────────────

function LogStream({ logs, query, services }) {
  const svcMap = React.useMemo(
    () => Object.fromEntries(services.map((s) => [s.id, s])),
    [services]
  );
  return (
    <div className="log-stream">
      {logs.map((line) => {
        const svc = svcMap[line.svc];
        return (
          <div key={line.id} className="log-line" data-level={line.level}>
            <span className="ts">{fmtClock(line.ts)}</span>
            <span className="svc" style={{ color: svc?.color }}>{line.svc}</span>
            <span className="msg">
              <LogLevel level={line.level} />
              <Highlighted text={line.message} query={query} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Table view ──────────────────────────────────────────────────────────────

function LogTable({ logs, query, services }) {
  const svcMap = React.useMemo(
    () => Object.fromEntries(services.map((s) => [s.id, s])),
    [services]
  );
  return (
    <table className="log-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Service</th>
          <th>Level</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((line) => {
          const svc = svcMap[line.svc];
          return (
            <tr key={line.id} data-level={line.level}>
              <td className="col-ts">{fmtClock(line.ts)}</td>
              <td className="col-svc">
                <span className="svc" style={{ color: svc?.color }}>{line.svc}</span>
              </td>
              <td className="col-lvl"><LogLevel level={line.level} /></td>
              <td className="col-msg">
                <Highlighted text={line.message} query={query} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Grouped view ────────────────────────────────────────────────────────────

function LogGrouped({ logs, query, services }) {
  const buckets = React.useMemo(() => {
    const m = new Map(services.map((s) => [s.id, []]));
    for (const line of logs) {
      const arr = m.get(line.svc);
      if (arr) arr.push(line);
    }
    return m;
  }, [logs, services]);

  return (
    <div className="log-groups">
      {services.map((svc) => {
        const lines = buckets.get(svc.id) || [];
        const tail = lines.slice(-60);
        return (
          <section key={svc.id} className="log-group">
            <header className="log-group-hd">
              <span className="svc-name" style={{ color: svc.color }}>{svc.name}</span>
              <span className="meta">:{svc.port} · {lines.length} lines</span>
            </header>
            <div className="log-group-body">
              {tail.map((line) => (
                <div key={line.id} className="grp-line" data-level={line.level}>
                  <span className="ts">{fmtClock(line.ts)}</span>
                  <span className="msg">
                    {line.level !== "info" && <LogLevel level={line.level} />}
                    <Highlighted text={line.message} query={query} />
                  </span>
                </div>
              ))}
              {tail.length === 0 && (
                <div className="grp-line">
                  <span />
                  <span style={{ color: "var(--subtle-foreground)" }}>no recent logs</span>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Header bar (search + filters + tail toggle) ─────────────────────────────

function LogsHeader({
  query, setQuery,
  services,
  activeSvcs, toggleSvc, clearSvcs,
  tail, setTail,
  variant,
}) {
  const inputRef = React.useRef(null);
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const allActive = activeSvcs.size === 0;
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
          data-active={allActive ? "1" : "0"}
          onClick={clearSvcs}
        >
          all
        </button>
        {services.map((svc) => (
          <button
            key={svc.id}
            className="filter-chip"
            data-active={activeSvcs.has(svc.id) ? "1" : "0"}
            onClick={() => toggleSvc(svc.id)}
            style={{ color: activeSvcs.has(svc.id) ? svc.color : undefined }}
          >
            <span className="swatch" style={{ background: svc.color }} />
            {svc.name}
          </button>
        ))}
      </div>

      <div className="log-toolbar">
        <button
          className="tail-toggle"
          data-on={tail ? "1" : "0"}
          onClick={() => setTail(!tail)}
          title={tail ? "Pause live tail" : "Resume live tail"}
        >
          <span className="tail-dot" />
          {tail ? "tailing" : "paused"}
        </button>
      </div>
    </div>
  );
}

// ── Combined Logs component ─────────────────────────────────────────────────

function Logs({ stack, variant }) {
  const [query, setQuery] = React.useState("");
  const [activeSvcs, setActiveSvcs] = React.useState(() => new Set());
  const [tail, setTail] = React.useState(true);
  const viewportRef = React.useRef(null);

  // Re-generate logs when stack changes
  const baseLogs = React.useMemo(() => makeLogs(stack, 240), [stack.id]);
  const [logs, setLogs] = React.useState(baseLogs);

  React.useEffect(() => {
    setLogs(baseLogs);
  }, [baseLogs]);

  // Live tail: append a new log line periodically
  React.useEffect(() => {
    if (!tail) return;
    let counter = 0;
    const tick = () => {
      const svc = stack.services[Math.floor(Math.random() * stack.services.length)];
      const pool = (window.LOG_CORPUS_REF ?? null) ||
        // inline minimal pool fallback
        [
          { lvl: "info", msg: "→ GET /v1/health 200 in 2ms" },
          { lvl: "debug", msg: "→ tick: queue depth=3" },
        ];
      // we actually have access to data.jsx's LOG_CORPUS via re-using makeLogs?
      // Easier: synthesize one entry via makeLogs trick: just pick a random line.
      const entry = {
        id: `live-${Date.now()}-${counter++}`,
        ts: Date.now(),
        svc: svc.id,
        svcColor: svc.color,
        level: ["info","info","info","debug","warn","error"][Math.floor(Math.random()*6)],
        message: synthLine(svc.id),
      };
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > 800 ? next.slice(-800) : next;
      });
    };
    const id = setInterval(tick, 850 + Math.random() * 1200);
    return () => clearInterval(id);
  }, [tail, stack.id]);

  // Filter + search
  const filtered = React.useMemo(() => {
    const svcFilter = activeSvcs.size === 0
      ? () => true
      : (l) => activeSvcs.has(l.svc);
    let q = query.trim();
    let queryFn;
    if (q.length >= 2 && q.startsWith("/") && q.endsWith("/")) {
      try {
        const re = new RegExp(q.slice(1, -1), "i");
        queryFn = (l) => re.test(l.message) || re.test(l.svc);
      } catch { queryFn = () => true; }
    } else if (q.length > 0) {
      const lq = q.toLowerCase();
      queryFn = (l) => l.message.toLowerCase().includes(lq) || l.svc.toLowerCase().includes(lq);
    } else {
      queryFn = () => true;
    }
    return logs.filter((l) => svcFilter(l) && queryFn(l));
  }, [logs, activeSvcs, query]);

  // Auto-scroll on tail
  React.useEffect(() => {
    if (!tail || !viewportRef.current) return;
    const el = viewportRef.current;
    el.scrollTop = el.scrollHeight;
  }, [filtered.length, tail, variant]);

  const toggleSvc = React.useCallback((id) => {
    setActiveSvcs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clearSvcs = React.useCallback(() => setActiveSvcs(new Set()), []);

  return (
    <div className="logs">
      <LogsHeader
        query={query}
        setQuery={setQuery}
        services={stack.services}
        activeSvcs={activeSvcs}
        toggleSvc={toggleSvc}
        clearSvcs={clearSvcs}
        tail={tail}
        setTail={setTail}
        variant={variant}
      />
      <div className="log-viewport" ref={viewportRef}>
        {variant === "table"   && <LogTable    logs={filtered} query={query} services={stack.services} />}
        {variant === "grouped" && <LogGrouped  logs={filtered} query={query} services={stack.services} />}
        {(variant === "stream" || !variant) && <LogStream logs={filtered} query={query} services={stack.services} />}
        {filtered.length === 0 && (
          <div className="empty">
            {query ? `No logs match "${query}"` : "No logs to show"}
          </div>
        )}
      </div>
    </div>
  );
}

// Lightweight line synthesizer for the live tail — kept here so logs.jsx
// stays self-sufficient without reaching back into data.jsx every tick.
const __SYNTH = {
  postgres: [
    "LOG:  duration: 4.318 ms  statement: SELECT count(*) FROM jobs",
    "LOG:  autovacuum: VACUUM ANALYZE public.sessions",
    "LOG:  checkpoint starting: time",
  ],
  redis: [
    '"GET" "session:0e9a…"',
    '"SETEX" "rate:user:88" "60" "1"',
    "Background saving terminated with success",
  ],
  temporal: [
    "Polling task queue 'billing' (long-poll 60s)",
    "ActivityTaskScheduled: chargeCustomer attempt=1",
    "WorkflowExecutionCompleted: BillingCycleWorkflow run_id=4f1b…",
  ],
  api: [
    "→ GET /v1/threads/82f9/messages 200 in 19ms",
    "→ POST /v1/auth/session 201 in 138ms",
    "→ GET /v1/health 200 in 2ms",
    "auth: verified bearer for user_id=142",
  ],
  workers: [
    "worker[1] picked up job: embed-document id=doc_9f2c",
    "worker[1] job complete: embed-document in 2.84s",
    "worker[3] queue depth: pending=12 in-flight=2",
  ],
  web: [
    "GET /dashboard 200 in 12ms",
    "GET /_next/static/chunks/page.js 200 in 3ms",
    "hmr: 1 module updated in 64ms",
  ],
};
function synthLine(svcId) {
  const pool = __SYNTH[svcId] || __SYNTH.api;
  return pool[Math.floor(Math.random() * pool.length)];
}

Object.assign(window, { Logs });
