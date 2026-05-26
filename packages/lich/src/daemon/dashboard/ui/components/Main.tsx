// Main.tsx — right pane: header + services strip + logs.
//
// Ported directly from sample-dashboard/main.jsx with three intentional
// deviations:
//
//   1. No CPU/MEM in the header meta — lich doesn't collect process
//      metrics yet (and the daemon would need a sampler to do so).
//
//   2. No Metrics cards row — the sample's `Metrics` component is
//      orphaned (defined but not rendered in its `Main`); the design
//      intent is header → services strip → logs.
//
//   3. FailureDetail is rendered below failed service rows — the sample's
//      mockup never has a failed service, but real stacks do, and the
//      reason + log tail are critical triage signals.

import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  fmtRelative,
  formatHealthCount,
  formatPortRange,
  primaryPort,
  serviceStatus,
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
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : undefined }}>
        {value}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// MainHeader — title + meta subtitle + Open / Restart / Stop actions.
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
          {stack.worktree_path && (
            <>
              <MetaItem label="worktree" value={stack.worktree_path} />
              <span className="sep" />
            </>
          )}
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
// ServicesStrip — multi-column compact grid: one row per service with
// status dot, name, derived proxy host, port, and copy-URL button.
//
// Failed services get a FailureDetail panel rendered below the row with
// failure_reason + collapsible failure_log_tail. (Sample doesn't have this
// — its mockup never fails.)
// ---------------------------------------------------------------------------

function ServicesStrip({ stack }: { stack: StackView }) {
  if (stack.services.length === 0) {
    return (
      <div
        style={{
          padding: '20px 24px',
          color: 'var(--muted-foreground)',
          fontSize: 13,
          borderBottom: '1px solid var(--border)',
        }}
      >
        No services declared.
      </div>
    );
  }
  return (
    <>
      <div className="svc-strip">
        {stack.services.map((svc) => (
          <ServiceRow key={svc.name} service={svc} />
        ))}
      </div>
      {stack.services
        .filter((s) => s.state === 'failed')
        .map((svc) => (
          <FailureDetail key={`fail-${svc.name}`} service={svc} />
        ))}
    </>
  );
}

function ServiceRow({ service }: { service: ServiceView }) {
  const status = serviceStatus(service.state);
  const url = service.url;
  // Display the URL without the protocol prefix — the row IS the link,
  // the `http://` is noise once that's understood.
  const host = url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const port = primaryPort(service);

  const [copied, setCopied] = useState(false);
  async function copy(e: ReactMouseEvent) {
    // Stop the click from bubbling to the row's <a> wrapper — otherwise
    // copying the URL also opens it.
    e.preventDefault();
    e.stopPropagation();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard write blocked — silent */
    }
  }

  // Row content shared between the clickable-link variant (when we have
  // a URL) and the inert variant (when we don't — e.g. starting / stopped
  // / no routing yet). Keeps the visual layout identical in both modes.
  const content = (
    <>
      <span className={`svc-dot ${status}`} />
      <span className="svc-name">{service.name}</span>
      <span className="svc-host">{host ?? service.state}</span>
      {port != null && <span className="svc-port">:{port}</span>}
    </>
  );

  if (host && url) {
    return (
      <a
        className="svc-row"
        data-status={status}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${url}`}
      >
        {content}
        <button
          className="svc-copy"
          onClick={copy}
          title="Copy URL"
          aria-label={`Copy ${host}`}
        >
          {copied ? (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 8.5 6.5 12 13 4.5" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="5" y="5" width="8" height="8" rx="1.2" />
              <path d="M3 11V3.5C3 3.22 3.22 3 3.5 3H11" />
            </svg>
          )}
        </button>
      </a>
    );
  }

  return (
    <div className="svc-row" data-status={status} data-inert="1">
      {content}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FailureDetail — inline triage panel for a failed service. Surfaces
// failure_reason + a collapsible failure_log_tail. Default-collapsed so
// healthy stacks stay calm.
// ---------------------------------------------------------------------------

function FailureDetail({ service }: { service: ServiceView }) {
  const reason = service.failure_reason ?? 'failed (no reason recorded)';
  const tail = service.failure_log_tail;
  const hasTail = tail !== undefined;
  const tailLineCount = tail?.length ?? 0;
  const [open, setOpen] = useState(false);

  return (
    <div className="failure-detail" role="alert">
      <div className="failure-reason" title={reason}>
        <span className="failure-label">{service.name} · reason</span>
        <span className="failure-reason-text">{reason}</span>
      </div>
      {hasTail && (
        <div className="failure-tail">
          <button
            className="failure-tail-toggle"
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <span
              className="failure-tail-caret"
              data-open={open ? '1' : '0'}
            >
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Main({ stack }: MainProps) {
  return (
    <main className="main">
      <MainHeader stack={stack} />
      <ServicesStrip stack={stack} />
      <Logs stack={stack} />
    </main>
  );
}
