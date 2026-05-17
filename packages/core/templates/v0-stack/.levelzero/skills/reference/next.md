---
name: next
description: Next.js 14 App Router reference for the levelzero stack
applies-to: reference
---

# Next.js

The web app lives at `apps/web` and uses the Next 14 App Router. The dev
server is started by `levelzero dev`; visit URLs printed by `levelzero urls`.
Take a screenshot of any rendered page with `levelzero screenshot <path>`.

## Routing conventions

- Routes live under `apps/web/src/app/`. `page.tsx` is the route, `layout.tsx`
  wraps everything below it, `loading.tsx` is the Suspense fallback, and
  `error.tsx` is the error boundary.
- Dynamic segments use `[id]` (single) and `[...slug]` (catch-all). Route
  groups use `(group-name)` to share a layout without affecting the URL.
- Co-locate route-specific components under the route folder, not in a
  global `components/` directory. Hoist only when reused across routes.

## Server vs client components

- Files default to server components. Add `'use client'` only when the
  component uses hooks, browser APIs, or event handlers.
- Pass server-fetched data to client components as props — never import a
  server-only module from a `'use client'` file or the build will fail.
- Keep client component trees small; move state to the leaf so the rest of
  the page stays static and streamable.

## Data fetching

- `fetch()` inside server components is cached by default. Pass
  `{ cache: 'no-store' }` for per-request data or
  `{ next: { revalidate: N } }` for ISR.
- Call the Hono API from server components using the shared `hc` client so
  responses are typed.

## Pitfalls

- Mutating state in a server action requires `revalidatePath` or
  `revalidateTag` to refresh the UI.
- `'use server'` files must only export async functions.
