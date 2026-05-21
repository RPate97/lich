# lich

The dev environment built for parallel, agent-driven work.
One command up. One command down. One command for logs. Isolated per
worktree so five agents on five features don't fight over port 3000.

## Why lich exists

Agents are increasingly the ones writing code, often working in parallel
across multiple branches. Each agent (or human) needs its own running
stack to test changes. The old assumption — one developer, one terminal,
one stack on `localhost:3000` — doesn't survive that workflow.

Without something like lich, the failure modes are familiar: two stacks
fighting for port 3000, `.env` files that drift across worktrees, dead
containers from a stack you forgot to tear down, bash scripts that work
on your machine until the day they don't. Multiply that across N parallel
worktrees and the entropy compounds. And every minute an agent burns
hunting for log files, parsing `docker compose` output, or fumbling
through debug commands is wall-clock waste — overhead measured in API
spend per agent, multiplied by every agent you're running.

Lich takes a different posture. Every worktree gets its own isolated
stack — own ports, own state, own logs. `lich dev` brings it up.
`lich stop` tears it down. `lich logs api` shows the api logs *for this
worktree*. Switch worktrees and the CLI's context switches with you.
The stack itself (postgres, redis, the api framework, the ORM) is
plugin-based and composable.

Scales to as many parallel stacks as your machine will tolerate. We've
run ~15 simultaneous worktrees comfortably; around 20 the fans start
giving you stink-eye; somewhere past that your laptop will just say no.
That's a hardware problem, not a lich problem.

## Quick start

```bash
# Requires bun (https://bun.sh)
bunx @lich/create-stack-v0 my-app
cd my-app
bun install
bun run lich dev
```

That's it. `lich dev` allocates ports, brings up postgres, runs your api
and web in parallel, and prints the URLs to open.

## Parallel stacks, one CLI

Open a new git worktree and run `lich dev` again:

```bash
git worktree add ../my-app-feature-x feature-x
cd ../my-app-feature-x
bun install
bun run lich dev
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

`lich logs api` in either directory shows *that* worktree's api logs.
`lich stop` in either directory tears down only *that* worktree's stack.
The CLI tracks which stack belongs to which worktree so you don't have to.

Repeat for every parallel feature you (or your agents) are working on.

Lost track of who started what? `lich stacks stop --all` is the escape
hatch — tears down every lich stack on the machine, no matter which
worktree spawned it. (Inevitable when an agent spins up a stack at 3am
and forgets about it.)

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

## Status

Pre-release. No published npm packages yet. We're shipping into our own
use and the API will keep shifting until the first tagged release.

What works today:

- v0 stack runs end-to-end — scaffold, sign up, todo CRUD, sign out, all of it
- Parallel worktree isolation (the differentiator above is real and tested)
- 100+ e2e tests covering scaffold → install → dev → migrate → seed → gen → stop
- Plugin extension via the API shown above

In flight: new first-party plugins (Temporal, Supabase, Drizzle,
LocalStack, Cloudflare tunnels), a `lich:instrument` skill for
onboarding existing repos, npm publishing, build pipeline. Track in the
[issues tab](https://github.com/<your-org>/lich/issues).

Don't use lich in production yet. Use it for local dev and tell us
what breaks.

## Documentation

- [docs/EXTENSION.md](docs/EXTENSION.md) — plugin authoring overview
- [docs/plugin-author-guide.md](docs/plugin-author-guide.md) — deeper plugin guide
- [docs/testing.md](docs/testing.md) — the three testing tiers (unit / integration / dogfood)
- [docs/releases.md](docs/releases.md) — release workflow

## Contributing

Pre-publish phase, so the contribution model is "open an issue, propose
the change, we'll discuss." Once we tag the first release we'll write up
a proper CONTRIBUTING.md.

## License

TBD.
