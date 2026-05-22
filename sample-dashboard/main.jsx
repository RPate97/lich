// main.jsx — Main content (header + metrics + logs)

function MetaItem({ label, value, mono = true }) {
  return (
    <span className="meta">
      <span className="meta-label">{label}</span>
      <span style={{ fontFamily: mono ? "var(--font-mono)" : undefined }}>{value}</span>
    </span>
  );
}

function MainHeader({ stack }) {
  const ageMs = Date.now() - stack.startedAt;
  return (
    <header className="main-hd">
      <div className="main-hd-l">
        <div className="title-row">
          <h1>
            <span className="prefix">⎇ </span>{stack.branch}
          </h1>
        </div>
        <div className="subtitle">
          {stack.agent && (
            <>
              <MetaItem label="agent" value={stack.agent} />
              <span className="sep" />
            </>
          )}
          <MetaItem label="worktree" value={stack.worktree} />
          <span className="sep" />
          <MetaItem label="ports" value={stack.portRange} />
          <span className="sep" />
          <MetaItem label="up" value={fmtRelative(ageMs)} />
          <span className="sep" />
          <MetaItem label="cpu" value={`${stack.cpuPct}%`} />
          <span className="sep" />
          <MetaItem label="mem" value={`${stack.memMb}mb`} />
        </div>
      </div>
      <div className="main-hd-r">
        <button className="btn">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4v8M4 4l3 4-3 4M12 4v8" />
          </svg>
          Restart
        </button>
        <button className="btn">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="5" y="5" width="6" height="6" />
          </svg>
          Stop
        </button>
      </div>
    </header>
  );
}

function StatusPill({ status }) {
  const map = {
    healthy:   { c: "var(--lich-green)",       l: "healthy" },
    unhealthy: { c: "var(--status-unhealthy)", l: "unhealthy" },
    starting:  { c: "var(--status-starting)",  l: "starting" },
  };
  const m = map[status] ?? map.healthy;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      color: m.c, fontSize: 11, fontFamily: "var(--font-mono)",
      padding: "2px 7px",
      background: "color-mix(in oklab, currentColor 10%, transparent)",
      border: "1px solid color-mix(in oklab, currentColor 22%, transparent)",
      borderRadius: 999,
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: 50, background: "currentColor",
        boxShadow: status === "starting" ? "none" : "0 0 6px currentColor",
        animation: status === "starting" ? "pulse 1.2s ease-in-out infinite" : undefined,
      }} />
      {m.l}
    </span>
  );
}

function Metrics({ stack }) {
  const { healthy, unhealthy, total } = summarizeHealth(stack);
  return (
    <div className="metrics">
      <div className="metric">
        <div className="label">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2.5" y="3" width="11" height="3" rx="0.5" />
            <rect x="2.5" y="7" width="11" height="3" rx="0.5" />
            <rect x="2.5" y="11" width="11" height="2" rx="0.5" />
          </svg>
          Services
        </div>
        <div className="value">{total}<span className="unit">running</span></div>
        <div className="hint">{stack.services.map((s) => s.name).join(" · ")}</div>
      </div>
      <div className="metric healthy">
        <div className="label">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8.5 6.5 12 13 4.5" />
          </svg>
          Healthy
        </div>
        <div className="value">{healthy}<span className="unit">/{total}</span></div>
        <div className="hint">
          {healthy === total
            ? "all systems nominal"
            : `${total - healthy} not yet ready`}
        </div>
      </div>
      <div className={`metric unhealthy${unhealthy === 0 ? " zero" : ""}`}>
        <div className="label">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5v3.5M8 11v.01" />
          </svg>
          Unhealthy
        </div>
        <div className="value">{unhealthy}</div>
        <div className="hint">
          {unhealthy === 0 ? "no failing services" : (() => {
            const bad = stack.services.filter((s) => s.status === "unhealthy").map((s) => s.name).join(", ");
            return `${bad} failing`;
          })()}
        </div>
      </div>
    </div>
  );
}

function MainContent({ stack }) {
  const [variant, setVariant] = React.useState("stream");
  // The Logs component reads a variant prop; we pull it from the tweak below
  // via a ref so parent re-renders aren't strictly necessary, but it's simpler
  // to just lift state to App. Wire that up there.
  return null;
}

// Final composed Main — variant is passed in from App
function Main({ stack, logVariant }) {
  return (
    <main className="main">
      <MainHeader stack={stack} />
      <Metrics stack={stack} />
      <Logs stack={stack} variant={logVariant} />
    </main>
  );
}

Object.assign(window, { Main, MainHeader, Metrics });
