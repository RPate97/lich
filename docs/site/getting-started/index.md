# Getting started

Lich is a CLI plus a long-running daemon. Install the CLI, write a `lich.yaml`, then `lich up`.

## Install

Available for macOS (arm64 / x64), Linux (arm64 / x64), and Windows via WSL.

```bash
curl -fsSL https://raw.githubusercontent.com/RPate97/lich/main/install.sh | bash
```

The installer downloads pre-built `lich` and `lich-daemon` binaries from the latest GitHub release and drops them in `~/.local/bin`. Make sure that's on your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc  # or ~/.bashrc
exec $SHELL -l
lich --help
```

You should see the built-in command list.

## Your first `lich.yaml`

Lich expects a `lich.yaml` at the root of your repo (or anywhere you want to run a stack from). The simplest valid file declares one service:

```yaml
version: "1"

owned:
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { published_env: PORT }
    ready_when:
      http_get: /health
```

That's a complete, valid stack: lich allocates a host port, exposes it as `PORT` in the api process's env, runs `bun run dev`, waits for `/health` to return 200, and reports the stack as ready.

Add a database via the `services:` block:

```yaml
version: "1"

services:
  postgres:
    image: postgres:16-alpine
    ports:
      - { container_port: 5432, published_env: POSTGRES_HOST_PORT }
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp
    tmpfs:
      - /var/lib/postgresql/data    # in-RAM data dir, gone on `lich down`

owned:
  api:
    cmd: bun run dev
    cwd: apps/api
    port: { published_env: PORT }
    depends_on: [postgres]
    ready_when:
      http_get: /health

env:
  DATABASE_URL: "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/myapp"
```

The interpolation `${services.postgres.host_port}` resolves at startup against the port lich allocated for the postgres container, so the api process sees a real `DATABASE_URL` like `postgresql://postgres:postgres@localhost:54317/myapp`. The port is different in every worktree, allocated dynamically by lich, never colliding.

For everything you can put in a `lich.yaml`, see the [full reference](/reference/lich-yaml).

## Environment variables

Inline `env:` is fine for non-secret values like the `DATABASE_URL` above, but most stacks also need to load secrets from a file or a secret-manager CLI. Both flow into the same per-service env.

### From a `.env` file

```yaml
env_files:
  - .env
  - .env.local
```

Relative paths resolve from the worktree root (the directory containing `lich.yaml`). Multiple files merge in declared order — later files override earlier ones. Missing files are silently skipped, so listing `.env.local` even though only `.env` exists is fine.

**Worktree behavior — one `.env` in your main checkout, shared everywhere.** When a relative path doesn't exist in the current worktree, lich falls back to the same path resolved against the *main* worktree (the directory containing the shared `.git` dir). So you can keep one `.env` at your repo root and every `git worktree add`'d branch picks it up automatically — no symlinks, no copying, no per-worktree setup.

If you also want worktree-specific overrides, declare both files and put the override-only one in the local worktree:

```yaml
env_files:
  - .env          # lives in main checkout; loaded by every worktree
  - .env.local    # if it exists in this worktree, overrides .env values
```

Absolute `env_files` paths are used as-is — no fallback. Use those when the file lives somewhere outside any repo (`/etc/myapp/.env`, etc.).

### From an external secret CLI

For Infisical, 1Password CLI, `vault`, `aws secretsmanager`, `doppler`, or anything else that prints `KEY=VALUE` lines (or flat JSON) to stdout:

```yaml
env_from:
  - cmd: "infisical export --env=dev --format=dotenv"
    format: dotenv          # or: json (for a flat object)
```

The cmd runs every `lich up`, stdout is parsed in the chosen format, and the result merges into the stack env. Examples:

```yaml
env_from:
  - cmd: "op inject -i .env.tpl"             # 1Password CLI
    format: dotenv
  - cmd: "vault kv get -format=json -field=data secret/myapp/dev"
    format: json
  - cmd: "aws secretsmanager get-secret-value --secret-id myapp/dev --query SecretString --output text"
    format: json
```

`env_from` also accepts plain strings, which pass through a named env var from the parent shell — useful for `GITHUB_TOKEN` or other developer-machine credentials you don't want to commit anywhere:

```yaml
env_from:
  - GITHUB_TOKEN
  - NPM_TOKEN
```

### Precedence

When the same key appears in multiple places, later layers win in this order:

1. `env_from:` (cmd output / pass-through)
2. `env_files:`
3. `env:` (literal values in `lich.yaml`)

So an inline `env:` value always overrides one from a `.env` file or a secret CLI — handy for pinning a value during local debugging without touching the source file.

## `lich up` walkthrough

From the repo root:

```bash
lich up
```

What happens:

1. **Parse `lich.yaml`.** Schema-validate. Resolve the active profile (defaults to the one marked `default: true`, or the only profile, or "everything declared at top level").
2. **Allocate host ports.** Every `port:` / `ports:` declaration gets a real, unused integer assigned. The port map is complete before any service starts allowing for the declarative syntax of the `lich.yaml`.
3. **Resolve env.** Top-level `env:`, profile env, per-service env, env_groups are all layered into the final per-service env.
4. **Bring services up.** Compose services first (`docker compose up -d` against a generated per-stack override file), then owned processes in dependency order. Lifecycle hooks fire at the right boundaries (`before_up`, `after_up`).
5. **Wait for readiness.** Each owned service's `ready_when` runs. Compose `healthcheck` blocks `depends_on:`.
6. **Print URLs.** Once everything is healthy, lich prints the friendly URLs and the underlying allocated ports.

```bash
lich up
# ... boot output ...

✓ Stack ready (4.2s)

URLs:
  api  http://api.my-feature.lich.localhost:3300/   ->  localhost:54281
  web  http://web.my-feature.lich.localhost:3300/   ->  localhost:54282
```

The `*.lich.localhost` URLs are served by a single shared daemon. `*.localhost` resolves to the loopback on every OS. No `/etc/hosts` edits, no DNS setup. See [Daemon + proxy](/concepts/daemon-proxy) for how the routing works.

## Useful next commands

```bash
lich logs              # tail every service in this stack
lich logs api          # tail just one
lich urls              # print the URLs again
lich exec              # run a one-off command with the stack's env loaded
lich dashboard         # open the multi-stack dashboard in your browser
lich down              # stop this stack, release the ports, preserve state
lich stacks            # list every running stack on this machine
lich nuke              # tear down every stack everywhere, from any cwd
```

Every command is documented in detail in the [CLI reference](/reference/cli).

## Run two stacks at once

Once you have a working stack, the per-worktree isolation is what makes lich actually useful. From a second worktree of the same repo:

```bash
cd ../my-repo-feature-branch     # a different worktree
lich up                          # gets its own ports, its own state, its own dashboard entry
```

Both stacks run simultaneously. The first one is at `http://api.main.lich.localhost:3300/`, the second at `http://api.my-feature.lich.localhost:3300/`. See [Worktree isolation](/concepts/worktrees-isolation) for the full picture.

## Next steps

- [Use the lich-instrument skill](/getting-started/instrument) to wire up your existing repo with an agent.
- [Read the full `lich.yaml` reference](/reference/lich-yaml).
- [Browse recipes](/recipes/) for monorepo tooling, install caching, supabase, and other common wrinkles.
