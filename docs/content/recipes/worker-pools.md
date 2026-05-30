# Monorepo worker pools (`discover:` for N near-identical services)

**When to use this:** the stack has 3+ owned services with the same shape — typically a directory of `*Worker.ts` / `*Processor.ts` / `*Handler.ts` files, each spawned as its own process with the same `ready_when` / `fail_when` / `env`. Hand-writing N owned entries that mostly repeat is the obvious first attempt; the problem is it scales with N (an 11-worker stack → 110+ lines of yaml that all look the same).

The naive workaround — one owned entry wrapping `concurrently` — loses per-worker logs / restart state / health. The fix is a `discover:` block: a single owned entry expands at parse time into N synthetic owned services, each with its own state slot.

```yaml
owned:
  cronjob-workers:
    discover:
      # Glob is relative to discover.cwd (or parent.cwd, or the config dir).
      glob: "src/temporal/workers/*TemporalWorker.ts"
      name_template: "${basename_no_ext | strip_suffix:TemporalWorker | kebab}-worker"
      cmd_template: "pnpm exec nodemon -r ./tsconfigPathsDist.js dist/temporal/workers/${basename_no_ext}.js"
      cwd: apps/cronjob
    # Every field below applies to EVERY discovered instance — write once.
    ready_when:
      log_match: "Temporal worker created successfully|state: 'RUNNING'"
    fail_when:
      log_match: "FATAL|UnhandledPromiseRejection"
    env:
      NODE_ENV: development
```

For `apps/cronjob/src/temporal/workers/{Email,Payment,Cleanup}TemporalWorker.ts`, this materializes into three synthetic owned services: `email-worker`, `payment-worker`, `cleanup-worker`. Each has its own log file, its own restart state, its own dashboard tile — identical to a hand-written owned service.

Adding `BillingTemporalWorker.ts` to the workers dir adds `billing-worker` to the stack on the next `lich up` — no yaml edit.

**Mutual exclusivity:** an entry with `discover:` MUST NOT also set `cmd:` at the entry root — the per-instance command lives on `discover.cmd_template`. `lich validate` rejects the combination.

**Template grammar:** see the [`Glob-based discovery` section in `lich-yaml-spec.md`](./lich-yaml-spec.md#glob-based-discovery-discover) for the full vars + filters reference. The short version: `${basename}`, `${basename_no_ext}`, `${dirname}`, with `| kebab | snake | strip_suffix:X | strip_prefix:X` filters chainable left to right.

**Common mistake:** reaching for `discover:` for two services. The indirection costs more than it saves; write them out. The break-even is around three near-identical services.

**Other common mistake:** writing per-worker `ready_when` / `fail_when` patterns that are subtly different (one worker watches `"Worker started"`, another `"started OK"`). `discover:` applies the parent's shared fields verbatim — if patterns diverge, the workers don't fit a discover block. Either unify the patterns or fall back to per-worker hand-written entries.
