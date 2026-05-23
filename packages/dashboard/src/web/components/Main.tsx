import { fmtRelative, summarizeHealth, formatPortRange } from '../lib/format';
import { Logs } from './Logs';
import type { StackView, StackMetrics } from '../../types';

interface MainProps {
  stack: StackView;
  metrics?: StackMetrics;
}

function MetaItem({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="meta">
      <span className="meta-label">{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : undefined }}>{value}</span>
    </span>
  );
}

function MainHeader({ stack, metrics }: { stack: StackView; metrics?: StackMetrics }) {
  const ageMs = Date.now() - new Date(stack.createdAt).getTime();
  const portRange = formatPortRange(stack.ports);
  const cpuValue = metrics?.cpuPct != null ? `${metrics.cpuPct.toFixed(0)}%` : '—';
  const memValue = metrics?.memMB != null ? `${Math.round(metrics.memMB)}mb` : '—';
  return (
    <header className="main-hd">
      <div className="main-hd-l">
        <div className="title-row">
          <h1>
            <span className="prefix">⎇ </span>{stack.branch}
          </h1>
        </div>
        <div className="subtitle">
          <MetaItem label="agent" value={stack.startedBy ?? 'manual'} />
          <span className="sep" />
          <MetaItem label="worktree" value={stack.path} />
          <span className="sep" />
          <MetaItem label="ports" value={portRange} />
          <span className="sep" />
          <MetaItem label="up" value={fmtRelative(ageMs)} />
          <span className="sep" />
          <MetaItem label="cpu" value={cpuValue} />
          <span className="sep" />
          <MetaItem label="mem" value={memValue} />
        </div>
      </div>
      <div className="main-hd-r">
        <button className="btn" disabled title="not yet available">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4v8M4 4l3 4-3 4M12 4v8" />
          </svg>
          Restart
        </button>
        <button className="btn" disabled title="not yet available">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="5" y="5" width="6" height="6" />
          </svg>
          Stop
        </button>
      </div>
    </header>
  );
}

function Metrics({ stack }: { stack: StackView }) {
  const { total } = summarizeHealth(stack.services);
  const healthyCount = stack.services.filter((s) => s.status === 'healthy').length;
  const unhealthyCount = stack.services.filter((s) => s.status === 'unhealthy').length;
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
        <div className="hint">{stack.services.map((s) => s.name).join(' · ')}</div>
      </div>
      <div className="metric healthy">
        <div className="label">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8.5 6.5 12 13 4.5" />
          </svg>
          Healthy
        </div>
        <div className="value">{healthyCount}<span className="unit">/{total}</span></div>
        <div className="hint">
          {healthyCount === total
            ? 'all systems nominal'
            : `${total - healthyCount} not yet ready`}
        </div>
      </div>
      <div className={`metric unhealthy${unhealthyCount === 0 ? ' zero' : ''}`}>
        <div className="label">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5v3.5M8 11v.01" />
          </svg>
          Unhealthy
        </div>
        <div className="value">{unhealthyCount}</div>
        <div className="hint">
          {unhealthyCount === 0
            ? 'no failing services'
            : `${stack.services.filter((s) => s.status === 'unhealthy').map((s) => s.name).join(', ')} failing`}
        </div>
      </div>
    </div>
  );
}

export function Main({ stack, metrics }: MainProps) {
  return (
    <main className="main">
      <MainHeader stack={stack} metrics={metrics} />
      <Metrics stack={stack} />
      <Logs stack={stack} />
    </main>
  );
}
