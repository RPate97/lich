/**
 * `{{projectName}}` end-to-end auth + todo flow (LEV-196).
 *
 * Drives the dogfood happy-path the README promises: sign-up → land on
 * dashboard → add / toggle / delete a todo → sign out → land back at the
 * landing page or sign-in.
 *
 * Why this test ships in the template (not in `packages/core`'s dogfood
 * suite): it asserts on the SHAPE of the scaffolded app — the names of
 * form fields, the dashboard URL, the existence of an Add / Delete button.
 * Those are user-editable surfaces; keeping the assertion next to the code
 * makes it obvious to anyone changing the dashboard that they also need to
 * update the test.
 *
 * To run: `lich dev` (in another shell) then `bunx playwright test
 * e2e/auth-flow.spec.ts`. The `WEB_URL` env var is set by `lich dev`'s
 * env-file write — source `.lich/state/<key>/env/api.env` or pass
 * `WEB_URL=http://localhost:<port>` explicitly.
 *
 * Note on uniqueness: the test uses a timestamped email
 * (`e2e-<now>@example.com`) so re-running it doesn't trip "user already
 * exists". Don't replace with a fixed email — the api shares one database
 * across runs.
 */
import { test, expect, type Page } from '@playwright/test';

/**
 * Wait for React to attach its event listeners to the form before
 * interacting with it. Next.js renders form HTML server-side first,
 * then hydrates the client bundle. Clicking a submit button BEFORE
 * hydration triggers the browser's default form submit (GET to itself
 * with the inputs in the query string), which is what `/sign-up?email=...`
 * URLs in failing runs look like.
 *
 * React 18 uses a delegated event system rooted on `document` — it does
 * not set DOM `onsubmit` on the form node, so we can't probe the form
 * directly. Instead we probe for the React internal fiber key Next.js's
 * client bundle attaches once hydration runs: any element rendered by
 * React picks up a `__reactProps$<id>` key on hydration. 10s budget
 * covers cold-start TTFB on a slow dev server.
 */
async function waitForFormHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const form = document.querySelector('form');
      if (!form) return false;
      // Any react-fiber-attached prop key starts with `__reactProps$`.
      return Object.keys(form).some((k) => k.startsWith('__reactProps'));
    },
    null,
    { timeout: 10_000 },
  );
}

test('full auth + todo flow', async ({ page }) => {
  const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';
  const uniqueEmail = `e2e-${Date.now()}@example.com`;
  const password = 'pw12345678';

  // 1. Landing page → click "create an account".
  await page.goto(webUrl);
  await page.getByRole('link', { name: /create an account/i }).click();
  await expect(page).toHaveURL(/sign-up/);

  // 2. Submit the sign-up form.
  await waitForFormHydration(page);
  await page.fill('[name=email]', uniqueEmail);
  await page.fill('[name=password]', password);
  await page.click('button[type=submit]');

  // 3. Should land on /dashboard.
  await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });
  await expect(page.getByText(uniqueEmail)).toBeVisible();

  // 4. Add a todo.
  const todoText = 'first todo';
  await page.fill('[name=todo-text]', todoText);
  await page.getByRole('button', { name: /^Add$/ }).click();
  await expect(page.getByText(todoText)).toBeVisible();

  // 5. Toggle the first checkbox to done. We use .click() rather than
  // .check() because the checkbox is a React-controlled component — its
  // `checked` attribute reflects state from the server round-trip the
  // onChange handler kicks off. .check()'s built-in state-changed
  // assertion races against that round-trip; assert separately on the
  // post-refresh state instead.
  await page.getByRole('checkbox').first().click();
  await expect(page.getByRole('checkbox').first()).toBeChecked({ timeout: 10_000 });

  // 6. Delete the todo.
  await page.getByRole('button', { name: /^Delete$/ }).first().click();
  await expect(page.getByText(todoText)).toHaveCount(0, { timeout: 10_000 });

  // 7. Sign out.
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/sign-in|^\/$/, { timeout: 10_000 });
});
