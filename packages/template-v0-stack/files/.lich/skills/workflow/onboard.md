---
name: onboard
description: How to orient yourself when first encountering a lich project
applies-to: workflow
---

# Onboarding to a lich project

You're looking at this repo for the first time. Spend five minutes on
orientation before touching code — it's faster than guessing wrong and
unwinding the change later.

## 1. Read the map

- Open `CLAUDE.md` at the repo root. It names the stack, the adapter
  choices, and the conventions this project has agreed to. Treat it as
  load-bearing: it overrides anything you'd assume from general knowledge.
- Glance at the `.lich/skills/reference/` directory. Each file is a
  short, opinionated guide for one piece of the stack (Next, Hono, Prisma,
  Tailwind, shadcn). Skim the ones relevant to your task.

## 2. Confirm the environment

- Run `lich stacks current` to see which stack the CLI will target
  from this directory and whether the dev processes are running.
- Run `lich doctor` to surface environment problems — missing
  binaries, registry permission issues, drifted worktree state. Fix any
  errors before doing real work; warnings can wait.

## 3. Read the config

- Open `lich.config.ts` at the project root. It declares the active
  framework adapters (web, api, db, ui) and any project-specific overrides.
  This is the source of truth for which conventions apply.

## 4. Boot it locally

- Start everything with `lich dev` and visit the URLs printed by
  `lich urls`. Seeing the app render once is the cheapest way to
  confirm your local setup is real before you start changing things.
