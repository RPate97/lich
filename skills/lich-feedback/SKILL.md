---
name: lich-feedback
description: Craft and submit structured feedback to the lich team. Use this skill whenever the user wants to send feedback to the lich team, asks how to report a bug or feature request, says "this is frustrating" / "this seems broken" / "lich is being weird" after a lich command, mutters about a lich rough edge they keep hitting, or you (as an agent) observe a real lich-related problem the user is running into repeatedly. Walks the user through producing a structured report (blockers, bugs, papercuts, what-worked) and submits it via `lich feedback --file`. Don't just suggest "file an issue" — actually generate a useful report with the user.
---

# Lich Feedback

You are helping the user send the lich team feedback that's actually useful — structured, grounded in what just happened, short enough to read but long enough to act on.

The lich team's best signal so far came from a single user who wrote 400 lines of hand-organized notes (blockers / bugs / papercuts / what-worked, each cross-referenced to specific commands and error messages). That report shifted the roadmap. The goal of this skill is to make that kind of feedback the easy path, not the heroic one.

Crucial: actual user-submitted feedback beats agent-invented feedback every time. Your job is to elicit and structure what the user already knows, not to author claims they haven't made.

## The flow

Three passes:

1. **Survey** — gather signal about what's been going wrong from local lich state, recent daemon logs, and the current lich.yaml. No questions yet; you're building a picture so you don't ask the user to repeat what you can already see.
2. **Interview** — ask the user 4-6 focused questions, one at a time, to fill in the parts only they know (intent, expectations, severity, workarounds).
3. **Draft + submit** — synthesize the survey + interview into the structured shape (see `references/feedback-template.md`), show it inline for review, then invoke `lich feedback --file <path>` on confirmation. The `lich feedback` command itself shows its own confirmation + auto-context + curl footer before anything leaves the machine.

Stop and ask if you don't know — never invent error messages, fabricate workarounds, or speculate about what the user thinks is broken.

## Pass 1: Survey

Read the local signals quickly. Don't deep-dive; you're looking for "what happened recently?" not "diagnose the bug."

**Lich state files** (the daemon writes one per stack):

```bash
ls ~/.lich/stacks/ 2>/dev/null
cat ~/.lich/stacks/<stack-id>/state.json 2>/dev/null | jq '{status, services: [.services[] | {name, state, failure_reason}]}'
```

Look for services in the `failed` state and any `failure_reason` / `failure_log_tail` fields. Healthy states are `starting | healthy | initializing | ready | stopping | stopped`; anything else (especially `failed`) is concrete signal of a recent problem.

**Per-service logs** (much higher signal than the daemon log):

```bash
ls ~/.lich/stacks/<stack-id>/logs/ 2>/dev/null
tail -100 ~/.lich/stacks/<stack-id>/logs/<service>.log 2>/dev/null
```

If a service is `failed` in state.json, its `logs/<service>.log` often has the actual error message. Pull verbatim error strings from here for the report.

**Daemon log tail** (forward-looking — may not exist):

```bash
tail -200 ~/.lich/daemon.log 2>/dev/null
```

In current lich versions the daemon may spawn with `stdio: ignore` and not write a log file at all. If the file doesn't exist, skip it. When it does exist, look for `ERROR`, `WARN`, and lifecycle events near when the user said something went wrong.

**Current lich.yaml** — read it for shape (services / owned / profiles / lifecycle hooks), but **don't transmit the resolved contents**. The `lich feedback` command will attach a redacted copy itself (with `env_from cmd:` values masked); your job is just to understand the stack shape so you can ask better questions.

**Cached prior feedback** (if any):

```bash
ls -lt ~/.lich/feedback/ 2>/dev/null | head -5
```

If the user has filed feedback before, the most recent file shows you what's already been reported — don't duplicate.

**Recent shell history** (skip unless the user already mentioned a specific command failure). Look for the most recent `lich up` / `lich validate` / `lich logs` invocations to ground the conversation in real commands they ran.

What you're building: a 2-3 sentence mental model of "the user's stack is X, and Y appears to have gone wrong recently." Don't write this up yet — it's the scaffolding for Pass 2.

## Pass 2: Interview

You have signals. Don't ask the user to repeat them. Ask only about the parts of the picture that aren't on disk: intent, expectations, severity, and what they tried.

Ask **one question at a time**. Wait for the answer before asking the next one. Mirroring lich-instrument's interview style — a tight back-and-forth is how you get specifics; a wall of questions gets vague answers.

Suggested order (skip any you've already inferred):

1. **What were you trying to do?** Frame matters — "I was trying to add a postgres profile" is a completely different report from "I was demoing lich to a coworker."

2. **What did you expect to happen vs what actually happened?** This is the most load-bearing question. Specifics over generalities. If they say "it broke," push for the exact command + exact error.

3. **Is this a bug, missing feature, or docs/clarity issue?** Helps you pick the right section in the template. Bugs go in `## Bugs`; feature gaps go in either `## Blockers` (show-stoppers) or `## Papercuts` (friction). Docs/clarity is also a papercut.

4. **How blocking is this for you right now?** Drives the `## Suggested priority` section. "I can't ship without this" vs "annoying but I have a workaround" vs "minor polish, mention for someday" — all three are valid; we just need to know which.

5. **Any workarounds you tried?** Goes in `## Workarounds tried`. Even failed workarounds are signal — they show what surface area the user explored, which tells the team what the user expected to work.

6. **Anything that's working really well you want us to keep?** Optional but high-leverage — `## What worked` protects against regressions and is psychologically nice to write at the end of a frustrating session. Skip if the user is short on patience.

Don't grill. Once you have the gist, stop interrogating and draft. The user can edit the draft. See `references/triage-questions.md` for more interview tactics (what to do when the user is vague, how to extract verbatim error messages, how to detect "okay enough, just submit it" energy).

## Pass 3: Draft + submit

Draft the report using the shape in `references/feedback-template.md`. Show it **inline** in chat — don't write a file yet. Each section is optional; **skip sections you have nothing for**. A 10-line report with one well-described bug is far better than a 200-line speculative tome.

Anchor each item in something concrete:
- A specific command (`lich up --profile dev`)
- A specific error message (verbatim, in a code block)
- A specific file path or yaml key (`owned.api.ready_when.http_get`)

Don't add items the user didn't mention. If a section is empty, omit it.

For "what good looks like," see `references/examples/example-feedback-report.md` — a worked example showing the structure and specificity that makes a report actionable.

After showing the draft, ask: **"Look right? Want to add, remove, or rephrase anything before I send it?"** Wait for the OK. Take edits seriously — the user knows the specifics better than you do.

On confirmation:

1. Write the report to a temp file:
   ```bash
   TMPFILE=$(mktemp -t lich-feedback-XXXXXX.md)
   # write the draft into $TMPFILE
   ```
2. Invoke the command:
   ```bash
   lich feedback --file "$TMPFILE"
   ```
3. The `lich feedback` command will:
   - Show the full payload (your draft + auto-attached `lich version` / OS / cwd / redacted `lich.yaml` / daemon status / git branch)
   - Prompt `Submit this feedback? [y/N]`
   - On `y`, cache to `~/.lich/feedback/<timestamp>.md` and print a `curl` command the user can run themselves (v0 ingestion is "print the curl"; wiring a hosted endpoint is tracked separately)

Don't try to bypass that prompt with `--yes` — the user needs to see the auto-attached context once, since it includes their (redacted but still possibly identifying) lich.yaml.

If the user doesn't have `lich` installed at all (rare in this skill's context, but possible), point them at:
```bash
curl -fsSL https://raw.githubusercontent.com/RPate97/lich/main/install.sh | bash
```

## Reference files

- **`references/feedback-template.md`** — the structured shape (sections, order, what goes where). Read when drafting in Pass 3.
- **`references/triage-questions.md`** — interview prompts and tactics. Read when planning the Pass 2 questions or when the user gives a vague answer you need to drill into.
- **`references/examples/example-feedback-report.md`** — a worked example. Read when you need to see what "good" looks like across all four section types.

## What NOT to do

- **Don't just say "you can file an issue at github.com/..."**. The whole point of this skill is to *do* the structured-feedback work with the user, not punt them to a bug tracker with an empty box.
- **Don't invent error messages, stack traces, or behavior the user didn't describe.** Hallucinated specifics in feedback are worse than no feedback — they waste the team's time chasing things that didn't happen.
- **Don't draft before the interview.** You need the user's intent and severity read; drafting from survey signals alone produces generic reports.
- **Don't transmit `.env` contents or resolved env values.** The `lich feedback` command is deliberately careful here (it doesn't read `.env`, doesn't resolve env_groups). Don't undo that by pasting env values into the report body.
- **Don't pad the draft to look thorough.** Empty sections are fine — omit them. The 5-line report with one specific bug is the high-value output.
- **Don't ask all the interview questions at once.** A barrage gets back a paragraph of vagueness. One question at a time gets back specifics.
- **Don't skip showing the draft to the user.** The whole point of the inline review is they can correct, soften, or sharpen language before it leaves the machine.
- **Don't submit without `--file`**. The inline form (`lich feedback "message"`) is for one-liners; this skill produces multi-section reports that need a file.
