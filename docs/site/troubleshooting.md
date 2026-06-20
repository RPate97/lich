# Troubleshooting

Common gotchas, in roughly the order people hit them.

## Basic failures

### `lich up` fails immediately with "no lich.yaml found"

You're not in a directory with a `lich.yaml`. Either `cd` to the project root, or run `lich init` to create one.

### A service won't come up

Check the service's logs:

```bash
lich logs <service-name>
```

Common causes:
- **Env var unresolved:** `${services.foo.host_port}` references a service that doesn't exist or hasn't allocated a port yet. Check the spelling and that the referenced service is in the active profile.
- **Port already in use:** Lich allocates ports dynamically, so this shouldn't happen for compose services. For owned services with hardcoded `ports:`, switch to lich-allocated ports.
- **Healthcheck timeout:** The service starts but doesn't pass `ready_when` in time. Increase the timeout in `ready_when:` or fix what's actually wrong.

### Can't reach a service via its friendly URL

Friendly URLs (`http://<service>.<worktree>.lich.localhost:3300/`) need the daemon to be running. Check:

```bash
lich stacks
```

If your stack isn't listed, the daemon may not have picked it up. Run `lich up` again or check daemon logs at `<LICH_HOME>/daemon/daemon.log`.

### `lich down` doesn't fully clean up

If a service was killed externally (e.g. `docker kill`), state may be inconsistent. Try:

```bash
lich nuke --rescue
```

This sweeps orphaned stacks and cleans them up.

---

## Advanced gotchas

## `command not found: turbo` (or nx, lage, wireit, prisma, etc.)

Symptom: your `lich.yaml` has `cmd: turbo run dev` (or similar) and lich reports "command not found" even though `turbo` is installed as a workspace dep at `node_modules/.bin/turbo`.

Cause: spawned commands inherit `PATH` from the parent shell, but `node_modules/.bin` isn't on `PATH` by default unless you went through the package manager (`pnpm exec`, `yarn run`, `npm exec`).

Fix: either route through the package manager:

```yaml
owned:
  server:
    cmd: pnpm exec turbo run dev --filter=server   # pnpm exec sets PATH correctly
```

See [Recipes → Monorepo workspace tooling](/recipes/#recipe-2-monorepo-workspace-tooling-turbo-nx-lage-wireit) for the full pattern.

## `ready_when` times out without showing why

Symptom: `lich up` waits the full `ready_when.timeout`, then fails with a generic "service X never became ready" message. You don't know if the process even started.

Cause: without a `fail_when.log_match`, lich has no way to short-circuit the wait when the process logs an obvious failure (`EADDRINUSE`, `Cannot find module`, etc.).

Fix: add a `fail_when.log_match` regex for common "won't recover" signals:

```yaml
owned:
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { published_env: PORT }
    ready_when:
      http_get: /health
      timeout: 30s
    fail_when:
      log_match: "EADDRINUSE|Cannot find module|SyntaxError|TypeError"
```

The regex matches against the service's log lines; a match fails the startup immediately (instead of waiting the full timeout) with the log tail surfaced inline.

## Friendly URL 404s

Symptom: `lich urls` prints `http://api.my-feature.lich.localhost:3300/`, but visiting it returns 404 from the lich proxy.

Cause: the daemon's in-memory routing table is out of sync with `~/.lich/stacks/<id>/state.json`. This usually means a stale daemon that didn't pick up a recent stack-state update.

Fix:

```bash
lich routing        # print the daemon's current routing table
```

Compare it to the entries you expect. If they don't match, restart the daemon:

```bash
lich nuke           # stops every stack AND the daemon
# (the next `lich up` autostarts a fresh daemon)
```

Or kill the `lich-daemon` process directly; it'll respawn on the next CLI invocation that needs it.

## `lich.yaml` rejects `build:` / `command:` / `restart:` on a compose service

Symptom: `lich validate` rejects fields you'd normally use in a `docker-compose.yml`.

Cause: lich's schema is closed (`additionalProperties: false`) on services. The allowed compose-spec passthroughs in v1 are: `image`, `environment`, `volumes`, `tmpfs`, `healthcheck`, `depends_on`, `networks`, `profiles`. Everything else (`command`, `entrypoint`, `working_dir`, `user`, `restart`, `build`, etc.) is rejected.

Fix: write the unsupported fields to a sibling `compose.yaml` and reference it from `lich.yaml` via `compose_file:` / `service:` instead of inlining.

## `lich up` reinstalls dependencies every time

Symptom: every `lich up` spends 30-60s in `pnpm install` (or `yarn install`, `npm install`, `bun install`, etc) even though the lockfile hasn't changed.

Cause: you wrapped the install in `lifecycle.before_up` without a staleness check, so it runs unconditionally.

Fix: compare the lockfile's mtime to the package manager's last-install marker and only reinstall if stale. See [Recipes → pnpm install preflight](/recipes/#recipe-3-pnpm-install-preflight-skip-cold-cache-reinstalls) for the recipe.

## `lich validate` rejects `ready_when.port_open`

Symptom: `lich validate` reports `additionalProperties: 'port_open' is not allowed` on `ready_when`.

Cause: there is no `port_open` key. The TCP-level readiness probe is `tcp: "<host>:<port>"`.

Fix:

```yaml
ready_when:
  port_open: 5432              # WRONG — not a real key
```

```yaml
ready_when:
  tcp: "localhost:5432"        # right
  # or, with interpolation against an allocated port:
  tcp: "localhost:${services.postgres.host_port}"
```

## See also

- [Common validate errors](/reference/lich-yaml#common-validate-errors) — full list of validate errors and remediation.
- [Recipes](/recipes/) — patterns past the basics.
