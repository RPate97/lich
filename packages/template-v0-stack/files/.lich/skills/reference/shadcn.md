---
name: shadcn
description: shadcn/ui component reference for the lich stack
applies-to: reference
---

# shadcn/ui

shadcn/ui is the component library used by `apps/web`. Components are not an
npm dependency — they're vendored into the repo so you own the source. Edit
them like any other file.

## Adding a component

- Run `lich ui add <component>` to vendor a component into
  `apps/web/src/components/ui/`. Examples: `lich ui add button`,
  `lich ui add dialog`, `lich ui add command`.
- List the catalog of available components with `lich ui list`.
- The command writes the source file, installs any new peer dependencies
  (Radix primitives, `cmdk`, etc.), and updates `components.json` so future
  installs use the right paths.

## Theming

- Colors live as CSS variables in `apps/web/src/app/globals.css` under
  `:root` (light) and `.dark` (dark). Change a brand color by editing the
  HSL triplet in both blocks.
- Tailwind maps these variables via `tailwind.config.ts`
  (`hsl(var(--primary))`). Don't hardcode hex values in components — always
  reference the token (`bg-primary`, `text-muted-foreground`).
- The theme provider lives in `apps/web/src/app/providers.tsx`. Wrap any
  app-wide state in there, not in `layout.tsx`.

## Composition

- shadcn components are intentionally low-level. Compose them into project
  components under `apps/web/src/components/` rather than reaching for the
  primitive every time.
- Use the `cn(...)` helper from `apps/web/src/lib/utils.ts` to merge
  conditional class names — never concatenate strings manually.

## Pitfalls

- Re-running `lich ui add <component>` overwrites your edits unless you
  pass `--no-overwrite`. Commit before re-adding.
