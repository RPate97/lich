// Sidebar.tsx — stack list, brand, footer.
//
// Adapted from the v0 dashboard. The v1 wire shape uses `id` / `worktree_name`
// instead of `key` / `branch`, and the HealthPill computes ready/total/failed
// off the v1 ServiceState union (see lib/format.ts `summarizeHealth`).

import {
  formatHealthCount,
  formatPortRange,
  fmtRelative,
  stackHealthBucket,
} from '../lib/format';
import type { StackView } from '../api';

// ---------------------------------------------------------------------------
// Prop interfaces
// ---------------------------------------------------------------------------

interface SidebarProps {
  stacks: StackView[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  newestId: string | undefined;
  arrivedIds: Set<string>;
}

interface StackCardProps {
  stack: StackView;
  selected: boolean;
  isNew: boolean;
  justArrived: boolean;
  onSelect: (id: string) => void;
}

// ---------------------------------------------------------------------------
// BrandMark — Lich sigil: hexagonal phylactery rune with a green gem dot.
// ---------------------------------------------------------------------------

function BrandMark() {
  return (
    <svg viewBox="0 0 20 20" fill="none">
      <path
        d="M10 1.5 L17.4 5.75 L17.4 14.25 L10 18.5 L2.6 14.25 L2.6 5.75 Z"
        stroke="url(#lichg)"
        strokeWidth="1.4"
      />
      <path
        d="M10 5.5 L13.5 7.5 L13.5 11.5 L10 13.5 L6.5 11.5 L6.5 7.5 Z"
        stroke="rgba(167,139,250,.55)"
        strokeWidth="1"
      />
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
// HealthPill — shows "ready/total" (or "ready/total (N failed)").
// ---------------------------------------------------------------------------

function HealthPill({ stack }: { stack: StackView }) {
  const bucket = stackHealthBucket(stack);
  return (
    <span className={`health ${bucket}`}>
      <span className="health-dot" />
      {formatHealthCount(stack)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// StackCard
// ---------------------------------------------------------------------------

function StackCard({ stack, selected, isNew, justArrived, onSelect }: StackCardProps) {
  const portRange = formatPortRange(stack);
  const ageMs = stack.started_at
    ? Date.now() - new Date(stack.started_at).getTime()
    : 0;

  return (
    <button
      type="button"
      className={`stack-card${justArrived ? ' arriving' : ''}`}
      data-selected={selected ? '1' : '0'}
      onClick={() => onSelect(stack.id)}
    >
      <div className="stack-row1">
        <span className="branch" title={stack.worktree_name}>
          <span className="prefix">⎇ </span>
          {stack.worktree_name}
        </span>
        {isNew && <span className="new-badge">new</span>}
      </div>
      <div className="stack-row2">
        {stack.active_profile ? (
          <span
            style={{
              color: 'var(--subtle-foreground)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
            }}
            title={`profile: ${stack.active_profile}`}
          >
            {stack.active_profile}
          </span>
        ) : (
          <span
            style={{
              color: 'var(--subtle-foreground)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
            }}
          >
            {stack.status}
          </span>
        )}
        <span className="dot" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          :{portRange}
        </span>
      </div>
      <div className="stack-row3">
        <HealthPill stack={stack} />
        <span title="uptime">{ageMs > 0 ? fmtRelative(ageMs) : '—'}</span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar({
  stacks,
  selectedId,
  onSelect,
  newestId,
  arrivedIds,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-hd">
        <div className="brand">
          <span className="brand-mark">
            <BrandMark />
          </span>
          <span className="brand-name">
            <em>lich</em>
          </span>
        </div>
      </div>

      <div className="sidebar-sub">
        <span>Stacks</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            letterSpacing: 0,
            textTransform: 'none',
          }}
        >
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
        {stacks.length === 0 && (
          <div
            style={{
              padding: '24px 16px',
              fontSize: 12,
              color: 'var(--muted-foreground)',
              textAlign: 'center',
            }}
          >
            No stacks yet.
            <br />
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                color: 'var(--lich-purple-glow)',
              }}
            >
              lich up
            </code>{' '}
            to start one.
          </div>
        )}
      </div>

      <div className="sidebar-ft">
        <span className="pulse">
          <span className="pulse-dot" />
          <span>daemon</span>
        </span>
        <span>v1</span>
      </div>
    </aside>
  );
}
