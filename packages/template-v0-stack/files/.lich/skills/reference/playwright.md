---
name: playwright
description: Playwright e2e test reference for the lich stack
applies-to: reference
---

# Playwright

Playwright drives every end-to-end test in the stack. The config lives at
`apps/web/playwright.config.ts` and tests live under `apps/web/e2e/`. Run
the suite with `lich test e2e`, which first boots the stack
(`lich dev`) and waits for the URLs from `lich urls` to respond.

## Test layout

- One file per user-visible flow (`signup.spec.ts`, `dashboard.spec.ts`),
  not one per page. Tests should narrate a journey, not a page tour.
- Use the `test.describe.parallel(...)` block to run independent flows
  concurrently; sequential blocks should be the exception.

## Page objects

- Wrap reusable selectors and actions in a class under
  `apps/web/e2e/pages/`. A page object exposes intent
  (`await login.signInAs(user)`) — not raw locators.
- Prefer `page.getByRole(...)` and `page.getByLabel(...)` over CSS
  selectors. They survive markup churn and double as accessibility checks.

## Fixtures

- Extend the base `test` with project fixtures in
  `apps/web/e2e/fixtures.ts`: a `signedInPage`, a seeded `user`, a clean
  database snapshot. Tests opt in by destructuring what they need.
- Seed test data via the API (`auth.api.signInEmail`, Hono routes), not
  through the UI — UI seeding is slow and flaky.

## Visual regression

- Use `lich screenshot <url>` to capture a baseline outside the test
  suite, then compare with `lich visual.diff <a.png> <b.png>` in CI
  to surface unintended visual changes.

## Pitfalls

- `page.waitForSelector` masks race conditions; use `expect(locator).toBeVisible()`
  with its built-in retry instead.
- Network mocks via `page.route(...)` persist across navigations; clear
  them in `afterEach` to avoid leaking state.
