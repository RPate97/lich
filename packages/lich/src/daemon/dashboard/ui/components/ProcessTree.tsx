import { useEffect, useState } from 'react';
import { fetchProcessTree, type ProcessTreeNode, type ProcessTreeResponse } from '../api';
import { formatBytes, formatCpuPct } from '../lib/metrics';
import { Sparkline } from './Sparkline';

interface Props {
  stackId: string;
  service: string;
  cpuHistory: number[];
  memHistory: number[];
}

/** Polls /api/stacks/<id>/services/<svc>/proc-tree on a 3s cadence while expanded.
 *  Faster than the 4s metrics ring but slower than the SSE so the daemon isn't
 *  walking ps twice for the same data. */
const POLL_MS = 3000;

export function ProcessTreeDetail({
  stackId,
  service,
  cpuHistory,
  memHistory,
}: Props) {
  const [tree, setTree] = useState<ProcessTreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const tick = async (): Promise<void> => {
      try {
        const res = await fetchProcessTree(stackId, service);
        if (cancelled) return;
        if (res === null) {
          setError('service has no process tree (not running or compose-only)');
          setTree(null);
        } else {
          setTree(res);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stackId, service]);

  return (
    <div className="proc-tree" role="region" aria-label={`${service} process tree`}>
      <div className="proc-tree-hd">
        <span className="proc-tree-label">
          process tree · <span className="proc-tree-svc">{service}</span>
        </span>
        {tree && (
          <span className="proc-tree-stats">
            {tree.process_count} {tree.process_count === 1 ? 'proc' : 'procs'}
            <span className="sep" />
            {formatBytes(tree.mem_bytes)}
            <span className="sep" />
            {formatCpuPct(tree.cpu_pct_cumulative)} cumul
          </span>
        )}
      </div>
      <div className="proc-tree-sparks">
        <div className="proc-tree-spark">
          <span className="proc-tree-spark-label">cpu (60s)</span>
          <Sparkline
            values={cpuHistory}
            color="var(--status-warning)"
            width={120}
            height={20}
            title="cpu% over last 60s"
          />
        </div>
        <div className="proc-tree-spark">
          <span className="proc-tree-spark-label">mem (60s)</span>
          <Sparkline
            values={memHistory}
            color="var(--lich-purple-glow)"
            width={120}
            height={20}
            title="memory over last 60s"
          />
        </div>
      </div>
      {loading && !tree && (
        <div className="proc-tree-empty">loading process tree…</div>
      )}
      {error && (
        <div className="proc-tree-error">
          could not load process tree: <code>{error}</code>
        </div>
      )}
      {tree && tree.tree && (
        <div className="proc-tree-body">
          <TreeNode node={tree.tree} depth={0} />
        </div>
      )}
      {tree && !tree.tree && !error && (
        <div className="proc-tree-empty">
          process not currently in ps snapshot
        </div>
      )}
    </div>
  );
}

function TreeNode({ node, depth }: { node: ProcessTreeNode; depth: number }) {
  return (
    <div className="proc-node" style={{ paddingLeft: depth * 16 }}>
      <span className="proc-bullet">{depth === 0 ? '●' : '└'}</span>
      <span className="proc-pid">pid {node.pid}</span>
      <span className="proc-cpu">{formatCpuPct(node.cpu_pct_cumulative)}</span>
      <span className="proc-mem">{formatBytes(node.rss_bytes)}</span>
      {node.children.length > 0 && (
        <div className="proc-children">
          {node.children.map((c) => (
            <TreeNode key={c.pid} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
