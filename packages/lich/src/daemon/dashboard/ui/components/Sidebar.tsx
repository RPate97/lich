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

function HealthPill({ stack }: { stack: StackView }) {
  const bucket = stackHealthBucket(stack);
  return (
    <span className={`health ${bucket}`}>
      <span className="health-dot" />
      {formatHealthCount(stack)}
    </span>
  );
}

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
  // derived from proxy_port + worktree_name so it works before any
  // service-level routing entry exists
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
