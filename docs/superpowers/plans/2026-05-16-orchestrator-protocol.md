# lich Orchestrator Protocol

**Companion to:** [roadmap](2026-05-16-levelzero-roadmap.md) + [spec](../specs/2026-05-16-levelzero-design.md)

The roadmap says *what* gets built. This document says *how I execute it* across all 13 plans without losing the thread. It is the orchestrator's operating manual.

Reading order: this doc first, then the roadmap to see plan boundaries, then the active plan for task-level detail. Linear is the running state.

---

## 1. Roles

- **Orchestrator (me).** Owns the Linear state machine, dispatches subagents, reviews their output, integrates worktrees, surfaces blockers, evolves plans, and reports progress. Does not write feature code directly except for trivial integration patches.
- **Implementer subagents.** Dispatched per Linear ticket into an isolated worktree with the ticket spec and a tight context brief. Run TDD per the plan, commit, report back.
- **User.** Reviews progress, redirects scope, unblocks judgment calls, approves merges to `master` when explicitly requested. Not pinged for routine work.

---

## 2. Linear as the state machine

### Project structure

- **Project:** `v0` (already exists — `https://linear.app/lich/project/v0-f4d26986476e/overview`).
- **Team:** `Lich`.
- **Epic per plan.** One parent issue per plan in the roadmap (13 total). Body: the plan's goal + roadmap link.
- **Task per implementation unit.** Children of the epic, one per task in that plan. Body: the full task spec lifted from the plan doc (so subagents don't need the plan file).
- **Discovery tickets.** Anything found during implementation that isn't in a plan (a bug, a missing convention, a needed refactor) becomes its own ticket, parented to the most-relevant epic. Never smuggled into an in-flight task.

### Statuses (mapped from Lich team defaults)

| Linear status | Meaning in this project |
|---|---|
| `Backlog` | Ticket exists, not yet ready to dispatch (waiting on dependencies). |
| `Todo` | Ready to dispatch (dependencies satisfied, brief is complete). |
| `In Progress` | A subagent is currently working on it OR it is in spec/code review. |
| `Done` | Implementer's commits are merged to `master` AND post-merge verification (typecheck + tests) is green. |
| `Canceled` | Ticket dropped (scope removed, superseded, or never needed). Reason in a comment. |
| `Duplicate` | Reserved for true dupes. Reason in a comment. |

No custom statuses for v0 — Symphony's "Human Review" handoff state is unnecessary while one orchestrator owns end-to-end review.

### Labels

| Label | Purpose |
|---|---|
| `epic` | Marks the per-plan parent issue. |
| `plan-01` … `plan-13` | Cheap filtering by plan. Applied to epic and all child tasks. |
| `discovery` | Ticket created mid-execution, not from the original plan. |
| `blocker` | Ticket is blocking forward progress on another active ticket. |
| `revision` | Spec or plan revision required (signal to update docs in lockstep). |

### Dependency tracking

- **Within a plan:** child tasks usually need the previous task's commits on `master`. Use Linear's `blockedBy` for explicit ordering when it matters.
- **Across plans:** use `blockedBy` between epics for hard ordering (e.g., plan 02 blocked by plan 01). Parallelizable plans (per roadmap §"Parallelization opportunities") have no `blockedBy` link.

### Single source of truth

- Linear holds **scheduling, claim, and completion state** for every unit of work.
- The repo holds **specifications, plans, and code**. Tickets reference these by path, not by copy.
- This document holds **the protocol**. If reality diverges from this document, update this document.
- **No TodoWrite, no scratch checklists.** Asking "what's next?" is always answered by querying Linear.

---

## 3. The execution tick

The orchestrator loop is a tick. One tick = one trip through this sequence. I run a tick continuously in auto mode; if the user pauses, I resume the loop from the same place on next message.

```
1. Reconcile        (close completed work, update statuses)
2. Plan check       (do we have at least N ready tickets to feed dispatch?)
3. Dispatch         (start one subagent in a worktree on the next Todo ticket)
4. Review           (when a subagent reports back, spec-check + quality-check)
5. Integrate        (merge approved worktree to master, run full check, mark Done)
6. Discovery sweep  (record anything noticed during 4–5 as new tickets)
7. Report           (only if meaningful progress; otherwise silent)
```

Detail per step:

### 3.1 Reconcile
- Check Linear for tickets in `In Progress` with no live subagent (orphaned by a previous interruption). Either resume by re-dispatching with the prior commits as context, or roll back the worktree if half-done and re-dispatch.
- Verify the worktrees on disk match what Linear claims is running. Prune orphans.

### 3.2 Plan check
- If active plan has fewer than 3 tickets in `Todo` or `In Progress`, ensure the next plan's epic + tasks are created. Lazy creation: I do not pre-create all 13 plans worth of tickets up front. Plans 02–13 get materialized one plan ahead of consumption.
- If the active plan is finished, advance to the next plan in roadmap order (respecting `blockedBy`). Mark prior epic `Done`.

### 3.3 Dispatch
- Pick the highest-priority `Todo` ticket whose `blockedBy` set is empty or all `Done`.
- Mark it `In Progress`.
- Create a worktree off `master` named `lev-<ticket-key>-<slug>`.
- Dispatch one general-purpose Agent with `isolation: "worktree"`, briefing template in §4.
- Do **not** dispatch a second implementer in parallel within the same plan unless the plan explicitly says tasks are independent. Most aren't.

### 3.4 Review
- Two-stage, performed by me (not by reviewer subagents — cost trade-off):
  1. **Spec compliance:** did the diff implement exactly what the ticket says, no more no less? Are tests in the right places? Do test names match behavior?
  2. **Code quality:** any obvious smells (dead code, unclear names, missing edge-case test, fragile assertion)?
- If both pass: proceed to integrate.
- If spec issues: comment the gap on the ticket, re-dispatch the same subagent with the specific fix list. Loop until spec-clean.
- If quality issues: same pattern. Loop until clean.
- If the implementer reported `BLOCKED` or `NEEDS_CONTEXT`: see §6.

### 3.5 Integrate
- Run `bun tsc --noEmit && bunx vitest run` in the worktree. If red, kick back to the subagent.
- Merge the worktree's branch to `master` with `--ff-only` if possible, otherwise a merge commit.
- Re-run typecheck + tests on `master`. If a regression appears, roll back the merge and reopen the ticket.
- Delete the worktree.
- Mark the ticket `Done`. Comment with the merge commit SHA.

### 3.6 Discovery sweep
- Anything I noticed during 3.4 or 3.5 that wasn't in the spec — a fragile area, a missing test, a doc that needs updating — gets its own ticket with the `discovery` label, parented to the relevant epic. Brief but specific: where, why, what to do.
- Never inflate the current ticket scope to absorb discoveries. Inflation is how plans rot.

### 3.7 Report
Silence is the default. Surface to the user only when:
- A plan finishes (one-line summary + link).
- Something is blocked and I need a decision (§6).
- A revision to the spec or plans is necessary (§7).
- The user asked for status.

---

## 4. Subagent briefing template

Subagents do not read the plan file. I extract everything they need into the brief. The brief is the contract.

```
You are implementing [LEV-N: <title>].

## Workspace
You are running inside a git worktree at <path>. All changes stay inside this directory.
Branch: lev-<ticket-key>-<slug>, based on master.

## Spec
<full task text from the Linear ticket — TDD steps with code blocks per the plan>

## Context
- Project: lich (agent-native dev framework).
- This task is part of [plan-XX: <plan name>] which produces [<plan outcome>].
- Files you may read for context (but not modify outside your task):
  - docs/superpowers/specs/2026-05-16-levelzero-design.md (high-level design)
  - docs/superpowers/plans/2026-05-16-levelzero-roadmap.md (plan order)
- Files you will create/modify: <list>

## Conventions
- TDD strictly: failing test, run-to-confirm-fail, implement, run-to-confirm-pass, commit.
- One commit per task step as the plan specifies. Commits should be small and bisectable.
- Do not modify files outside what the task lists.
- Do not refactor surrounding code (file a discovery note in your report instead).

## Reporting
When done, reply with:
- Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- Files changed (paths only — diff is in git)
- Tests run, results
- Self-review notes
- Discovery notes (things worth a follow-up ticket, see "Conventions")
```

If the subagent asks questions before starting, I answer or revise the brief before letting it proceed. If a subagent reports `NEEDS_CONTEXT`, I provide what was missing and re-dispatch — never let them guess.

---

## 5. Worktree and merge discipline

- **One worktree per ticket.** Created from `master` at dispatch, deleted at merge.
- **Naming:** `lev-<TICKET-KEY>-<short-slug>`. Stored under a sibling directory (`../lich-worktrees/`) to keep the main checkout uncluttered.
- **No long-lived branches.** Plans 02+ would otherwise tempt me into per-plan branches. They're not worth it: review happens per ticket, integration happens per ticket, and a merge commit per ticket is acceptable noise.
- **Linear history preferred.** Try `--ff-only` first; fall back to merge commit. Never `git rebase` shared branches.
- **The repo's `master` is always green.** If a merge introduces red, I revert immediately and reopen the ticket.

---

## 6. Failure and stuck conditions

Mapping from implementer report → orchestrator action:

| Report | Action |
|---|---|
| `DONE` | Proceed to review. |
| `DONE_WITH_CONCERNS` | Read the concerns. If they're real (correctness, scope drift), address before merging. If they're observations (file size, naming) and the spec doesn't require otherwise, accept, file a discovery ticket, continue. |
| `NEEDS_CONTEXT` | Provide the missing piece, re-dispatch the same subagent. Never let them guess. |
| `BLOCKED` (context) | Treat as `NEEDS_CONTEXT`. |
| `BLOCKED` (reasoning) | Re-dispatch with a more capable model. |
| `BLOCKED` (task too large) | Split the ticket into smaller tickets, dispatch the first. |
| `BLOCKED` (plan/spec is wrong) | Pause execution, surface to user. |

Hard stops that pause the loop and ping the user:
- Spec contradiction discovered mid-execution.
- A plan turns out to depend on a tool that doesn't behave as assumed (e.g., Prisma + Bun is broken, requires a stack pick revisit).
- An ambiguity where any choice locks in significant rework.
- Anything destructive that the auto-mode rules require me to confirm.

If I stop the loop, I leave a Linear comment on the active ticket explaining what's blocking, and I do not silently drop work.

---

## 7. Plan and spec evolution

Plans and the spec are not frozen. They evolve as implementation reveals reality:

- **Minor plan revisions** (a step needs an extra commit, a file needs a different name, a test needs an extra case): I edit the plan doc, edit the affected ticket, note the revision in a comment.
- **Cross-plan revisions** (a decision in plan 03 invalidates an assumption in plan 07): I edit both plan docs and the affected tickets, add a `revision` label, summarize in the v0 project description if material.
- **Spec revisions** (something at the principles or stack-pick level changes): pause execution, surface to the user with the proposed change and rationale. Do not unilaterally rewrite the spec.

The repo and Linear stay in lockstep. If a doc edit lands without ticket updates, that's a bug in my orchestration.

---

## 8. Parallelism rules

Default: sequential within a plan. Plans 02–13 have intra-plan dependencies that make parallel dispatch dangerous (file collisions, type contract drift).

Allowed parallelism, per roadmap §"Parallelization opportunities":
- After plan 03 lands, plans 05 (DB/Prisma) and 06 (Auth/Better Auth) can run concurrently.
- Plan 08 (validation tools) can run alongside others once plan 01 lands.
- Plan 10 (UI/browser) can run alongside others after plan 03 lands.
- Plan 12 (skills/docs) can draft alongside implementation.

When I dispatch concurrent implementers, each is in its own worktree and they touch disjoint file trees by design. Merges happen one at a time on `master` to keep integration straightforward.

I never dispatch two implementers against tickets in the same plan in parallel.

---

## 9. Cadence and continuity

In auto mode I run continuously: each tick rolls into the next without prompting the user. Across sessions, the loop is durable because state lives in Linear and git:

- **Picking up after a pause:** read Linear filtered by `In Progress` and by the active epic. Reconcile (§3.1). Resume at dispatch.
- **Crash mid-task:** the subagent's worktree commits are recoverable. If the subagent died mid-step, roll the worktree back to the last clean commit and re-dispatch with a note about the failed step.
- **Cross-session continuity:** every Linear ticket in `In Progress` has a comment from the orchestrator naming the worktree path. That comment is how a fresh orchestrator session re-attaches.

I do **not** poll Linear or sleep in auto mode. A tick runs immediately after the previous one resolves. Sleeping only matters if I'm waiting on something out-of-process (none of this is out-of-process today).

---

## 10. Termination

v0 is complete when:
- Every plan epic is `Done`.
- The full verification checklist for each plan has been confirmed on `master`.
- The CLAUDE.md generated by plan 12's skills surfaces every shipped skill.
- A clean `bun install && bun /tools/cli/src/bin.ts init <tmp> && bun /tools/cli/src/bin.ts dev` works on a fresh machine.

At that point I summarize, hand off to the user, and stop.

---

## 11. Open orchestration questions (not blocking dispatch)

Recorded here so they don't get lost. Each is fine to answer empirically as the project unfolds:

- Should reviewer-subagent dispatches replace inline review at any point (e.g., once the codebase gets large enough that inline review pollutes orchestrator context)? Re-evaluate at end of plan 03.
- Should I create all of plan N+1's tickets at the end of plan N, or lazily as plan N completes? Currently: lazy.
- Should "discovery" tickets be triaged into their own backlog plan, or interleaved with the active plan? Currently: parented to the relevant epic, sorted by priority alongside planned tasks.
- Worktree storage location: sibling dir vs. `.worktrees/` inside the main repo. Currently: sibling.
