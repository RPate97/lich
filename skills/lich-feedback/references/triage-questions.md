# Triage questions — the interview prompts

The Pass 2 interview is where you get the information that isn't on disk: the user's intent, their expectations, their severity read, what they tried. Asking the right questions in the right order makes the difference between a vague report and an actionable one.

## The core six

Ask **one at a time.** Wait for the answer. Don't barrage. If the user answers two at once, just skip the ones they've already covered.

### 1. What were you trying to do?

The frame question. Sets up everything else.

- "I was trying to add a postgres profile to my lich.yaml" → frames as a configuration / docs question
- "I was demoing lich to a coworker and the dashboard kept crashing" → frames as a reliability / first-impression question
- "I was trying to ship a fix today" → high-urgency framing

Don't accept "I was using lich" — push for the specific task. Examples of pushback:
- "Got it — were you setting up a new stack, debugging a running one, or something else?"
- "What were you working toward when this came up?"

### 2. What did you expect to happen vs what actually happened?

The most load-bearing question in the interview. Push for specifics in both halves.

**Bad answer:** "It broke."
**Good answer:** "I expected `lich up` to start postgres and the api together; instead lich waited 3 minutes on postgres health and then timed out with `unhealthy: connection refused`."

If the user is vague, push:
- "What did you actually see on screen? Exact words if you can."
- "Was there an error message? What did it say?"
- "What command did you run?"

If you can pull the verbatim error from the daemon log or state.json, do that and ask the user to confirm: "I see `failure_reason: ready_when timeout` in your state file — is that the error you saw?"

### 3. Is this a bug, a missing feature, or a docs/clarity issue?

Helps you slot the item into the right template section.

- **Bug:** behavior is clearly wrong. Goes in `## Bugs`.
- **Missing feature:** functionality the user expected isn't there at all. Goes in `## Blockers` (if it's a show-stopper) or `## Papercuts` (if there's a workaround).
- **Docs/clarity:** the feature exists but the user couldn't figure it out from the docs / error messages. Goes in `## Papercuts`.

If the user isn't sure, classify it yourself based on the survey signals. Don't make them litigate the taxonomy.

### 4. How blocking is this for you right now?

Drives the `## Suggested priority` section. Three rough buckets:

- **"Can't ship without this":** urgent, goes at top of priority. Tag in the report.
- **"Annoying but I have a workaround":** important, not urgent.
- **"Minor polish, mention for someday":** nice-to-have. Don't pad these — one or two is plenty.

Watch for false urgency. Users sometimes say "this is the worst" about minor friction because it just happened. Ask "is this blocking what you were trying to ship today, or just annoying?" to disambiguate.

### 5. Any workarounds you tried?

Goes in `## Workarounds tried`. Even failed workarounds are valuable signal — they tell the team what surface area the user explored, which tells them what the user expected to work.

Push for specifics:
- "I tried setting `ready_when.timeout: 600s` but it still timed out at 180s — turns out that's not a recognized key"
- (vs vague: "I tried changing some config")

### 6. Anything that's working really well you want us to keep?

Optional but high-leverage. Two reasons to ask:

1. **Protects against regressions.** "The dashboard auto-opening on `lich up` is fantastic — please don't make that opt-in" tells the team something they need to know.
2. **Psychologically grounding.** Ending a frustrating session with one positive note often makes users more willing to write feedback at all next time.

Skip this if the user is short on patience or running out the door. The first five questions are higher priority.

## Tactical guidance

### When the user is vague

Bad answer patterns and how to push:

- **"It's just broken."** → "Which command? What error?"
- **"Lich is weird."** → "Walk me through what just happened. What did you run, what did you see?"
- **"I don't know, it didn't work."** → "Let me look at your daemon log to ground this." (Then summarize what you found and ask "Does this match what you saw?")
- **"Everything's terrible."** → "Pick the one thing that's bugging you the most right now — start there. We can add more later."

### When the user mentions a specific command failure

Get the verbatim error. Either:
- Ask them to paste it
- Pull it from `~/.lich/daemon.log` or `~/.lich/stacks/<id>/state.json` yourself and confirm with them

Verbatim error messages in feedback reports are worth 10x paraphrased ones — they let the team grep their codebase for the literal string.

### When the user is venting

Sometimes the user just needs to vent for a minute before they can produce useful signal. That's fine. After the vent, gently steer back to specifics:

- "Yeah, that sounds frustrating. Want to capture this so the team can fix it? What were you running when it happened?"

Don't reflect the vent's emotional register back in the report. The team reads the report; what they need is "here's what broke," not "the user was very angry." The user can sharpen the tone themselves on review.

### When the user wants to be brief

If the user says "I just want to fire off a quick complaint, I don't have time for an interview," respect that. Two options:

1. Skip to a one-section draft from whatever they said. Show it for review. Submit.
2. Suggest they use the bare `lich feedback "short message"` form instead of going through this skill. That's the right primitive for one-liners — this skill is for the structured-report case.

Don't insist on the full interview if the user wants to keep it short.

### When the user keeps adding more

The opposite problem: the user got into the rhythm of giving feedback and keeps remembering more. This is good signal, but the report gets unwieldy past 8-10 items. After ~6-8 items, suggest:

- "I think we've got a solid report here. Want me to draft this, and you can think about whether to file a separate report later for anything else?"

Bias toward shipping one focused report over batching everything into a sprawling document. The team can read 6 specific items; they can't read 30.

### When you (the agent) noticed the problem, not the user

Agent-triggered case: you were running `lich-instrument` or doing general coding work and noticed the user hit a real rough edge (e.g. `lich validate` errored five times on the same kind of typo, or `lich up` timed out three times in a row).

Open the interview slightly differently:

- "Hey — I noticed you've hit `<specific thing>` three times in a row in the last few minutes. Want to send the lich team a quick note about it while it's fresh? I can help structure it."

Then proceed with the normal interview, but anchor it in the specific problem you observed. You can be more proactive about filling in the technical details (you have them) — your job is mostly to ask the user about intent and severity.

## What NOT to ask

- **"Have you read the docs?"** Comes across as deflective. If the user is confused, that's signal regardless of whether they read the docs.
- **"Did you try restarting?"** Same energy. Not your role in this flow.
- **"Is this reproducible?"** Often yes-but-they-don't-know. If reproduction matters, ask for the command + the error and let the team figure out repro themselves.
- **Twelve clarifying questions before drafting.** Once you have the gist, draft. The user can sharpen the draft.
