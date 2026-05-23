# lich

> **⚠ This README describes the v0 design (now archived). The project is being rewritten as v1 with a fundamentally different shape: single binary, YAML config, no plugin runtime, no scaffolder. This README will be rewritten as part of Plan 6.**
>
> For the current direction:
> - Product spec: `docs/superpowers/specs/2026-05-23-lich-v1-design.md`
> - Testing standards: `docs/superpowers/specs/2026-05-23-lich-v1-testing-standards.md`
> - Current plan: `docs/superpowers/plans/2026-05-23-lich-v1-plan-0-foundation.md`

---

An open source and highly extensible development stack driver built for parallelized, agent-driven work.

> `lich up`: Bring your stack up
> `lich down`: Tear your stack down
> `lich logs`: Search logs from your stack
> `lich curl`: Send requests to your stack
> `lich test`: Run integration and e2e tests against your stack
> `lich nuke`: Escape hatch to tear down everything

## Worktree Scoped

The entire lich CLI is worktree scoped meaning:

- Lich automatically detects where it's run from and creates fresh stacks for each worktree. 
- Lich dynamically handles port allocation and environment variable mapping to ensure each stack remains properly isolated. 
- Lich routes all commands intelligently to the correct stack based on the worktree.

Lich is an efficent and reliable driver for your development stack that enables highly parallelized workflows using agents.

## Lich is designed for agents (and humans)

Traditional local development tooling is designed for an individual developer running a single stack on a single machine. Lich is designed for many agents working on behalf of a single human. Lich empowers agents to:
- Start and stop their own stack, scoped to the worktree they are operating in, without interfering with each other or you.
- Run tests and validate their work against that stack.
- Request your review of their work with a real running stack.
- Easily discover all tools available to them within your project.

## Lich works everywhere your project does

Lich is built on top of the tools you already use which means it can also be run everywhere you need it to run. Lich can run:
- Your stack on your local machine (of course)
- Your stack in a Cloud Coding agent environment (Claude Cloude, Cursor cloud, Codex Cloud)
- Dedicated cloud containers (not recommended for production)

## What lich is not
- Lich is not a framework, lich drives your framework
- Lich is not a container, lich controls the containers
- Lich is not a bundler, linter, testing framework, or other type of development tool. Lich wraps your existing tools and provides a powerful interface for using them to your agents.

## Quick start

```bash
# Requires bun (https://bun.sh)
bunx @lich/create-stack-v0 my-app
cd my-app
bun install
bun run lich up
```

That's it. `lich up` allocates ports, brings up postgres, runs your api
and web in parallel, and prints the URLs to open.

## Parallel stacks, one CLI

Open a new git worktree and run `lich up` again:

```bash
git worktree add ../my-app-feature-x feature-x
cd ../my-app-feature-x
bun install
bun run lich up
```

You now have **two stacks running** in parallel. They picked different
ports automatically. Their compose projects are namespaced. Their
`.lich/` state lives in their own worktree paths.

```bash
# Terminal 1 (main worktree)
$ bun run lich urls
api    http://localhost:54002
web    http://localhost:54005

# Terminal 2 (feature-x worktree)
$ bun run lich urls
api    http://localhost:54010
web    http://localhost:54011
```

`lich logs api` in either directory pulls *that* worktree's api logs.
`lich down` in either directory tears down only *that* worktree's stack.
The CLI tracks which stack belongs to which worktree so you don't have to.

Repeat for every parallel feature you (or your agents) are working on.

Lost track of who started what? `lich nuke` is the escape hatch — tears
down every lich stack on the machine, no matter which worktree spawned
it. (Inevitable when an agent spins up a stack at 3am and forgets about
it.)

## What's in the v0 stack

The default `lich create` template ships a working full-stack app with:

- **Postgres** — compose service, persisted per worktree
- **Hono** — typed api framework, runs as a host process
- **Next.js** — web app, runs as a host process
- **Prisma** — ORM, migrations, seed
- **Better Auth** — email/password auth with session cookies
- **shadcn/ui** — component primitives wired in
- **Typed api client** — generated from your routes, consumed by the web app
- **Playwright** — e2e tests that drive the full stack

Every piece is a plugin. Don't want Prisma? Swap in your own ORM plugin.
Want Temporal, Redis, a Cloudflare tunnel? Add a plugin. Want to write
your own? Read [docs/EXTENSION.md](docs/EXTENSION.md).

## Extending lich

A plugin is a function that contributes things to your project: commands,
env sources, compose services, adapters. Here's one that adds a
`lich hello` command:

```ts
// plugins/hello/index.ts
import type { Plugin } from '@lich/core';

export default function hello(): Plugin<'hello', { named: 'greeting'; bulk: never }> {
  return {
    name: '@my-app/plugin-hello',
    namespace: 'hello',
    version: '0.1.0',

    register(api) {
      api.addCommand({
        name: 'hello',
        describe: 'Say hi to someone',
        run(ctx) {
          const name = ctx.args[0] ?? 'world';
          return { ok: true, message: `hello, ${name}` };
        },
      });
      api.addEnvSource('greeting', {
        host: () => 'hi',
        container: () => 'hi',
      });
    },
  };
}
```

Wire it into `lich.config.ts`:

```ts
import hello from './plugins/hello';

export default defineConfig({
  plugins: [/* v0 plugins */, hello()],
});
```

Now `lich hello you` prints a message and `lich env list` shows
`hello.greeting`. Deeper plugin authoring:
[docs/EXTENSION.md](docs/EXTENSION.md) and
[docs/plugin-author-guide.md](docs/plugin-author-guide.md).

## Documentation

- [docs/EXTENSION.md](docs/EXTENSION.md) — plugin authoring overview
- [docs/plugin-author-guide.md](docs/plugin-author-guide.md) — deeper plugin guide

## License

Apache 2.0.
