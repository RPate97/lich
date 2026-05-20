/**
 * `{{projectName}}` landing page.
 *
 * This is the page a user sees the first time they run `levelzero dev` and
 * open the web URL. It exists to replace Next.js's default 404 (or the empty
 * starter) with something that proves the stack is wired up:
 *
 *   - Confirms the api is reachable (server-side fetch to `/api/health`).
 *   - Points at the file to edit to customize the page.
 *   - Names the CLI entry point (`levelzero --help`) for discovery.
 *
 * Renders as an async server component so the api health check happens at
 * request time without any client-side JS. The styling is intentionally
 * vanilla CSS (no Tailwind / no shadcn import) so the page works in a
 * freshly-scaffolded project before the user has run `bunx shadcn add` for
 * anything — adding shadcn components stays an opt-in step (LEV-196).
 */
const API_URL_FALLBACK = 'http://localhost:3001';

async function checkApiHealth(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/health`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

export default async function HomePage() {
  // `API_URL` is the server-side env var injected by `@levelzero/plugin-hono`
  // via the config's `envInjection` block. We fall back to a sensible default
  // so the page still renders if someone runs `next dev` directly without
  // going through `levelzero dev`.
  const apiUrl = process.env.API_URL ?? API_URL_FALLBACK;
  const apiHealthy = await checkApiHealth(apiUrl);

  return (
    <main className="lz-main">
      <header className="lz-header">
        <h1 className="lz-title">{'{{projectName}}'}</h1>
        <p className="lz-subtitle">
          Next.js + Hono + Prisma + Better Auth, wired up by levelzero.
        </p>
      </header>

      <section className="lz-card" aria-labelledby="lz-services">
        <h2 id="lz-services" className="lz-card-title">
          Services
        </h2>
        <p className="lz-card-row">
          <span>api</span>
          <span className={apiHealthy ? 'lz-ok' : 'lz-bad'}>
            {apiHealthy ? 'healthy' : 'unreachable'}
          </span>
          <span className="lz-muted">
            (<a href={apiUrl}>{apiUrl}</a>)
          </span>
        </p>
      </section>

      <section className="lz-card" aria-labelledby="lz-next">
        <h2 id="lz-next" className="lz-card-title">
          Next steps
        </h2>
        <ul className="lz-list">
          <li>
            Edit <code className="lz-code">apps/web/src/app/page.tsx</code> to customize this page.
          </li>
          <li>
            Visit the api at <a href={apiUrl}>{apiUrl}</a>.
          </li>
          <li>
            Run <code className="lz-code">levelzero --help</code> in this project to see available
            commands.
          </li>
        </ul>
      </section>
    </main>
  );
}
