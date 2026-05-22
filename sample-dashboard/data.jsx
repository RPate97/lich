// data.jsx — mock stacks, services, log streams
// Realistic data for a Lich dashboard prototype.

// ── Service archetypes ──────────────────────────────────────────────────────

const SERVICE_DEFS = [
  { id: "postgres",  name: "postgres",  kind: "db",    color: "#60a5fa" },
  { id: "redis",     name: "redis",     kind: "cache", color: "#f87171" },
  { id: "temporal",  name: "temporal",  kind: "queue", color: "#fbbf24" },
  { id: "api",       name: "api",       kind: "svc",   color: "#a78bfa" },
  { id: "workers",   name: "workers",   kind: "svc",   color: "#4ade80" },
  { id: "web",       name: "web",       kind: "svc",   color: "#22d3ee" },
];

// ── Fake branch / agent material ────────────────────────────────────────────

const BRANCHES = [
  "feat/onboarding-revamp",
  "fix/checkout-race-condition",
  "perf/db-query-indexes",
  "spike/realtime-cursor-presence",
  "refactor/billing-state-machine",
  "feat/agent-tool-loop",
  "fix/temporal-worker-restart",
  "feat/multi-tenant-rbac",
  "chore/upgrade-postgres-16",
  "feat/llm-streaming-tokens",
];

// Lich-themed agent names (undead wizard energy, but readable)
const AGENTS = [
  "wraith", "mort", "ash", "vex", "shade", "necro", "rune", "tomb",
];

// ── Log message corpus per service ──────────────────────────────────────────

const LOG_CORPUS = {
  postgres: [
    { lvl: "info",  msg: "LOG:  database system is ready to accept connections" },
    { lvl: "info",  msg: "LOG:  checkpoint starting: time" },
    { lvl: "info",  msg: "LOG:  checkpoint complete: wrote 142 buffers (0.9%); 0 WAL file(s)" },
    { lvl: "info",  msg: "LOG:  autovacuum: VACUUM ANALYZE public.users" },
    { lvl: "debug", msg: "LOG:  statement: SELECT id, email FROM users WHERE workspace_id = $1 LIMIT 50" },
    { lvl: "debug", msg: "LOG:  statement: UPDATE sessions SET last_seen = now() WHERE token = $1" },
    { lvl: "warn",  msg: "WARNING:  there is no transaction in progress" },
    { lvl: "info",  msg: "LOG:  duration: 12.418 ms  statement: SELECT * FROM jobs ORDER BY enqueued_at DESC LIMIT 100" },
  ],
  redis: [
    { lvl: "info",  msg: "Ready to accept connections tcp" },
    { lvl: "debug", msg: '"GET" "session:8a3f2c…"' },
    { lvl: "debug", msg: '"SETEX" "rate:user:142" "60" "1"' },
    { lvl: "info",  msg: "Background saving started by pid 41" },
    { lvl: "info",  msg: "DB saved on disk" },
    { lvl: "debug", msg: '"PUBLISH" "presence:room-9" "{\\"user\\":42,\\"state\\":\\"online\\"}"' },
    { lvl: "warn",  msg: "Connected slave instance disconnected" },
  ],
  temporal: [
    { lvl: "info",  msg: "Started Worker {Namespace=default TaskQueue=billing}" },
    { lvl: "info",  msg: "WorkflowExecutionStarted: BillingCycleWorkflow run_id=8e3a…" },
    { lvl: "debug", msg: "ActivityTaskScheduled: chargeCustomer attempt=1" },
    { lvl: "info",  msg: "ActivityTaskCompleted: chargeCustomer in 1.214s" },
    { lvl: "warn",  msg: "ActivityTaskFailed: sendInvoiceEmail — will retry in 5s" },
    { lvl: "info",  msg: "WorkflowExecutionCompleted: BillingCycleWorkflow run_id=8e3a…" },
    { lvl: "debug", msg: "Polling task queue 'billing' (long-poll 60s)" },
  ],
  api: [
    { lvl: "info",  msg: "→ GET /v1/workspaces/acme/projects 200 in 18ms" },
    { lvl: "info",  msg: "→ POST /v1/auth/session 201 in 142ms" },
    { lvl: "debug", msg: "auth: verified bearer for user_id=142 (workspace=acme)" },
    { lvl: "info",  msg: "→ GET /v1/threads/82f9/messages 200 in 24ms" },
    { lvl: "warn",  msg: "rate-limit: 142 req/min from ip=10.0.4.18 — soft warn" },
    { lvl: "error", msg: "→ POST /v1/threads/82f9/messages 500 in 312ms — TypeError: cannot read properties of undefined (reading 'tokens')" },
    { lvl: "info",  msg: "graceful shutdown: SIGTERM not received, continuing" },
    { lvl: "info",  msg: "→ GET /v1/health 200 in 2ms" },
    { lvl: "debug", msg: "feature flag 'streaming_tokens' = true for workspace=acme" },
  ],
  workers: [
    { lvl: "info",  msg: "worker[1] picked up job: embed-document id=doc_8a3f" },
    { lvl: "debug", msg: "worker[1] embedding chunk 4/12 (1024 tokens)" },
    { lvl: "info",  msg: "worker[1] job complete: embed-document in 3.21s" },
    { lvl: "info",  msg: "worker[2] picked up job: send-digest workspace=acme" },
    { lvl: "warn",  msg: "worker[2] retry 1/3: smtp connection refused" },
    { lvl: "error", msg: "worker[2] FAILED: send-digest — Error: SMTP connection timeout after 30000ms" },
    { lvl: "debug", msg: "worker[3] queue depth: pending=14 in-flight=2 failed=1" },
  ],
  web: [
    { lvl: "info",  msg: "▲ Next.js 15.2.0 — compiled successfully in 412ms" },
    { lvl: "info",  msg: "GET /dashboard 200 in 14ms" },
    { lvl: "info",  msg: "GET /_next/static/chunks/page.js 200 in 3ms" },
    { lvl: "debug", msg: "hmr: 2 modules updated in 89ms" },
    { lvl: "info",  msg: "GET /api/me 200 in 22ms" },
    { lvl: "warn",  msg: "Hydration mismatch warning suppressed in dev" },
    { lvl: "info",  msg: "GET /workspaces/acme 200 in 31ms" },
  ],
};

// ── Stack generator ─────────────────────────────────────────────────────────

const NOW = Date.now();

function pick(arr, i) { return arr[i % arr.length]; }

function buildServices(stackIdx, basePort) {
  return SERVICE_DEFS.map((def, i) => {
    // unhealthy on the *third* stack's workers, to show off the unhealthy state
    let status = "healthy";
    if (stackIdx === 2 && def.id === "workers") status = "unhealthy";
    if (stackIdx === 1 && def.id === "temporal") status = "starting";
    return {
      ...def,
      port: basePort + i,
      url: `http://localhost:${basePort + i}`,
      status,
      uptimeMs: status === "starting" ? 4_000 + i * 1000 : 1000 * (60 * (i + 2) + stackIdx * 37),
    };
  });
}

function fmtRelative(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function buildStack(i, agentIdx) {
  const basePort = 38400 + i * 10;
  const services = buildServices(i, basePort);
  const ageSec = [12, 380, 1200, 3600, 9200, 27000, 81000][i] ?? 60 + i * 220;
  return {
    id: `stk_${(i + 1).toString().padStart(2, "0")}`,
    branch: pick(BRANCHES, i),
    worktree: `~/code/anvil-${pick(BRANCHES, i).replace(/[\/_]/g, "-")}`,
    agent: agentIdx >= 0 ? pick(AGENTS, agentIdx) : null,
    startedAt: NOW - ageSec * 1000,
    portRange: `${basePort}-${basePort + services.length - 1}`,
    cpuPct: Math.round(4 + ((i * 17 + 3) % 28) + (i === 0 ? 18 : 0)),
    memMb: 220 + ((i * 113 + 41) % 380) + (i === 0 ? 140 : 0),
    services,
  };
}

// Default seed: 5 stacks, with first 4 attached to agents, last manual
function makeStacks(count = 5) {
  const stacks = [];
  for (let i = 0; i < count; i++) {
    // every stack except the very oldest is agent-driven
    const agentIdx = i === count - 1 ? -1 : i;
    stacks.push(buildStack(i, agentIdx));
  }
  // Newest first
  return stacks.sort((a, b) => b.startedAt - a.startedAt);
}

// ── Log generation ──────────────────────────────────────────────────────────

// A deterministic-but-varied stream of log entries for a given stack.
// Returns N entries, oldest → newest. Times are spaced realistically.
function makeLogs(stack, count = 220) {
  const out = [];
  let t = stack.startedAt + 1500;
  // simple LCG for repeatable jitter per stack
  let seed = stack.id.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 17);
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < count; i++) {
    const svc = stack.services[Math.floor(rnd() * stack.services.length)];
    // unhealthy services emit more errors
    let pool = LOG_CORPUS[svc.id] ?? LOG_CORPUS.api;
    if (svc.status === "unhealthy" && rnd() < 0.5) {
      pool = pool.filter((e) => e.lvl === "error" || e.lvl === "warn");
      if (pool.length === 0) pool = LOG_CORPUS[svc.id];
    }
    const entry = pool[Math.floor(rnd() * pool.length)];
    t += Math.floor(60 + rnd() * 2400);
    out.push({
      id: `${stack.id}-${i}`,
      ts: t,
      svc: svc.id,
      svcColor: svc.color,
      level: entry.lvl,
      message: entry.msg,
    });
  }
  // last log should be close to "now"
  const finalOffset = t - Date.now();
  if (finalOffset > 0) {
    out.forEach((e) => (e.ts -= finalOffset + 800));
  }
  return out;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function summarizeHealth(stack) {
  const healthy = stack.services.filter((s) => s.status === "healthy").length;
  const unhealthy = stack.services.filter((s) => s.status === "unhealthy").length;
  const total = stack.services.length;
  return { healthy, unhealthy, total };
}

Object.assign(window, {
  SERVICE_DEFS, AGENTS, BRANCHES,
  makeStacks, makeLogs, fmtRelative, fmtClock, summarizeHealth, buildStack,
});
