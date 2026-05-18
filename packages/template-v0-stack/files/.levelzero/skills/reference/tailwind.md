---
name: tailwind
description: Tailwind CSS reference for the levelzero stack
applies-to: reference
---

# Tailwind

Tailwind powers all styling in `apps/web`. Config lives at
`apps/web/tailwind.config.ts` and the global stylesheet at
`apps/web/src/app/globals.css`. Never write raw CSS for component styling —
extend the config or compose utilities instead.

## Utility-first conventions

- Write utilities directly in JSX; reserve `@apply` for one or two recurring
  patterns in `globals.css` (typography resets, focus rings).
- Order classes consistently: layout, then box-model, then typography, then
  color, then state variants. Use the `prettier-plugin-tailwindcss` ordering
  if installed.
- Extract a component (not a `@apply` class) when the same five-plus
  utilities repeat across files.

## Config customization

- Extend the theme via `theme.extend` — never overwrite `theme` directly or
  you lose Tailwind's defaults.
- Add design tokens (brand colors, radii, spacing) under `theme.extend.colors`
  etc., and reference them through the shadcn CSS variables so dark mode
  works for free.
- Whitelist additional content paths in `content: [...]` when adding new
  packages so their classes survive JIT purge.

## Dark mode

- The config uses `darkMode: 'class'`. Toggle by adding/removing `dark` on
  `<html>`; shadcn's theme provider handles this automatically.
- Always pair a light utility with its `dark:` counterpart
  (`bg-white dark:bg-slate-950`). Test both themes before committing.

## Pitfalls

- Dynamic class names like `bg-${color}-500` are purged. Map to a full
  class via a lookup object, or safelist the variants in the config.
