# lich

Dev stack startup is ad-hoc: every project glues `docker compose up && pnpm dev && wait-for-pg && pnpm migrate && open http://...` together its own way, and you can only run one copy at a time because ports, container names, compose projects, and migration state all collide. Lich is a single binary that reads one YAML file describing your stack — containers, host processes, env, lifecycle, profiles — and runs it with per-worktree isolation, so two checkouts of the same repo can run side by side without anything colliding. It wraps `docker compose` and your dev servers rather than replacing them; it doesn't know what framework you use. It's aimed at developers who run multiple worktrees in parallel — most acutely, people driving multiple coding agents against the same repo at once.

## Why lich exists

The acute problem is parallel stacks. Git worktrees let you check out two branches at once; coding agents want to work on three features at once; CI wants to run an isolated stack per test. The moment you try to bring up a second copy of any non-trivial dev stack, things break: host port 5432 is already bound, the compose project name is the same, the database has someone else's migrations, the dev server has cached the wrong env. Every existing tool (raw compose, bash scripts, `make dev`) assumes one stack per machine.

Lich treats "many stacks per machine" as the design center. Each worktree gets its own slug, its own port allocations, its own compose project namespace, its own state directory under `~/.lich/`, and its own friendly URL (`http://web.<worktree>.lich.localhost:3300/`). The same `lich.yaml` describes all of them; `lich up` from any worktree brings up that worktree's stack without touching its siblings. The CLI is the same whether you have one stack or twelve — you just stop being the one who has to think about isolation.

## Install

Lich is distributed as a single statically-compiled binary per platform (Mac arm64/x86, Linux arm64/x86; Windows via WSL2). Until the GitHub release pipeline is published, install from source — the binary builds in a few seconds with [Bun](https://bun.sh):

```bash
git clone https://github.com/RPate97/lich
cd lich
bun install
cd packages/lich && bun run build
# binary is at packages/lich/dist/lich; symlink it onto your PATH:
ln -s "$PWD/dist/lich" /usr/local/bin/lich
```

Once the GitHub release pipeline ships (Plan 6 finale, not yet available), the install path collapses to a single curl one-liner downloading the platform-specific binary:

```bash
# placeholder — not yet published
curl -L https://github.com/RPate97/lich/releases/latest/download/lich-darwin-arm64 \
  | sudo install /dev/stdin /usr/local/bin/lich
```

An `npm install -g lich` wrapper is planned for the same milestone but is not yet available; the binary download will remain the supported path.

## Quickstart

The repo includes a working dogfood stack — Next.js + Express + Postgres — at `examples/dogfood-stack/`. After installing per the section above:

```bash
cd examples/dogfood-stack
lich up
```

`lich up` with no profile arg brings up the stack's default profile (`dev:fast` — api + web on the host, no Postgres, ready in ~3 seconds). It prints a final summary with the friendly URLs:

```
api: http://api.dogfood-stack.lich.localhost:3300/
web: http://web.dogfood-stack.lich.localhost:3300/
dashboard: http://lich.localhost:3300/
```

Open the web URL in a browser, hit `/health` on the api, and visit the dashboard for a live view of every stack on the machine.

When you want the full DB-backed flow (Postgres compose service + `after_up` migrations + seed), pass the profile name:

```bash
lich up dev
```

Other commands you'll use:

- `lich urls` — print the friendly URLs again
- `lich urls --raw` — print the raw `http://127.0.0.1:<port>` URLs (for tooling that doesn't speak `*.localhost`)
- `lich logs api` — tail one service's logs
- `lich down` — tear the stack down
- `lich help` — discover everything else, including user-defined commands declared in `lich.yaml`

## Run two stacks in parallel

The whole point. Two checkouts of the same stack, in two distinct directories, bring up side by side:

```bash
# Shell 1 — the original checkout:
cd /tmp/dogfood-a
cp -R "$LICH_REPO"/examples/dogfood-stack/* .
lich up
lich urls
# → web: http://web.dogfood-a.lich.localhost:3300/

# Shell 2 — the parallel checkout:
cd /tmp/dogfood-b
cp -R "$LICH_REPO"/examples/dogfood-stack/* .
lich up
lich urls
# → web: http://web.dogfood-b.lich.localhost:3300/
```

Both stacks are running. They picked different host ports automatically (the file-locked allocator serializes both `up` calls so they never hand out the same port). Their compose projects are namespaced per-worktree, so the containers don't see each other. Their state lives under separate directories in `~/.lich/stacks/`. The dashboard at `http://lich.localhost:3300/` lists both. Each stack's friendly URL hostname is derived from its directory basename — `dogfood-a` and `dogfood-b` here — which is why two checkouts with the same basename would share a friendly URL and need `--raw` to disambiguate.

`lich down` in either directory tears down only that directory's stack. `lich nuke` is the escape hatch — kills every lich stack on the machine — for when an agent forgot about one at 3am.

Git worktree users: the same property holds. `git worktree add ../my-app-feature-x feature-x` gives you a second tree with basename `my-app-feature-x`; running `lich up` in there produces friendly URLs under `<service>.my-app-feature-x.lich.localhost:3300/`.

## What lich is (and is not)

**Lich is:**

- A thin wrapper that gives your existing dev stack a uniform interface
- A worktree-aware orchestrator — port allocation, env wiring, lifecycle, supervision, isolation
- A single static binary that reads one `lich.yaml`
- The standard CLI surface for your project — user-defined commands become first-class `lich <name>` invocations with the right env loaded
- Compose-runtime-agnostic — docker, podman, nerdctl all work

**Lich is not:**

- A framework — it drives yours
- A container runtime — it drives one
- A bundler, linter, test runner, or scaffolder
- A plugin ecosystem — extension happens via shell-out, not plugins
- Opinionated about your stack — Rails, Django, Phoenix, Go, .NET all work the same way
- A live-update tool (Tilt's territory) or a Kubernetes orchestrator

## Configuring your own project

For greenfield projects (or any case where you'd rather write the config yourself): `lich init` writes a heavily-commented `lich.yaml` skeleton in the current directory and adds `.lich/` to `.gitignore`. Every top-level section is present as a commented-out example, so you can uncomment and fill in only the pieces you need. Run `lich validate` to check your work; the schema reference in the skeleton's first-line comment also drives editor autocomplete via the YAML language server.

For brownfield projects — wrapping an existing stack of containers + dev servers + scripts — the recommended path is the `lich:instrument` agent skill, shipped in this repo at `packages/lich/skills/lich-instrument.md`. Point a coding agent (Claude Code, Cursor, etc.) at the skill; it walks the agent through reading your `package.json` / `Gemfile` / compose files / `.env.example` / dev scripts and translating them into a working `lich.yaml`, then runs `lich validate` and `lich up` to verify before showing you the diff.

## Documentation

- **Design spec** — `docs/superpowers/specs/2026-05-23-lich-v1-design.md`. The source of truth for what lich does, why, and how every primitive is supposed to behave. Read this for depth.
- **Testing standards** — `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`. The two-tier (unit + e2e) discipline every feature follows. Read this before contributing.
- **Agent onramp skill** — `packages/lich/skills/lich-instrument.md`. The markdown skill that translates an existing project into a `lich.yaml`.
- **E2e suite audit** — `tests/e2e/AUDIT.md`. Per-test pool assignment, hardening notes, and the rationale for the fast/compose split.

## Contributing

Start with `CLAUDE.md` at the repo root — it's the entry doc for both human and agent contributors and links the required reading. Every change follows the testing standards: unit tests for the logic, e2e tests that spawn the real binary against `examples/dogfood-stack/`. Small focused commits, no `--amend`, no `--no-verify` on hook failures.

## License

Apache 2.0.
