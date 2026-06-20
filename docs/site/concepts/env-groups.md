# env_groups

Env groups are named env-var bundles you can reach for from `lich exec`, lifecycle hooks, and custom commands. Think of them as "the stack's env, but with X swapped" or "just these vars, none of the inherited stuff."

## When to use them

- A custom command needs a different env than the default stack env (e.g. an `isolated-tools` group that doesn't inherit shell vars).
- A lifecycle hook needs the stack env plus a few extras (`stack-plus-test` with `TEST_MODE=integration`).
- You want to source the env into a non-lich-managed terminal: `source <(lich env stack)`.

## The three patterns

```yaml
env_groups:
  # Pattern A: standalone. Only these vars, no inheritance.
  isolated-tools:
    process_env: false              # don't inherit shell env either
    env:
      TOOL_MODE: standalone

  # Pattern B: extends another group.
  stack-plus-test:
    extends: stack                  # inherits stack's resolved env
    env:
      TEST_MODE: integration

  # Pattern C: stack-derived (built-in `stack` group).
  # The `stack` group is implicit. It contains top-level `env:` +
  # per-service `port:` / `host_port` exposures.
```

You don't have to define `stack`. It's always available. Define your own groups when you need to deviate from it.

## Where they're used

### `lich exec --env-group <name> <cmd>`

```bash
lich exec --env-group isolated-tools my-tool --some-flag
```

Runs `my-tool --some-flag` with the `isolated-tools` env, not the default `stack` env. Useful for tools that conflict with stack env vars.

### `lifecycle:` hooks

```yaml
lifecycle:
  after_up:
    - cmd: ./scripts/seed.sh
      env_group: stack-plus-test
```

The seed script runs with `stack-plus-test` env loaded. Stack defaults plus `TEST_MODE=integration`.

### `commands:` (custom CLI commands)

```yaml
commands:
  tools:env-check:
    cmd: printenv DATABASE_URL API_URL
    env_group: isolated-tools
    help: |
      Diagnostic: print env vars under the isolated-tools group.
```

`lich tools:env-check` runs with `isolated-tools` env. Without `env_group:`, custom commands use `stack`.

### `lich env <group>`

```bash
source <(lich env stack)
```

Dumps the named group as dotenv-format on stdout, properly quoted. Round-trips through `source`. Useful for one-off shell sessions that want the stack's env without launching the stack.

## Common mistake

**Treating `env_groups` like profiles.** Profiles change which services run; env_groups change which env is loaded into a particular invocation. If you want a different startup configuration, use a profile. If you want a different env for one command, use an env_group.

See the [`env_groups` section in the lich.yaml reference](/reference/lich-yaml#env-groups) for the full schema.
