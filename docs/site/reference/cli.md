# CLI commands

Every built-in command's long-form help, mirroring `lich <command> --help`. The source of truth is `packages/lich/src/commands/help.ts` (`BUILTIN_LONG_HELP`); this page is regenerated from that table when commands change.

Commands are listed in their `lich --help` display order: daily-driver first, infrastructure next, discovery surfaces last.

## `lich up`

```
Usage: lich up

Bring the current worktree's stack up. Starts every compose service
and owned process declared by the active profile, runs lifecycle
hooks, and prints a summary with the resolved URLs.

Exit codes: 0 on success, non-zero on any failure.
```

## `lich down`

```
Usage: lich down

Stop the current worktree's stack. Tears down every compose service
and owned process, runs before_down lifecycle hooks, and releases
allocated host ports. State directory is preserved.

Exit codes: 0 on success, non-zero on failure.
```

## `lich restart`

```
Usage: lich restart [service ...]

Restart the whole stack, or the named services only. Respects
depends_on ordering.
```

## `lich logs`

```
Usage: lich logs [source...] [flags]

Read logs from the running stack. Sources are service names (api,
web, …) or top-level lifecycle phase names (before_up, after_up,
before_down, after_down). Multiple sources may be given.

Defaults to the last 100 lines across all services, then exits.

Flags:
  --count N           Page size (default 100).
  --before N          Show N lines before cursor N (older).
  --after N           Show lines after cursor N (poll for new).
  --grep <regex>      Filter lines matching pattern.
  --all               Emit all lines without pagination.
  --json              Machine-readable JSON with cursor metadata.
  --follow            Blocking live stream (opt-in, for humans).

Cursor model: --before / --after accept the absolute line numbers
printed in the footer. Cursors are stable across live writes.
```

## `lich urls`

```
Usage: lich urls [--raw]

Print every reachable URL for the running stack. By default emits
the friendly <service>.<worktree>.lich.localhost:<proxy-port>
form; --raw prints the underlying localhost:<allocated-port> URLs.
```

## `lich dashboard`

```
Usage: lich dashboard [--no-browser]

Open the lich dashboard (http://lich.localhost:<proxy-port>/) in
the default browser. Auto-starts the daemon if needed; can be run
from any directory.

Flags:
  --no-browser    Print the URL only; skip the browser open.
                  (Also honored via LICH_NO_BROWSER=1.)

Exit codes: 0 on success; non-zero if the daemon fails to start
or its reverse proxy is unavailable.
```

See the [Dashboard page](/dashboard) for what the UI does once it's open.

## `lich stacks`

```
Usage: lich stacks [--json]

List every lich stack currently running on this machine, with
worktree name, status, and uptime. --json emits machine-readable
output.
```

## `lich nuke`

```
Usage: lich nuke [--yes] [--rescue]

Stop every lich stack on this machine and clean their state
directories. --rescue scans ~/.lich/started.log and runs idempotent
cleanup for resources state.json no longer references. --yes skips
the confirmation prompt.
```

## `lich validate`

```
Usage: lich validate [path] [--json]

Statically analyse a lich.yaml without running anything. Catches
schema errors, unknown depends_on references, dependency cycles,
broken regexes, and bad ${...} interpolations.

Exit 0 if clean, 1 otherwise.
```

## `lich init`

```
Usage: lich init [--force] [--no-gitignore]

Write a starter lich.yaml in the current directory. Also appends
.lich/ to .gitignore unless --no-gitignore is passed. --force
overwrites an existing lich.yaml.
```

## `--help`

```
Usage: lich --help                 # global help (built-ins + user-defined)
       lich <command> --help       # per-command help

`lich --help` lists every built-in command and every user-defined
command from lich.yaml. `lich <command> --help` prints the detailed
help for that command (usage, flags, examples) — for `lich up`, it
also lists the profiles declared in the local lich.yaml.

Exit codes: 0 on success, 1 if the named command is unknown.
```

## `lich exec`

```
Usage: lich exec [--env-group=<group>] <cmd> [args...]

Run an ad-hoc command with the resolved env loaded. Defaults to
the built-in `stack` env_group; --env-group=<name> picks another.
Stdio is inherited so output streams live.

Example: lich exec sh -c 'echo $DATABASE_URL'

Exit codes: 0 on success; child's exit code on failure; 2 on
usage error; 130 on SIGINT.
```

## `lich env`

```
Usage: lich env <group>

Print the named env_group as dotenv-format on stdout. Keys are
emitted in sorted order; values are quoted as needed so the
output round-trips through `source <(lich env <group>)`.

Example: source <(lich env stack)

Exit codes: 0 on success; 1 when the group is unknown; 2 on
usage error (no group name given).
```

## `lich routing`

```
Usage: lich routing

Print the daemon's in-memory routing table as JSON. Useful when
a friendly URL (host:port from `lich urls`) 404s — compare what
the daemon has loaded against the routing entries in state.json.

Exit codes: 0 on success; non-zero if the daemon is unreachable.
```

## `lich feedback`

```
Usage: lich feedback [message] [--file PATH] [--no-context] [--yes]

Submit a user-feedback report. Three invocation modes:
  lich feedback "short message"   inline message
  lich feedback                    opens $EDITOR with a template
  lich feedback --file path.md     reads the body from a file

Auto-attaches: lich version, OS+arch, cwd, your lich.yaml (with
`env_from` cmd: values redacted), daemon status, git branch (no
commits, no diff). Never includes resolved env values or .env file
contents.

Shows the exact payload and prompts for confirmation before doing
anything. Cached locally at ~/.lich/feedback/<timestamp>.md.

Flags:
  --file PATH     Read the message body from a file.
  --no-context    Suppress every auto-attached system-info section.
  --yes, -y       Skip the [y/N] confirmation prompt.

Example: lich feedback "docker compose down hangs on tunnel_demo"
```

See the [feedback page](/feedback) for the user-facing flow.

## User-defined commands

`lich.yaml` can declare custom commands invoked via `lich <name>` (e.g. `lich db:psql`). They inherit the stack's resolved env and show up in `lich --help` alongside the built-ins. See the [`commands:` section in the lich.yaml reference](/reference/lich-yaml#commands).
