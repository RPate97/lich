// Sidebar.tsx — Stack list, brand, footer.
// Ported from sample-dashboard/sidebar.jsx.

import { serviceColor, summarizeHealth, fmtRelative } from '../lib/format';
import type { StackView } from '../../types';

// ---------------------------------------------------------------------------
// Prop interfaces
// ---------------------------------------------------------------------------

interface SidebarProps {
  stacks: StackView[];
  selectedKey: string | undefined;
  onSelect: (key: string) => void;
  newestKey: string | undefined;
  arrivedKeys: Set<string>;
}

interface StackCardProps {
  stack: StackView;
  selected: boolean;
  isNew: boolean;
  justArrived: boolean;
  onSelect: (key: string) => void;
}

// ---------------------------------------------------------------------------
// BrandMark — Lich sigil: hexagonal phylactery rune with a green gem dot.
// ---------------------------------------------------------------------------

function BrandMark() {
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

// ---------------------------------------------------------------------------
// HealthPill — shows up/total with a colored dot.
// ---------------------------------------------------------------------------

function HealthPill({ stack }: { stack: StackView }) {
  const { up, down, total } = summarizeHealth(stack.services);
  const cls = down > 0 ? 'unhealthy' : 'healthy';
  return (
    <span className={`health ${cls}`}>
      <span className="health-dot" />
      {up}/{total}
    </span>
  );
}

// ---------------------------------------------------------------------------
// StackCard
// ---------------------------------------------------------------------------

function StackCard({ stack, selected, isNew, justArrived, onSelect }: StackCardProps) {
  // Derive portRange from the stack's urls (e.g. "http://localhost:3000" → 3000).
  const ports = Object.values(stack.urls)
    .map((u) => {
      try {
        return parseInt(new URL(u).port, 10);
      } catch {
        return NaN;
      }
    })
    .filter((p) => !isNaN(p));
  const portRange = ports.length
    ? `${Math.min(...ports)}-${Math.max(...ports)}`
    : '—';

  const ageMs = Date.now() - new Date(stack.createdAt).getTime();

  return (
    <button
      type="button"
      className={`stack-card${justArrived ? ' arriving' : ''}`}
      data-selected={selected ? '1' : '0'}
      onClick={() => onSelect(stack.key)}
    >
      <div className="stack-row1">
        <span className="branch" title={stack.branch}>
          <span className="prefix">⎇ </span>{stack.branch}
        </span>
        {isNew && <span className="new-badge">new</span>}
      </div>
      <div className="stack-row2">
        {/* agent: always render "manual" — the agent feature is LEV-241 */}
        <span style={{ color: 'var(--subtle-foreground)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          manual
        </span>
        <span className="dot" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          :{portRange}
        </span>
      </div>
      <div className="stack-row3">
        <HealthPill stack={stack} />
        <span title="uptime">{fmtRelative(ageMs)}</span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar({ stacks, selectedKey, onSelect, newestKey, arrivedKeys }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-hd">
        <div className="brand">
          <span className="brand-name"><em>lich</em></span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button className="btn ghost icon-btn" title="New stack" aria-label="New stack">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
      </div>

      <div className="sidebar-sub">
        <span>Stacks</span>
        <span style={{ fontFamily: 'var(--font-mono)', letterSpacing: 0, textTransform: 'none' }}>
          {stacks.length}
        </span>
      </div>

      <div className="stack-list">
        {stacks.map((s) => (
          <StackCard
            key={s.key}
            stack={s}
            selected={s.key === selectedKey}
            isNew={s.key === newestKey}
            justArrived={arrivedKeys.has(s.key)}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div className="sidebar-ft">
        <span className="pulse">
          <span className="pulse-dot" />
          <span>daemon</span>
        </span>
        <span>v0.1.0</span>
      </div>
    </aside>
  );
}
