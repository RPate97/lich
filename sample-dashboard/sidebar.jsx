// sidebar.jsx — Stack list, brand, footer

function BrandMark() {
  // Lich sigil: hexagonal phylactery rune with a green gem dot.
  // Subtle, geometric — not cheesy skull.
  return (
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M10 1.5 L17.4 5.75 L17.4 14.25 L10 18.5 L2.6 14.25 L2.6 5.75 Z"
            stroke="url(#lichg)" strokeWidth="1.4" />
      <path d="M10 5.5 L13.5 7.5 L13.5 11.5 L10 13.5 L6.5 11.5 L6.5 7.5 Z"
            stroke="rgba(167,139,250,.55)" strokeWidth="1" />
      <circle cx="10" cy="9.5" r="1.6" fill="#4ade80" />
      <defs>
        <linearGradient id="lichg" x1="2" y1="2" x2="18" y2="18">
          <stop offset="0" stopColor="#c4b5fd" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function HealthPill({ stack }) {
  const { healthy, unhealthy, total } = summarizeHealth(stack);
  const allUp = healthy === total;
  const cls = unhealthy > 0 ? "unhealthy" : allUp ? "healthy" : "degraded";
  return (
    <span className={`health ${cls}`}>
      <span className="health-dot" />
      {healthy}/{total}
    </span>
  );
}

function StackCard({ stack, selected, isNew, justArrived, onSelect }) {
  const ageMs = Date.now() - stack.startedAt;
  return (
    <button
      type="button"
      className={`stack-card${justArrived ? " arriving" : ""}`}
      data-selected={selected ? "1" : "0"}
      onClick={() => onSelect(stack.id)}
    >
      <div className="stack-row1">
        <span className="branch" title={stack.branch}>
          <span className="prefix">⎇ </span>{stack.branch}
        </span>
        {isNew && <span className="new-badge">new</span>}
      </div>
      <div className="stack-row2">
        {stack.agent ? (
          <span className="agent" title={`agent: ${stack.agent}`}>{stack.agent}</span>
        ) : (
          <span style={{ color: "var(--subtle-foreground)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            manual
          </span>
        )}
        <span className="dot" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
          :{stack.portRange}
        </span>
      </div>
      <div className="stack-row3">
        <HealthPill stack={stack} />
        <span title="uptime">{fmtRelative(ageMs)}</span>
      </div>
    </button>
  );
}

function Sidebar({ stacks, selectedId, onSelect, newestId, arrivedIds }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-hd">
        <div className="brand">
          <span className="brand-name"><em>lich</em></span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button className="btn ghost icon-btn" title="New stack" aria-label="New stack">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
      </div>

      <div className="sidebar-sub">
        <span>Stacks</span>
        <span style={{ fontFamily: "var(--font-mono)", letterSpacing: 0, textTransform: "none" }}>
          {stacks.length}
        </span>
      </div>

      <div className="stack-list">
        {stacks.map((s) => (
          <StackCard
            key={s.id}
            stack={s}
            selected={s.id === selectedId}
            isNew={s.id === newestId}
            justArrived={arrivedIds.has(s.id)}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div className="sidebar-ft">
        <span className="pulse">
          <span className="pulse-dot" />
          <span>daemon</span>
        </span>
        <span>v0.4.2</span>
      </div>
    </aside>
  );
}

Object.assign(window, { Sidebar, BrandMark });
