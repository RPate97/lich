# Telemetry

Lich collects anonymous usage telemetry to help me (the maintainer) understand which commands people actually use and where things go wrong. The data is minimal, never includes PII, and you can disable it at any time.

## What's collected

### CLI commands

One event per invocation of the `lich` binary. The event is `cli_command` with these properties:

| Property | Example | Notes |
|---|---|---|
| `command` | `up`, `down`, `logs` | The top-level subcommand only |
| `exit_code` | `0`, `1`, `2`, `130` | Standard process exit code |
| `duration_ms` | `4521` | How long the command took |
| `version` | `0.2.1` | Lich CLI version |
| `platform` | `darwin-arm64` | Same shape as release tarball names |
| `distinct_id` | UUID v4 | Anonymous per-installation identifier, stored at `~/.lich/installation-id` |

The `distinct_id` is generated once on first run and stays the same for that machine. It's not linked to anything: not your email, not your GitHub, not your IP (PostHog anonymizes that). Deleting `~/.lich/installation-id` resets it.

### Installer

The `install.sh` script sends one event when it finishes, with the version installed, the platform, and whether a custom install prefix was used. Distinct ID is `anonymous-installer` (no per-machine identifier on installs).

### Docs site

The docs site at `lich.sh` uses PostHog's JS SDK for anonymous page-view and navigation analytics. Respects browser Do Not Track. No identifying cookies beyond what PostHog uses to count unique sessions.

## What's NOT collected

- Worktree paths
- `lich.yaml` contents (service names, env values, anything inside the yaml)
- Logs from your stack
- Environment variable values
- Error messages (paths in stack traces are a leakage risk, so only an `exit_code` is sent)
- Hostnames, usernames, anything from `os.userInfo()`

If anything from this list ever ends up in the telemetry payload, it's a bug. File an issue.

## How to disable

Any of these disables CLI telemetry, in order of precedence:

```bash
# Per-shell:
export LICH_TELEMETRY=0

# Per-user, persistent (any of "0", "false", "off", "no" work):
mkdir -p ~/.lich
echo '{"telemetry": false}' > ~/.lich/config.json

# Per-project (in lich.yaml):
runtime:
  telemetry: false

# For the installer specifically:
LICH_INSTALL_NO_TELEMETRY=1 curl -fsSL https://lich.sh/install.sh | bash
```

Docs site analytics disable:

```js
// In browser devtools console at lich.sh:
localStorage.setItem('lich_telemetry_disabled', '1')
// Then refresh.
```

The docs site also respects your browser's Do Not Track header automatically.

## Why I do this

Two questions I cannot answer without telemetry:

1. **Are people using this?** Without download numbers I have no idea whether to keep investing in lich. One number per day is enough.
2. **Where do commands fail?** If `lich up` exits non-zero 30% of the time, something is wrong and I want to know.

Both questions are answered by the minimal data above. There's no plan to expand the schema. If that ever changes, it'll go through a versioned, public update with the option to re-consent.

## Where the data lives

PostHog Cloud (US region, `us.i.posthog.com`). It's a paid SaaS analytics product. Only I (the maintainer) have access. The PostHog public write key embedded in the CLI and the docs is intentionally public — it can only write events, not read them back.

## Where to ask questions

If anything here is unclear or you spot a privacy issue, open an issue at [github.com/RPate97/lich/issues](https://github.com/RPate97/lich/issues).
