# Feedback template — the structured shape

This is the shape `lich-feedback` drafts produce. Use it as a checklist when synthesizing the survey + interview into a report.

**Rule one: every section is optional.** Skip ones with nothing to say. A 5-line report with one well-described bug is more valuable than a 200-line speculative tome. Bias toward fewer, sharper items.

**Rule two: anchor every item in something concrete.** A specific command, a verbatim error message, a yaml key, a file path. Vague items ("the UI is confusing") are unactionable; specific items ("dashboard at http://lich.localhost:3300/ shows blank page when the daemon is down — expected a connection-error banner") drive fixes.

**Rule three: don't pad.** If a section is empty, omit the header too. Don't write "N/A" or "nothing to report" — just leave it out.

## The shape

```markdown
# Feedback: <one-line summary>

## Context

<One paragraph: what the user was trying to do at a high level, and the rough shape of their project. Just enough so the reader knows what world the rest of the report is in. Example: "Setting up lich for a Next + Express + Postgres monorepo via the `lich-instrument` skill. First-time lich user, comfortable with docker-compose.">

## Blockers

<Things that prevented the user from accomplishing their goal. Show-stoppers — they couldn't proceed without a workaround or a fix. Each item should describe what they were trying to do, what happened, and ideally the workaround they tried (or the fact that there wasn't one).>

- **<short label>**: <what happened, command-level specifics, error if any>

## Bugs

<Things that worked incorrectly or unexpectedly. Distinguished from blockers by: the user could keep going, but the behavior was clearly wrong (not just friction).>

- **<short label>**: <expected vs actual behavior, command + error if applicable>

## Papercuts

<Things that worked but were friction: slow, surprising, awkward, repeated. The user got their work done, but the rough edge taxed them. Docs/clarity issues live here too.>

- **<short label>**: <what was friction-y, ideally with a "would have been better if X" suggestion>

## What worked

<Things that went smoothly and should keep working. This section protects against regressions and is psychologically grounding to write after a list of complaints. Be specific — "the docs are good" is less useful than "the `lich validate` error for unknown ready_when keys was clear and pointed me to the right doc.">

- **<short label>**: <what worked well, why it mattered>

## Suggested priority

<The user's read on which items above are urgent vs nice-to-have. Helps the team triage. Format flexibly — could be three buckets (urgent / important / nice-to-have), or just a one-liner ("the ready_when bug is blocking me from shipping a demo Friday; everything else can wait"). The user knows their own priority better than the team does.>

## Workarounds tried

<What the user did to get unstuck. Even failed workarounds are signal — they show what surface area the user explored, which tells the team what the user expected to work. Format: "tried X, didn't work because Y" or "settled on Z, which works but is ugly because W.">
```

## Mapping interview answers to sections

When you synthesize the Pass 2 answers, here's the rough mapping:

| Interview answer | Lands in |
|---|---|
| "I was trying to do X" | `## Context` |
| "I expected X but got Y" | `## Bugs` (if Y was clearly wrong) or `## Papercuts` (if Y was just friction) |
| "I can't ship without this" | `## Blockers`, also flag in `## Suggested priority` as urgent |
| "annoying but I have a workaround" | `## Papercuts` + the workaround goes in `## Workarounds tried` |
| "minor polish, mention for someday" | `## Papercuts`, flag in `## Suggested priority` as nice-to-have |
| "this part was great" | `## What worked` |

## What about feature requests?

Feature requests usually land in `## Blockers` (if the missing feature is the show-stopper) or `## Papercuts` (if there's a working-but-ugly workaround). Frame them as "the feature I'd want is X because Y" rather than just "add X" — the *why* is what helps the team prioritize.

A new top-level section (`## Feature requests`) is overkill in most reports; only use it if the user has multiple feature ideas they want to keep distinct from bug/papercut categories.

## What about things the user just dislikes?

Aesthetic preferences ("I don't like the spinner color") are valid feedback but lower-signal than functional complaints. They go in `## Papercuts` with a clear flag in `## Suggested priority` that they're cosmetic. Don't pad these — one is fine, five suggests the user couldn't think of anything more substantive.

## Example: a minimal report

A report doesn't have to fill every section. Here's a real-shaped two-section report:

```markdown
# Feedback: ready_when timeout waits forever even when the process already exited

## Bugs

- **ready_when fail-fast missing on process exit**: ran `lich up --profile dev` with a typo in the dev script — the process exited in <1s with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`, but lich waited the full 180s `ready_when.timeout` before reporting failure. The error message at the end even said "exited with code 254 while waiting to become ready" — so the daemon already knew, it just didn't act on it. Should fail immediately when the spawned PID dies during the ready wait.

## Suggested priority

This one is the only real blocker right now — 3 minutes of dead air per failed startup during config iteration adds up. The other things I noticed can wait.
```

That's it — two sections, no padding. Far more actionable than a generic "validate is slow sometimes" gestural complaint.
