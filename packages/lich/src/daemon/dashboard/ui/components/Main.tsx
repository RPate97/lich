// Main.tsx — the right-hand pane for a selected stack.
//
// Adapted from the v0 dashboard. v1 differences:
//   - No Metrics widget (CPU/RAM removed per the v1 design's non-goals).
//   - Service rows render the full ServiceState union (`starting | healthy |
//     initializing | ready | stopping | stopped | failed`) instead of v0's
//     four-value health enum.
//   - `primary_url` from the server is surfaced as an "open" button in the
//     header (replaces v0's `urls` map).
//   - Active profile shown in the header subtitle when present.

import { useState } from 'react';
import {
  fmtRelative,
  formatHealthCount,
  formatPortRange,
  serviceColor,
  stateBucket,
  summarizeHealth,
} from '../lib/format';
import { Logs } from './Logs';
import { restartStack, stopStack } from '../api';
import type { ServiceView, StackView } from '../api';

interface MainProps {
  stack: StackView;
}

// ---------------------------------------------------------------------------
// MetaItem — one "label · value" pair in the header subtitle.
// ---------------------------------------------------------------------------

function MetaItem({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <span className="meta">
      <span className="meta-label">{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : undefined }}>{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// MainHeader — title row + subtitle + Restart/Stop buttons.
// ---------------------------------------------------------------------------

function MainHeader({ stack }: { stack: StackView }) {
  const ageMs = stack.started_at
    ? Date.now() - new Date(stack.started_at).getTime()
    : 0;
  const portRange = formatPortRange(stack);

  const [restarting, setRestarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  async function handleRestart() {
    if (!confirm(`Restart stack "${stack.worktree_name}"?`)) return;
    setRestarting(true);
    try {
      const result = await restartStack(stack.id);
      if (!result.ok) {
        alert(
          `Restart failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
        );
      }
    } catch (err) {
      alert(`Restart request failed: ${(err as Error).message}`);
    } finally {
      setRestarting(false);
    }
  }

  async function handleStop() {
    if (!confirm(`Stop stack "${stack.worktree_name}"?`)) return;
    setStopping(true);
    try {
      const result = await stopStack(stack.id);
      if (!result.ok) {
        alert(
          `Stop failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
        );
      }
    } catch (err) {
      alert(`Stop request failed: ${(err as Error).message}`);
    } finally {
      setStopping(false);
    }
  }

  return (
    <header className="main-hd">
      <div className="main-hd-l">
        <div className="title-row">
          <h1>
            <span className="prefix">⎇ </span>
            {stack.worktree_name}
          </h1>
        </div>
        <div className="subtitle">
          <MetaItem label="status" value={stack.status} />
          <span className="sep" />
          {/* When any service has failed, color the health pill red so the
              "N/M services failed" delta is unmissable at a glance. The
              MetaItem still renders the same text — only the .failed class
              changes the color, keeping the failure flag a pure CSS tweak. */}
          <span
            className={
              summarizeHealth(stack.services).failed > 0
                ? 'meta-health failed'
                : 'meta-health'
            }
          >
            <MetaItem label="health" value={formatHealthCount(stack)} />
          </span>
          {stack.active_profile && (
            <>
              <span className="sep" />
              <MetaItem label="profile" value={stack.active_profile} />
            </>
          )}
          <span className="sep" />
          <MetaItem label="ports" value={portRange} />
          {ageMs > 0 && (
            <>
              <span className="sep" />
              <MetaItem label="up" value={fmtRelative(ageMs)} />
            </>
          )}
        </div>
      </div>
      <div className="main-hd-r">
        {stack.primary_url && (
          <a
            className="btn ghost"
            href={stack.primary_url}
            target="_blank"
            rel="noopener noreferrer"
            title={stack.primary_url}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 3H3v10h10v-3" />
              <path d="M9 3h4v4" />
              <path d="M13 3 7 9" />
            </svg>
            open
          </a>
        )}
        <button
          className="btn"
          disabled={restarting || stopping}
          onClick={handleRestart}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <path d="M4 4v8M4 4l3 4-3 4M12 4v8" />
          </svg>
          {restarting ? 'Restart…' : 'Restart'}
        </button>
        <button
          className="btn"
          disabled={stopping || restarting}
          onClick={handleStop}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <rect x="5" y="5" width="6" height="6" />
          </svg>
          {stopping ? 'Stop…' : 'Stop'}
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// ServiceList — per-service rows with state, kind, ports.
//
// LEV-417 (Plan 5 Task 15) extends this to highlight failed services with
// their `failure_reason` + `failure_log_tail`. Failed rows get a red left
// border (via the `.service-row[data-state="failed"]` CSS hook) and an
// expandable detail block below the row.
// ---------------------------------------------------------------------------

function ServiceRow({ service }: { service: ServiceView }) {
  const bucket = stateBucket(service.state);
  const color = serviceColor(service.name);
  const portEntries = service.ports ? Object.entries(service.ports) : [];
  const isFailed = service.state === 'failed';
  // Collapse the log tail by default so a single failed service doesn't
  // dominate the layout. Operators triaging click to reveal the lines that
  // preceded the failure.
  const [logsOpen, setLogsOpen] = useState(false);
  return (
    <div className="service-row-wrap" data-state={service.state}>
      <div
        className="service-row"
        data-state={service.state}
        data-bucket={bucket}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(140px, 1fr) 90px 90px 1fr',
          gap: 12,
          alignItems: 'baseline',
          padding: '8px 24px',
          borderBottom: isFailed ? 'none' : '1px solid var(--border)',
          fontSize: 13,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            color,
            fontWeight: 500,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'currentColor',
              display: 'inline-block',
            }}
          />
          {service.name}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--subtle-foreground)',
          }}
        >
          {service.kind}
        </span>
        <StateBadge state={service.state} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--muted-foreground)',
            wordBreak: 'break-all',
          }}
        >
          {portEntries.length === 0
            ? '—'
            : portEntries.map(([k, v]) => `${k}:${v}`).join('  ')}
        </span>
      </div>
      {isFailed && (
        <FailureDetail
          service={service}
          open={logsOpen}
          onToggle={() => setLogsOpen((v) => !v)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FailureDetail — inline triage panel rendered below a failed service row.
//
// Surfaces:
//   - `failure_reason` (single line; the orchestrator already truncates the
//     underlying message to a sane length in Plan 4's failure formatter)
//   - `failure_log_tail` — collapsed by default; click to expand. Most stacks
//     run clean, so the default-collapsed posture keeps the layout calm. When
//     expanded, the tail renders as a `<pre>` so log whitespace + ANSI-stripped
//     output retain their shape.
//
// Empty `failure_log_tail` arrays (failure detected before any output landed)
// render as "(no log output captured)" rather than disappearing — the caller
// still wants to know "yes, we tried to capture but there was nothing".
// ---------------------------------------------------------------------------

function FailureDetail({
  service,
  open,
  onToggle,
}: {
  service: ServiceView;
  open: boolean;
  onToggle: () => void;
}) {
  const reason = service.failure_reason ?? 'failed (no reason recorded)';
  const tail = service.failure_log_tail;
  const hasTail = tail !== undefined;
  const tailLineCount = tail?.length ?? 0;
  return (
    <div className="failure-detail" role="alert">
      <div className="failure-reason" title={reason}>
        <span className="failure-label">reason</span>
        <span className="failure-reason-text">{reason}</span>
      </div>
      {hasTail && (
        <div className="failure-tail">
          <button
            className="failure-tail-toggle"
            type="button"
            onClick={onToggle}
            aria-expanded={open}
          >
            <span className="failure-tail-caret" data-open={open ? '1' : '0'}>
              ▸
            </span>
            {open ? 'hide log tail' : 'show log tail'}
            <span className="failure-tail-count">
              ({tailLineCount}
              {tailLineCount === 1 ? ' line' : ' lines'})
            </span>
          </button>
          {open && (
            <pre className="failure-tail-body">
              {tailLineCount === 0
                ? '(no log output captured)'
                : tail!.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const bucket = stateBucket(state);
  const tone =
    bucket === 'ok'
      ? { bg: 'rgba(74, 222, 128, 0.12)', fg: 'var(--lich-green-glow)', border: 'rgba(74, 222, 128, 0.25)' }
      : bucket === 'bad'
        ? { bg: 'rgba(248, 113, 113, 0.14)', fg: '#fca5a5', border: 'rgba(248, 113, 113, 0.35)' }
        : bucket === 'idle'
          ? { bg: 'var(--muted)', fg: 'var(--subtle-foreground)', border: 'var(--border)' }
          : { bg: 'rgba(96, 165, 250, 0.12)', fg: '#93c5fd', border: 'rgba(96, 165, 250, 0.25)' };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: '0 8px',
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        letterSpacing: 0.02,
      }}
    >
      {state}
    </span>
  );
}

function ServiceList({ stack }: { stack: StackView }) {
  if (stack.services.length === 0) {
    return (
      <div
        style={{
          padding: '20px 24px',
          color: 'var(--muted-foreground)',
          fontSize: 13,
        }}
      >
        No services declared.
      </div>
    );
  }
  return (
    <section
      style={{
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(140px, 1fr) 90px 90px 1fr',
          gap: 12,
          padding: '10px 24px',
          background: 'var(--card)',
          borderBottom: '1px solid var(--border)',
          fontSize: 10.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--subtle-foreground)',
          fontWeight: 500,
        }}
      >
        <span>Service</span>
        <span>Kind</span>
        <span>State</span>
        <span>Ports</span>
      </div>
      {stack.services.map((svc) => (
        <ServiceRow key={svc.name} service={svc} />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Main({ stack }: MainProps) {
  return (
    <main className="main">
      <MainHeader stack={stack} />
      <ServiceList stack={stack} />
      <Logs stack={stack} />
    </main>
  );
}
