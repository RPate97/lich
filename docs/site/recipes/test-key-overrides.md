# Local-dev test-key overrides

**When to use this:** the app integrates with a service that has "always-pass" test keys for localhost development. Cloudflare Turnstile, Stripe, GitHub OAuth, reCAPTCHA, Auth0, etc. Production keys come from a secret manager (`env_from`); locally you want to override them with the public test keys so the dev flow works without real credentials.

The pattern relies on lich's env precedence: **top-level `env:` literals win over top-level `env_from:`** (and top-level `env_from`'s output gets overwritten by the `env:` literal of the same key). So you can leave the `env_from:` secret-manager pull in place and explicitly override the keys you want test versions of.

```yaml
# env_from runs first and pulls real creds from your secret manager.
env_from:
  - cmd: op item get "myapp-secrets" --format json | jq -r '.fields[] | "\(.label)=\(.value)"'

# Top-level `env:` literals layer on top of env_from and win on key conflict.
env:
  # Cloudflare Turnstile always-pass test key — works for any localhost origin.
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA"
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA"

  # Stripe test-mode publishable key (real key, but explicitly the test one).
  STRIPE_PUBLISHABLE_KEY: "pk_test_..."
  STRIPE_SECRET_KEY: "sk_test_..."

  # GitHub OAuth: a localhost-bound app you registered for dev.
  GITHUB_OAUTH_CLIENT_ID: "Iv1.localhost-dev-only"
  GITHUB_OAUTH_CLIENT_SECRET: "ghp_localhost_dev_only"
```

The precedence rule is the load-bearing piece. From the resolver: top-level `env_from` (step 3) → top-level `env_files` (step 4) → top-level `env` literals (step 5). Later wins, so the `env:` literal overrides whatever value `env_from` produced for the same key. Per-service `env:` (step 11) wins over everything top-level if you want to override per service.

**Common mistake:** moving the override into the secret-manager profile / vault entry so `env_from` returns the test value. That works, but now the secret manager holds dev-only data, the override is invisible from the yaml, and a teammate without secret-manager access can't run the stack at all. Keep the test-key override in `env:` literals — it's documentation as well as configuration.
