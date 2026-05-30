import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  fmtRelative,
  formatHealthCount,
  formatPortRange,
  primaryPort,
  serviceStatus,
  summarizeHealth,
} from '../lib/format';
import {
  cpuLoad,
  formatBytes,
  formatCpuPct,
  memLoad,
} from '../lib/metrics';
import { Logs } from './Logs';
import { Sparkline } from './Sparkline';
import { ProcessTreeDetail } from './ProcessTree';
import { restartStack, stopStack } from '../api';
import {
  findServiceMetrics,
  useStackMetrics,
  type StackMetricsState,
} from '../hooks/useStackMetrics';
import type { ServiceMetrics, ServiceView, StackView } from '../api';

interface MainProps {
  stack: StackView;
}

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

function MainHeader({
  stack,
  metrics,
}: {
  stack: StackView;
  metrics: StackMetricsState;
}) {
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

  const totalCpu = metrics.latest?.total.cpu_pct ?? 0;
  const totalMem = metrics.latest?.total.mem_bytes ?? 0;
  const cpuKind = cpuLoad(totalCpu);

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
          <span className="sep" />
          <span className="meta meta-metric">
            <span className="meta-label">cpu</span>
            <span className={`metric-value load-${cpuKind}`}>
              {formatCpuPct(totalCpu)}
            </span>
          </span>
          <span className="meta meta-metric">
            <span className="meta-label">mem</span>
            <span className="metric-value">{formatBytes(totalMem)}</span>
            <Sparkline
              values={metrics.totalMemBytes}
              width={64}
              height={18}
              title={`stack memory: ${formatBytes(totalMem)} (last 60s)`}
            />
          </span>
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

function ServicesStrip({
  stack,
  metrics,
}: {
  stack: StackView;
  metrics: StackMetricsState;
}) {
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
          <ServiceRow
            key={svc.name}
            stackId={stack.id}
            service={svc}
            metric={findServiceMetrics(metrics.latest, svc.name)}
            memHistory={metrics.memBytesByService[svc.name] ?? []}
            cpuHistory={metrics.cpuPctByService[svc.name] ?? []}
          />
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

interface ServiceRowProps {
  stackId: string;
  service: ServiceView;
  metric: ServiceMetrics | undefined;
  memHistory: number[];
  cpuHistory: number[];
}

function ServiceRow({
  stackId,
  service,
  metric,
  memHistory,
  cpuHistory,
}: ServiceRowProps) {
  const status = serviceStatus(service.state);
  const url = service.url;
  const host = url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const port = primaryPort(service);

  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function copy(e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  const canExpand = metric?.kind === 'owned';
  function toggleExpand(e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (canExpand) setExpanded((v) => !v);
  }

  const cpuPct = metric?.cpu_pct ?? 0;
  const memBytes = metric?.mem_bytes ?? 0;
  const memLimit =
    metric?.kind === 'compose' ? metric.mem_limit_bytes : undefined;
  const procCount =
    metric?.kind === 'owned' ? metric.process_count : undefined;
  const cpuKind = cpuLoad(cpuPct);
  const memKind = memLoad(memBytes, memLimit);

  const metricsBlock = metric ? (
    <>
      <span
        className={`svc-metric svc-cpu load-${cpuKind}`}
        title={`CPU: ${formatCpuPct(cpuPct)}`}
      >
        {formatCpuPct(cpuPct)}
      </span>
      <span
        className={`svc-metric svc-mem load-${memKind}`}
        title={
          memLimit
            ? `Memory: ${formatBytes(memBytes)} / ${formatBytes(memLimit)}`
            : `Memory: ${formatBytes(memBytes)}`
        }
      >
        {formatBytes(memBytes)}
        {memLimit ? (
          <span className="svc-mem-limit"> / {formatBytes(memLimit)}</span>
        ) : null}
      </span>
      <Sparkline
        values={memHistory}
        width={56}
        height={16}
        title={`memory (last 60s): ${memHistory.length} samples`}
      />
    </>
  ) : (
    <span className="svc-metric svc-metric-pending" title="awaiting first sample">
      …
    </span>
  );

  const expandToggle = canExpand ? (
    <button
      className="svc-tree-toggle"
      type="button"
      onClick={toggleExpand}
      title={expanded ? 'Hide process tree' : 'Show process tree'}
      aria-expanded={expanded}
      aria-label={
        expanded
          ? `Hide process tree for ${service.name}`
          : `Show process tree for ${service.name}`
      }
    >
      <span className="svc-tree-caret" data-open={expanded ? '1' : '0'}>
        ▸
      </span>
      {procCount !== undefined && procCount > 1 ? (
        <span className="svc-proc-count">{procCount}</span>
      ) : null}
    </button>
  ) : null;

  const content = (
    <>
      <span className={`svc-dot ${status}`} />
      <span className="svc-name">{service.name}</span>
      <span className="svc-host">{host ?? service.state}</span>
      {port != null && <span className="svc-port">:{port}</span>}
      <span className="svc-metrics-group">{metricsBlock}</span>
      {expandToggle}
    </>
  );

  let rowEl: JSX.Element;
  if (host && url) {
    rowEl = (
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
  } else {
    rowEl = (
      <div className="svc-row" data-status={status} data-inert="1">
        {content}
      </div>
    );
  }

  return (
    <div className="svc-row-wrap">
      {rowEl}
      {expanded && canExpand && (
        <ProcessTreeDetail
          stackId={stackId}
          service={service.name}
          cpuHistory={cpuHistory}
          memHistory={memHistory}
        />
      )}
    </div>
  );
}

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

export function Main({ stack }: MainProps) {
  const metrics = useStackMetrics(stack.id);
  return (
    <main className="main">
      <MainHeader stack={stack} metrics={metrics} />
      <ServicesStrip stack={stack} metrics={metrics} />
      <Logs stack={stack} />
    </main>
  );
}
