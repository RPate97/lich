# Design: lich README

**Status:** Approved by user 2026-05-21. Ready for implementation via writing-plans → drafting.

**Linear:** LEV-235 (Write the README).

---

## Decisions made during brainstorm

1. **Primary audience:** all three reader types (solo devs / team leads / plugin authors) roughly equally weighted. README sections aren't labeled by audience, but the flow serves each: Quick Start hits solo devs first; Why lich exists + Parallel stacks land for team leads evaluating tooling; Extending lich hands plugin authors a working example + deep links.
2. **Core pitch:** **agent-native dev environment orchestration.** Specific differentiators:
   - Worktree-aware CLI (state, logs, ports all scoped per worktree)
   - Automatic per-worktree port mapping (parallel stacks never collide)
   - Single entrypoint (one CLI, no juggling 15 tools)
   - Efficiency benefits for agent workflows (one-liner to start, stop, pull logs)
3. **Voice:** **confident with personality.** Bun/Astro vibes — direct but with character. Includes a specific flippant moment about scaling laptop crashes.
4. **Competitor framing:** **don't compare at all.** Describe lich on its own terms. Trust readers to know the landscape.
5. **Structure:** **Approach A — Tight README (~350-450 lines).** Each section has one job. Skimmable in 2 minutes. Maintenance-friendly.

## Out of scope (deliberately deferred)

- License declaration — user will decide separately; README ships with a placeholder until then.
- `lich.sh` domain link — owned but ignore for now; can add when the domain has content.
- Hero gif / animated demo — work to produce, stales fast on UX changes; worth a follow-up ticket if/when needed for an HN-style launch.
- CONTRIBUTING.md — pre-publish phase doesn't need it; README's Contributing section is two sentences pointing at "open an issue."

---

## Structure

Eight sections in order:

| # | Section | Approx. lines |
|---|---|---|
| 1 | Hero | 5 |
| 2 | Why lich exists | 35-40 |
| 3 | Quick start | 12-15 |
| 4 | Parallel stacks, one CLI | 50-60 |
| 5 | What's in the v0 stack | 20-25 |
| 6 | Extending lich | 50-60 |
| 7 | Status | 20-25 |
| 8 | Documentation / Contributing / License (three separate H2s) | 15-20 |

Total: ~350-450 lines including whitespace + code fences.

---

## Section content (drafts approved during brainstorm)

The drafts below are the source of truth. The implementer drafts the actual `README.md` faithfully from these; small wordsmithing is fine but the structure, voice, and concrete examples are fixed.

### §1 — Hero

```markdown
# lich

The dev environment built for parallel, agent-driven work.
One command up. One command down. One command for logs. Isolated per
worktree so five agents on five features don't fight over port 3000.
```

**Notes:**
- Lead with the name. No subheading clutter.
- No badges in v1 (no CI badge / npm version / docs URL exists yet; ghost badges look amateur).
- The "five agents on five features" image lands the differentiator without abstract language.

### §2 — Why lich exists

```markdown
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
stack — own ports, own state, own logs. `lich up` brings it up.
`lich down` tears it down. `lich logs api` shows the api logs *for this
worktree*. Switch worktrees and the CLI's context switches with you.
The stack itself (postgres, redis, the api framework, the ORM) is
plugin-based and composable.

Scales to as many parallel stacks as your machine will tolerate. We've
run ~15 simultaneous worktrees comfortably; around 20 the fans start
giving you stink-eye; somewhere past that your laptop will just say no.
That's a hardware problem, not a lich problem.
```

**Notes:**
- ¶2 closes with the agent-efficiency angle: "every minute an agent burns hunting for log files… is wall-clock waste — overhead measured in API spend per agent, multiplied by every agent you're running." Makes the cost concrete in dollars rather than vibes.
- ¶3 uses the one-liner cadence (`lich up` / `lich down` / `lich logs api`) to demonstrate simplicity.
- ¶4 is the flippant scaling close. "Fans giving you stink-eye" + "your laptop will just say no" + the deadpan "That's a hardware problem, not a lich problem" is the personality moment landing.

### §3 — Quick start

````markdown
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
````

**Notes:**
- Four-line code block, no padding.
- bun prereq as inline comment, not a separate Requirements section — keeps quick-start visually tight.
- One follow-up sentence explaining what just happened; no oversell — next section does the proof work.

### §4 — Parallel stacks, one CLI (the differentiator)

````markdown
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

`lich logs api` in either directory shows *that* worktree's api logs.
`lich down` in either directory tears down only *that* worktree's stack.
The CLI tracks which stack belongs to which worktree so you don't have to.

Repeat for every parallel feature you (or your agents) are working on.

Lost track of who started what? `lich nuke` is the escape
hatch — tears down every lich stack on the machine, no matter which
worktree spawned it. (Inevitable when an agent spins up a stack at 3am
and forgets about it.)
````

**Notes:**
- This is the load-bearing section of the entire README. Everything else supports it.
- "**two stacks running**" is bold deliberately — the moment the differentiator lands.
- Real-looking ports (54002/54005, 54010/54011), not placeholders — feels visceral.
- The `lich nuke` escape hatch gets its own paragraph for visual weight. Parenthetical close ("Inevitable when an agent spins up a stack at 3am…") carries the personality.

### §5 — What's in the v0 stack

```markdown
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
```

**Notes:**
- "Typed api client" describes by function not by current implementation name (currently homegrown `@lich/plugin-typed-client`; LEV-225 plans to replace with `@hey-api/openapi-ts`) — the description survives the swap.
- Examples in the close (Temporal, Redis, Cloudflare tunnel) reference real planned plugins (LEV-227, existing plugin-redis, LEV-231) without falsely claiming they ship in v0.

### §6 — Extending lich

````markdown
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
````

**Notes:**
- ~20 lines of plugin code + the wire-up. Demonstrates two extension points (command + env source) without diving deep into theory.
- Implementer must verify the `Plugin<...>` generic signature matches the actual `@lich/core` type at READMEdrafting time. (The shape may have shifted slightly post-LEV-221 rename.)

### §7 — Status

```markdown
## Status

Pre-release. No published npm packages yet. We're shipping into our own
use and the API will keep shifting until the first tagged release.

What works today:
- v0 stack runs end-to-end — scaffold, sign up, todo CRUD, sign out, all of it
- Parallel worktree isolation (the differentiator above is real and tested)
- ~50 e2e tests covering scaffold → install → dev → migrate → seed → gen → stop
- Plugin extension via the API shown above

In flight: new first-party plugins (Temporal, Supabase, Drizzle,
LocalStack, Cloudflare tunnels), a `lich:instrument` skill for
onboarding existing repos, npm publishing, build pipeline. Track in the
[issues tab](https://github.com/<your-org>/lich/issues).

Don't use lich in production yet. Use it for local dev and tell us
what breaks.
```

**Notes:**
- Honest pre-release framing without apology.
- The exact e2e test count (~50) should be verified at drafting time; today master has 50+ across `packages/core/tests/e2e/`.
- `<your-org>` placeholder needs the actual GitHub org slug filled in at draft time.
- Closing line ("tell us what breaks") is the soft CTA — invites engagement without being a stars-please beg.

### §8 — Documentation / Contributing / License (three separate sections in the README)

```markdown
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

[TBD — user will decide before publish. Placeholder until then.]
```

**Notes:**
- Short. Skips a real CONTRIBUTING.md until there's contributor traffic.
- License placeholder is explicit (`[TBD]`) so implementer doesn't accidentally ship a vague claim.

---

## Implementation notes for the drafter

1. **Naming.** This README must use `lich` everywhere. If the rename (LEV-221) hasn't shipped when the README is drafted, the README still uses `lich` — they should land in the same PR.
2. **Package names.** Use `@lich/*` everywhere (`@lich/core`, `@lich/create-stack-v0`, `@lich/plugin-*`).
3. **Code examples.** All TypeScript snippets must typecheck against the actual current type signatures. Run a quick check before merging.
4. **Verifiable claims.**
   - "~50 e2e tests" — count actual current tests
   - "We've run ~15 simultaneous worktrees comfortably" — flippant but should be roughly true; if you've only run 3, change the number
   - All `docs/` paths must exist
5. **Link to the issues tab.** Replace `<your-org>` with the actual GitHub org slug.
6. **Don't add badges.** No CI badge, no npm version, no docs.lich.sh URL until those things exist. Empty placeholders look amateur.

## Followup tickets (not blocking this work)

- License decision (separate from this ticket — user picks before publish)
- `lich.sh` domain — when it has content, README header gets a link
- Hero gif / animated demo — optional polish for HN-style launch
- CONTRIBUTING.md — written when there's contributor traffic

## Acceptance

- `README.md` exists at repo root
- Reader can answer in 5 minutes: what is this? why would I use it? what's the first command?
- All eight sections present in the order specified
- Voice consistent throughout (confident, with the flippant scaling moment + escape-hatch parenthetical)
- All links resolve to existing docs
- No "@lich" references anywhere (post-rename or paired with the rename)
- No badges
- License placeholder is explicit, not vague

---

**Next step:** writing-plans skill produces the implementation plan for this design.
