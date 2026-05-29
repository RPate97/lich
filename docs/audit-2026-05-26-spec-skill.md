# LEV-484 Audit: spec doc + lich-instrument skill vs actual lich behavior

**Date:** 2026-05-26
**Auditor:** subagent
**Scope:** cross-check every claim about `lich.yaml` shape and behavior in
`docs/superpowers/specs/2026-05-23-lich-v1-design.md` and the
`skills/lich-instrument/references/*.md` files against the actual lich
implementation (`packages/lich/src/config/schema.ts`,
`packages/lich/src/config/types.ts`,
`packages/lich/src/config/interpolation.ts`) plus runtime behavior via
`lich validate`.

**Known-pending, not flagged here:** `lifecycle.after_down` is being added
separately in LEV-488. Claims that reference it are noted under the
LEV-488 section at the bottom rather than as DOC WRONG.

**Method:** built the binary (`cd packages/lich && bun run build`), wrote
~25 minimal yaml fixtures each exercising one claim, ran each through
`./dist/lich validate <fixture>`, and compared the result against the
docs. Also read the schema + types + interpolation modules end-to-end.

## Summary

| Category | Count |
|---|---|
| DOC WRONG | 7 |
| DOC MISSING | 6 |
| AMBIGUOUS | 3 |
| Follow-ups recommended for separate tickets | 5 |

Small fixes (under ~5 lines, high confidence) were applied in-place in
this same commit. Larger ones are listed in "Follow-ups".

---

## DOC WRONG

### 1. Skill claims `${env.VAR}` interpolation is supported

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`
**Line:** 193

> `${env.VAR}` — pass-through from the host shell env (fails if unset; use `${env.VAR:-default}` for fallback)

The interpolation engine (`packages/lich/src/config/interpolation.ts`,
`SUPPORTED_SHAPES` array, lines 139-149) does NOT support `env.*`
references. Validate-time output:

```
unknown reference ${env.SOME_HOST_VAR} (supported: worktree.*, services.<name>.host_port, services.<name>.host_port_<idx>, services.<name>.ports.<key>, owned.<name>.port, owned.<name>.ports.<key>, owned.<name>.captured.<key>)
```

The skill's secondary `${env.VAR:-default}` shape is also wrong — no shell-style
default-value syntax exists.

**Status:** FIXED in this commit. The skill now points users at host env
inheritance via the shell that runs `lich` (which carries through to the
spawned services per the env precedence rules), with `env_files:` /
`env_from:` as the documented loading paths for values that need to be
declared in the yaml.

### 2. Skill claims `${env.VAR}` is the way to reference secrets

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`
**Line:** 438 (in the "Notes on what lich does NOT support" section)

> Secret management — lich doesn't store secrets. Use a `.env` file (gitignored) and reference its values via `${env.VAR}`.

Same root cause as #1. `.env` is loaded via top-level `env_files:` (which
the skill doesn't mention either — see DOC MISSING #1) and individual
keys become part of the resolved stack env directly; you reference them
by name (`$DATABASE_URL`) in your service's `cmd`, not via a `${env.X}`
interpolation.

**Status:** FIXED in this commit.

### 3. Skill says "five places hooks can live"

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`
**Line:** 233

> Hooks at stack boundaries. Five places hooks can live; only two are commonly needed:

Actual count from the schema:
- Top-level: `before_up`, `after_up`, `before_down` (3)
- Per-service: `before_start`, `after_ready`, `before_down` (3)
- Profile-scoped: same three top-level hooks (mechanically a 4th surface but
  identical to top-level shape)

So 6 distinct surfaces if you count profile-scoped separately. The "five"
number doesn't match either reading. The same paragraph then shows
`after_down` in its yaml example (line 245), inflating the count if the
author was thinking 4 top-level (including the not-yet-supported one) + 1
per-service surface — but per-service has 3 entry points, not 1.

**Status:** FIXED — reworded to enumerate the three top-level hooks and
note per-service hooks separately; the `after_down` line removed from
the example (with a forward-looking note about LEV-488).

### 4. Skill claims `runtime.proxy_port` default is "derived from LICH_HOME if unset"

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`
**Line:** 52

> `proxy_port: 3300           # daemon's reverse-proxy port (default 3300, derived from LICH_HOME if unset)`

Default is just `3300` (see `packages/lich/src/urls/format.ts`
`DEFAULT_PROXY_PORT = 3300`). The `LICH_HOME` env var has no relationship
with proxy port resolution. There IS a `LICH_PROXY_PORT` env var override
used by `bin/lich-daemon.ts`, but the comment confuses two different env
vars (HOME = the state directory location; PROXY_PORT = the proxy
binding).

**Status:** FIXED in this commit.

### 5. Skill claims many compose passthroughs work that don't

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`
**Line:** 92

> **Most compose features pass through verbatim:** `image`, `environment`, `volumes`, `tmpfs`, `healthcheck`, `depends_on`, `command`, `entrypoint`, `working_dir`, `user`, `restart`, etc. If it works in `docker-compose.yml`, it works here.

The schema (`packages/lich/src/config/schema.ts` lines 151-195,
`composeServiceSchema` with `additionalProperties: false`) only allows:
`compose_file`, `service`, `ports`, `lifecycle`, `depends_on`, `image`,
`environment`, `healthcheck`, `volumes`, `networks`, `profiles`, `tmpfs`.

Validate-time rejection for `command`/`entrypoint`/`working_dir`/`user`/
`restart`:

```
/services/app has unknown property 'command'
/services/app has unknown property 'entrypoint'
/services/app has unknown property 'working_dir'
/services/app has unknown property 'user'
/services/app has unknown property 'restart'
```

The "If it works in `docker-compose.yml`, it works here" claim is the
load-bearing one; flatly wrong.

**Status:** FIXED — replaced the list with the actual allowed set and
pointed users at a sibling `compose.yaml` (via `compose_file:` +
`service:`) as the escape hatch for unsupported fields.

### 6. Skill's "Common validate errors" section lists an error lich does not emit

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`
**Line:** 396

> ### "compose service X has no `image` or `build`"
> Compose services need one or the other. `image:` is the common case.

Lich validate has no such check. Compose itself emits "neither an image
nor a build context specified" at runtime (see comments in
`packages/lich/src/compose/override.ts:291`) — but lich never sees it
during validate because validate doesn't shell out. Also `build:` is not
in the schema (see #5; `build` is also called out as unsupported on line
439 of the same doc).

**Status:** FIXED — replaced with text that explains the actual situation
(lich's schema doesn't require `image:` either; runtime compose enforces
it; `build:` is not in lich's allowed set).

### 7. Spec doc claims validate checks file existence

**File:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md`
**Line:** 637

> - Verifies referenced files exist (`env_files` paths, `cwd` directories for owned services and commands)

Validate does not check either. Fixtures with a nonexistent `env_files`
path and a nonexistent `cwd` directory both validate clean. (See spec
line 376 itself: "Missing files are silently skipped" for env_files —
which directly contradicts line 637.)

**Status:** NOT FIXED in this commit — `docs/superpowers/` is gitignored
in this repo, so spec edits can't be committed from this worktree. The
orchestrator should land the spec-doc fix separately. Recommended change:

```diff
- - Verifies referenced files exist (`env_files` paths, `cwd` directories for owned services and commands)
+ - Does NOT verify filesystem presence (`env_files` paths and `cwd` directories are not stat'd at validate time; env_files are intentionally optional per the `env_files` semantics, and `cwd` is resolved at spawn time)
```

---

## DOC MISSING

### 1. `env_files:` is not documented in the skill

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`

The top-level `env_files:` field (and per-owned-service `env_files:`)
appears nowhere in the skill yaml-spec. The schema supports it, the
dogfood stack should plausibly use it, and the spec doc documents it at
section 4. Users following the skill have no way to know they can load
`.env` files declaratively.

**Recommendation:** add a short section between the `env_groups` and
`lifecycle` sections (or alongside `env`).

### 2. `env_from:` is not documented in the skill

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`

Same situation as #1. `env_from` (shell-out for secrets) is the
secret-manager integration story for lich. Spec doc section 4 documents
it. Skill yaml-spec doesn't mention it once. Users have no idea Infisical
/ 1Password / etc. integration is a first-class feature.

**Recommendation:** add an `env_from` section after `env_files`.

### 3. Per-service `lifecycle` hooks not in skill

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`

The skill's `lifecycle` section only covers top-level. Per-service
lifecycle (`before_start`, `after_ready`, `before_down`) is fully
supported on both compose and owned services per the schema
(`perServiceLifecycleSchema`, lines 71-79) and documented in the spec
(line 298-301 for services, 325 for owned). The dogfood stack doesn't
exercise them but a user wanting to run a setup script tied to a single
service has no documentation pointing at this surface.

**Recommendation:** add a "Per-service lifecycle" subsection under the
top-level lifecycle section.

### 4. `services.<name>.compose_file` + `services.<name>.service` external-passthrough fields not documented

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`

The schema supports declaring a compose service by pointing at an
existing sibling compose file (`compose_file:` + `service:` keys per
`composeServiceSchema` in `schema.ts`). Users with an existing
`docker-compose.yml` they don't want to inline have no way to discover
this in the skill (LEV-477 made the inline path work but the external
path is also valid). (The inline-edit for DOC WRONG #5 now points at
this escape hatch by name — adding a section that actually explains how
to use it would close the loop.)

**Recommendation:** add an "External compose files" subsection under the
`services` section.

### 5. `runtime.port_range` not documented

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`

The schema accepts `runtime.port_range: [start, end]` (lines 316-321).
The skill's `runtime` section only lists `compose_cli` and `proxy_port`.
Users with a constrained port range (firewalled CI environments, e.g.)
need this knob.

**Recommendation:** add a `port_range` row to the runtime section.

### 6. Deprecated `runtime.compose` alias not surfaced

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`

The schema accepts both `compose_cli` (canonical) and `compose`
(deprecated alias kept for back-compat with earlier drafts of the spec).
A user reading an older repo's `lich.yaml` with `runtime.compose: docker`
won't know whether they should switch to `compose_cli:` or whether the
alias is still legitimate.

**Recommendation:** a single line in the runtime section noting the alias.
Low priority — the alias name will probably get a deprecation warning
later.

---

## AMBIGUOUS

### 1. Skill says compose port `env:` is exposed "inside the container"

**File:** `skills/lich-instrument/references/lich-yaml-spec.md`
**Line:** 87-88

> `ports.env` is the env var lich exposes **inside the container** — the actual host port is dynamic, allocated by lich per stack.

This is half the truth. The env var IS injected into the compose
container's environment, but the more useful fact for the user (and the
one the spec emphasizes at line 289) is that it's also exposed in the
host context for env interpolation (`${services.<name>.host_port}` etc.).
The skill's wording undersells the host-side use, which is the load-
bearing one for owned-service env wiring.

**Recommendation:** reword to "lich exposes this env var both inside the
container AND in the host context for interpolation". Low priority but
would prevent confusion.

### 2. Spec says `stop_cmd` is "Required when `oneshot: true`" but no enforcement

**File:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md`
**Line:** 324

> `stop_cmd`: custom teardown command (default: SIGINT the tracked PID). Required when `oneshot: true`.

Neither the schema (`ownedServiceSchema` has `cmd` as the only
`required:` field) nor `lich validate` enforces this. A oneshot without
`stop_cmd` validates clean. Runtime behavior in
`packages/lich/src/commands/nuke.ts:287` silently skips teardown when
`stop_cmd` is absent — so side-effects leak instead of failing loudly.

The spec's intent is correct (oneshot side-effects without a stop_cmd
*are* a footgun), but "Required" is ambiguous when nothing actually
requires it. Either the spec should soften the wording to "strongly
recommended" or the schema/validate should enforce it.

**Recommendation:** filed as a Follow-up below — needs an impl change
plus doc, beyond the scope of this audit.

### 3. Spec claim about lifecycle entries in section 4 vs section 7 inconsistency

**File:** `docs/superpowers/specs/2026-05-23-lich-v1-design.md`

The lifecycle section (line 387-454) shows long-form entries with
`env_group:` but never mentions `cwd:` even though the schema supports it
on lifecycle entries (`lifecycleEntrySchema`, line 40-54). The
implication "long form = `{ cmd, env_group }`" is one a reader could
walk away with.

**Recommendation:** soft-fix — add a `cwd:` example or a brief
"long-form fields: cmd, env_group, cwd" enumeration. Skill yaml-spec line
249 actually has this right (`{ cmd: ..., env_group?: ..., cwd?: ... }`)
but the design spec doesn't. Low priority.

---

## Known pending (LEV-488 — not flagged as DOC WRONG)

The skill yaml-spec mentions `lifecycle.after_down` at three places in
the original (pre-fix) text:

1. Line 30: lifecycle row in the top-level structure table said
   "before_up / after_up / before_down / after_down hooks"
2. Line 245-246: `after_down` example inside the lifecycle code block
3. (And the "five places hooks can live" miscount on line 233 was partly
   inflated by including after_down — see DOC WRONG #3 above)

LEV-488 is adding `after_down` separately. The in-commit fixes here
trimmed (1) and (2) to a forward-looking note that says "planned in
LEV-488"; they did not silently delete the feature mention. Once
LEV-488 ships, audit the skill once more and confirm the wording
reflects shipped behavior.

---

## Follow-ups (recommended Linear tickets)

Each item is something the audit surfaced that's too big for a same-
commit fix, or touches lich source (out of scope here).

### F1. env_from shorthand string semantics: schema comment vs implementation

**Severity:** medium (silent footgun)

`packages/lich/src/config/schema.ts` line 23 says:

> // String shorthand: env var name to inherit from the parent process.

The actual implementation in `packages/lich/src/env/shell-out.ts:60-63`
treats the string as a SHELL COMMAND:

```ts
function normalize(entry: EnvFromEntry, defaultCwd?: string): NormalizedEntry {
  if (typeof entry === "string") {
    return { cmd: entry, format: "dotenv", cwd: defaultCwd };
  }
  ...
}
```

A user writing `env_from: [HOME]` expecting to inherit `$HOME` from their
shell will instead try to execute `HOME` as a shell command. The unit
test (`tests/unit/env/shell-out.test.ts:31`) confirms shell-command
semantics.

Two options:
1. Fix the schema comment to match the implementation ("Shell command
   shorthand — equivalent to `{ cmd: <string>, format: dotenv }`").
2. Add the inherit-env-var semantics the comment promises (separate
   syntax — could be e.g. `env_from: [{ inherit: HOME }]` since the bare
   string is now taken).

Option 1 is the smaller fix; option 2 is what the comment author
presumably intended. Either way, the current state is misleading both to
readers of the schema and to anyone who reaches the schema first to
understand env_from.

### F2. Enforce `stop_cmd` required when `oneshot: true`

**Severity:** low (correctness vs leaky default)

Per AMBIGUOUS #2 above. Either soften the spec's "Required" wording or
add the check to `commands/validate.ts`. The latter prevents real
production footguns (orphan supabase containers after a typo'd lich.yaml
is committed); the former just clarifies intent. Recommend the latter
since the spec already says the right thing.

### F3. Document per-service lifecycle in the skill

**Severity:** low (DOC MISSING #3)

Add a per-service lifecycle subsection to
`skills/lich-instrument/references/lich-yaml-spec.md`. Should cover
`before_start`, `after_ready`, `before_down` on both compose and owned
services with one short example.

### F4. Document `env_files` and `env_from` in the skill

**Severity:** medium (DOC MISSING #1 and #2)

Add `env_files` and `env_from` sections to the skill yaml-spec. Without
these, the skill is silently incomplete on the secret-manager / dotenv
integration story — a first-class feature per the spec.

### F5. Document `services.X.compose_file` + `service` external-passthrough, and `runtime.port_range`

**Severity:** low (DOC MISSING #4 and #5)

Add an "External compose files" subsection so users with existing
`docker-compose.yml` files can leave them in place. Add a `port_range`
row to the runtime section. The schema already supports both; only the
skill doc is silent.

---

## Verification

All fixtures used to exercise the audit live under `/tmp/lich-audit/`
(transient; not committed). Each was a minimal yaml exercising exactly
one feature claim, run through `./packages/lich/dist/lich validate
<fixture>` and the output compared against the doc. Negative tests (e.g.
`${env.X}`, `lifecycle.after_down`, `command:`/`entrypoint:`/etc. on
compose services) were run as cross-checks.

The dogfood-stack lich.yaml + the skill's dogfood-example.md + the
skill's framework-patterns.md snippets (Express, Django, postgres, redis,
mailhog, temporal) + the external-cli-services.md supabase example all
validate clean against the current binary; no false-positive doc claims
surface as runtime breakage for users following them.
