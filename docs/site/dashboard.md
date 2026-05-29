# Dashboard

One running stack and you remember where everything is. Four running stacks started in parallel by four agents and you don't.

The dashboard at `http://lich.localhost:3300/` is the killer feature: a single view of every running lich stack on the machine.

## Open it

```bash
lich dashboard
```

This auto-starts the daemon if needed (any directory works, you don't have to be in a worktree) and opens the dashboard in your default browser. Pass `--no-browser` (or set `LICH_NO_BROWSER=1`) to print the URL instead of opening it.

You can also navigate to it directly: `http://lich.localhost:3300/`. The `*.localhost` resolves to loopback on every OS — no DNS setup.

## What you see

::: info Screenshot pending
Dashboard screenshot here. TODO: add once the docs site has a published deploy target.
:::

Per running stack:

- **Source worktree** — which directory the stack belongs to (and the resolved `${worktree.name}` / `${worktree.id}`).
- **Services** — every compose service and owned process, with status (starting / ready / failed / stopped) and uptime.
- **Friendly URLs** — clickable `<service>.<worktree>.lich.localhost:3300` links, one per service.
- **Logs** — tail any service inline; full per-service log files are at `~/.lich/stacks/<id>/logs/<service>.log`.
- **Restart / stop** — per-service or whole-stack restart, stop the whole stack.

## Why this matters for parallel agents

The dashboard is what makes N-agents-in-N-worktrees usable. Without it:

- You forget which worktree owns which port.
- A failed service in agent 3's stack looks identical to a failed service in agent 7's.
- Tailing logs means remembering the full state-dir path of each stack.

With the dashboard, all of that goes through one URL. Agents can deep-link to specific services' logs (`http://lich.localhost:3300/stacks/<id>/logs/<service>`) so when an agent says "the api in worktree X is failing," you have the URL to verify.

## Auto-launches on first stack

The daemon (and therefore the dashboard) autostarts the first time any `lich` command needs it — `lich up`, `lich dashboard`, `lich urls`, etc. There's no `lich daemon start` to remember.

## See also

- [Daemon + proxy](/concepts/daemon-proxy) — how the URL routing works under the hood.
- [Worktree isolation](/concepts/worktrees-isolation) — why the friendly URL pattern is consistent across worktrees.
- [`lich dashboard` reference](/reference/cli#lich-dashboard) — the command's flags.
