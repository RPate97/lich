/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // LEV-196 — expose the api URL to client components so the auth client
  // (which runs in the browser) can hit the api directly. We re-export the
  // server-side `API_URL` env var (set by `@lich/plugin-hono`'s
  // `envInjection`) under a `NEXT_PUBLIC_*` name so Next.js inlines it into
  // the client bundle at build time.
  env: {
    NEXT_PUBLIC_API_URL: process.env.API_URL ?? 'http://localhost:3001',
  },
};

module.exports = nextConfig;
