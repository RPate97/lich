// Sidebar.tsx — stack list, brand, footer.
//
// Ported directly from sample-dashboard/sidebar.jsx. Two intentional
// deviations from the sample:
//
//   1. No "+ new stack" button — lich doesn't have a programmatic stack
//      spawn flow yet (the user types `lich up` in a terminal). The brand
//      row is just the wordmark.
//
//   2. Row 2 shows the stack's derived apex proxy host (worktree segment
//      + lich.localhost:port). Falls back to `stack.status` when the stack
//      has no primary_url yet (typical mid-startup).

import {
  fmtRelative,
  formatHealthCount,
  stackHealthBucket,
} from '../lib/format';
import type { StackView } from '../api';

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
// HealthPill — dot + "ready/total" (or "ready/total (N failed)").
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

function StackCard({
  stack,
  selected,
  isNew,
  justArrived,
  onSelect,
}: StackCardProps) {
  const ageMs = stack.started_at
    ? Date.now() - new Date(stack.started_at).getTime()
    : 0;
  // Derive the apex host from proxy_port + worktree_name so we get a
  // value even when no service-level routing entries exist yet. Falls
  // back to status text mid-startup before proxy_port is known.
  const proxyHost =
    stack.proxy_port !== undefined
      ? `${stack.worktree_name}.lich.localhost:${stack.proxy_port}`
      : null;

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
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--subtle-foreground)',
          }}
        >
          {proxyHost ?? stack.status}
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
          <span className="brand-name">lich</span>
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
