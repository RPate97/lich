# CLEANUP-HINTS

Small refactor opportunities that aren't worth their own ticket but should
get picked up the next time someone is already in the neighborhood. The
point of this file is to make the cleanup happen at the right moment, by
the right person, with the right context — not to file standalone "extract
shared helper" tickets that languish in the backlog.

If you touch one of the files listed below, do the documented cleanup as
part of your real task. If you're just reading the code, leave it alone.

---

## Hint 1: dotenv parser is duplicated

`packages/lich/src/env/files.ts` (LEV-278) and
`packages/lich/src/env/shell-out.ts` (LEV-279) both contain ~30-line
inline dotenv parsers with identical semantics (KEY=value, quoted values,
escapes, export prefix, blank/`#` lines). They were duplicated
deliberately because the two tasks were dispatched in parallel and the
agents couldn't safely import from each other.

**If you touch either file, extract the parser into**
`packages/lich/src/env/parse-dotenv.ts` **and have both callers import
from there.**

Most likely trigger: Plan 2 `env_groups` work, which will touch `env/`
extensively.

---

## Hint 2: spawn helper could be shared between lifecycle executors

`packages/lich/src/lifecycle/executor.ts` (LEV-286, top-level hooks) and
`packages/lich/src/lifecycle/per-service.ts` (LEV-287, per-service hooks)
each duplicate ~30 lines of `child_process.spawn` + ring-buffer stderr
capture + exit handling. Same dispatch-parallelism reason as Hint 1.

**If you touch either file, extract** `packages/lich/src/lifecycle/spawn.ts`
**with a** `spawnAndCapture` **helper and have both consumers use it.**

Most likely trigger: Plan 4 failure surfacing, which extends lifecycle
behavior; or Plan 6 cleanup.
