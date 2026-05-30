# Recipes

Patterns past the basics. Each recipe is self-contained — read the ones you need.

- [External CLI services](./external-cli-services) — wrap supabase / dbmate / firebase emulators as oneshot services with stop_cmd
- [Monorepo task runners](./monorepo-task-runners) — run pnpm / turbo / nx scripts via lich commands with the right env loaded
- [Install caching](./install-caching) — make lich init smart about pnpm install / npm ci before every up
- [Test key overrides](./test-key-overrides) — point services at local-dev API keys without leaking prod credentials
- [Worker pools (discover:)](./worker-pools) — fan a service definition out across N workers with the discover block
