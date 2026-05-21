import type { ReactNode } from 'react';

/**
 * Root layout for the `{{projectName}}` Next.js app.
 *
 * Ships with a small inline stylesheet that gives the scaffolded landing
 * page (`page.tsx`) a presentable look out of the box — system font, dark
 * mode via `prefers-color-scheme`, and the `.lz-*` utility classes the
 * landing page references. The stylesheet is intentionally tiny and inline
 * (no external CSS file, no Tailwind) so the template stays "works on
 * `bun install && bun run dev`" without first requiring `bunx shadcn add`.
 * Customizing layout/typography is one of the first things users do — feel
 * free to throw all of this out once you've installed shadcn or your
 * preferred CSS setup.
 */
export const metadata = {
  title: '{{projectName}}',
  description: 'A {{projectName}} app built with levelzero.',
};

const LANDING_CSS = `
  :root {
    color-scheme: light dark;
    --lz-fg: #111;
    --lz-bg: #fff;
    --lz-muted: #6b7280;
    --lz-card-bg: #f8f9fa;
    --lz-card-border: #e5e7eb;
    --lz-code-bg: #eef0f2;
    --lz-ok: #15803d;
    --lz-bad: #b91c1c;
    --lz-link: #2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --lz-fg: #f3f4f6;
      --lz-bg: #0b0d10;
      --lz-muted: #9ca3af;
      --lz-card-bg: #15181d;
      --lz-card-border: #262a31;
      --lz-code-bg: #1f242b;
      --lz-ok: #4ade80;
      --lz-bad: #f87171;
      --lz-link: #93c5fd;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--lz-bg);
    color: var(--lz-fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    line-height: 1.5;
  }
  a { color: var(--lz-link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .lz-main {
    max-width: 42rem;
    margin: 0 auto;
    padding: 3rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .lz-header { display: flex; flex-direction: column; gap: 0.25rem; }
  .lz-title { font-size: 1.875rem; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
  .lz-subtitle { color: var(--lz-muted); margin: 0; }
  .lz-card {
    background: var(--lz-card-bg);
    border: 1px solid var(--lz-card-border);
    border-radius: 0.75rem;
    padding: 1.25rem 1.5rem;
  }
  .lz-card-title {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 0.75rem 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--lz-muted);
  }
  .lz-card-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
  }
  .lz-list { margin: 0; padding-left: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .lz-code {
    background: var(--lz-code-bg);
    border-radius: 0.25rem;
    padding: 0.1rem 0.35rem;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.9em;
  }
  .lz-muted { color: var(--lz-muted); font-size: 0.875rem; }
  .lz-ok { color: var(--lz-ok); font-weight: 600; }
  .lz-bad { color: var(--lz-bad); font-weight: 600; }

  /* LEV-196 — extra utilities for the sign-in / sign-up / dashboard pages.
     Same inline-CSS approach as above so the template stays runnable without
     "bunx shadcn add". Replace these once you've installed your preferred
     component library. */
  .lz-form { display: flex; flex-direction: column; gap: 0.75rem; }
  .lz-field { display: flex; flex-direction: column; gap: 0.25rem; }
  .lz-label { font-size: 0.875rem; font-weight: 600; color: var(--lz-muted); }
  .lz-input {
    background: var(--lz-bg);
    color: var(--lz-fg);
    border: 1px solid var(--lz-card-border);
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    font: inherit;
  }
  .lz-input:focus { outline: 2px solid var(--lz-link); outline-offset: -1px; }
  .lz-button {
    background: var(--lz-link);
    color: white;
    border: none;
    border-radius: 0.5rem;
    padding: 0.5rem 1rem;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .lz-button:hover { filter: brightness(1.1); }
  .lz-button[disabled] { opacity: 0.6; cursor: not-allowed; }
  .lz-button-secondary {
    background: transparent;
    color: var(--lz-fg);
    border: 1px solid var(--lz-card-border);
  }
  .lz-button-danger { background: var(--lz-bad); }
  .lz-error { color: var(--lz-bad); font-size: 0.875rem; margin: 0; }
  .lz-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--lz-card-border);
  }
  .lz-row:last-child { border-bottom: none; }
  .lz-row-text { flex: 1; }
  .lz-row-text.lz-done { text-decoration: line-through; color: var(--lz-muted); }
  .lz-stack { display: flex; flex-direction: column; gap: 1rem; }
  .lz-inline { display: flex; gap: 0.5rem; align-items: center; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: LANDING_CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
