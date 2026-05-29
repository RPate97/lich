// Postgres client for the dogfood-stack API. Tolerates the dev:fast
// profile, which intentionally doesn't run postgres (DATABASE_URL is
// empty). Routes that need the DB MUST guard with `dbAvailable()` and
// 503 if false — see ./index.ts for the pattern.
//
// Background: pre-LEV-463 this file used @supabase/supabase-js with a
// hardcoded localhost fallback. LEV-463 migrated to Bun.sql with a
// throw-on-missing. The solid+fast e2e plan softens that throw to a
// `null` so the API can serve /health (and any non-DB routes) under
// dev:fast.
import { SQL } from "bun";

const url = process.env.DATABASE_URL ?? "";

export const sql = url.length > 0 ? new SQL(url) : null;

export function dbAvailable(): boolean {
  return sql !== null;
}
