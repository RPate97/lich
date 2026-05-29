# Feedback

The lich team's roadmap is shaped by what users tell us. The `lich feedback` command makes the report side cheap and predictable; the `lich-feedback` agent skill makes the structuring side cheap too.

## The fast path

```bash
lich feedback "docker compose down hangs on tunnel_demo"
```

This:

1. Auto-attaches safe context: lich version, OS+arch, your cwd, your `lich.yaml` (with `env_from cmd:` values redacted), daemon status, git branch (no commits, no diff).
2. Shows the exact payload it would send.
3. Asks for confirmation `[y/N]`.
4. On `y`, submits.

It NEVER includes resolved env values, `.env` file contents, log content, or anything you didn't explicitly write into the report body.

## Three invocation modes

```bash
lich feedback "short message"          # inline message
lich feedback                           # opens $EDITOR with a template
lich feedback --file path/to/report.md  # reads the body from a file
```

The `--file` mode is what the `lich-feedback` agent skill uses — the agent drafts a structured report (blockers / bugs / papercuts / what-worked), writes it to a tmp file, then invokes `lich feedback --file <that-file>`.

## Useful flags

```
--file PATH      Read the message body from a file.
--no-context     Suppress every auto-attached system-info section.
--yes, -y        Skip the [y/N] confirmation prompt.
```

`--no-context` is for the rare case where you want to send a minimal report (asking a quick question, etc.) and don't want even the lich version attached. The default is to include context — it's what makes reports useful.

## Cached locally

Every report you send is cached at `~/.lich/feedback/<timestamp>.md` so you can re-read what you sent later. Nothing is sent anywhere else without your confirmation.

## The agent skill

For the longer kind of report — when you've hit multiple rough edges in one session and want them all captured in one structured write-up — install the `lich-feedback` skill:

```bash
npx skills add https://github.com/rpate97/lich/skills/lich-feedback
```

The skill walks three passes:

1. **Survey.** Reads recent stack state and daemon logs so it can ground the report in what actually happened.
2. **Interview.** Asks 4-6 focused questions (intent, expectations, severity, workarounds).
3. **Draft + submit.** Structures everything into blockers / bugs / papercuts / what-worked, shows it inline for review, invokes `lich feedback --file` on confirmation.

This is the path that produced the lich team's most useful single piece of feedback to date. It's not heroic; it's just structured.

## What happens with the report

Reports go to the lich team's tracker, where they shape the roadmap. We genuinely read every one — the project is small enough that this scales. If a report is acted on (bug fixed, feature added, doc improved) you'll typically see it in a release note.

## What NOT to put in a report

- Secrets (the redactor catches `env_from cmd:` output and is conservative about anything that looks like a key, but don't rely on it — leave secrets out).
- Long log dumps verbatim. A relevant 10 lines beats a 10,000-line dump.
- Personal info. The auto-attached context never includes any user identifier, so don't add one yourself.

## See also

- [`lich feedback` CLI reference](/reference/cli#lich-feedback).
