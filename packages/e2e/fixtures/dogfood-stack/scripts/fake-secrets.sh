#!/usr/bin/env bash
# Stand-in for a secret-manager CLI (infisical / op / doppler / aws secretsmanager).
# Real users would shell out to one of those here; we emit static dotenv lines so
# e2e assertions can pin exact values. Shared across LEV-469 (top-level env_from)
# and LEV-470 (`from-cmd-secrets` env_group), so KEEP THE OUTPUT STABLE — both
# consumers assert on these exact key/value pairs.

set -euo pipefail

echo "FAKE_SECRET_TOKEN=abc123"
echo "FAKE_SECRET_REGION=us-east-1"
