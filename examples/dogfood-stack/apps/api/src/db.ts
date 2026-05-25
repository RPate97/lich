// LEV-463: was @supabase/supabase-js → now raw postgres via Bun.sql.
// DATABASE_URL is interpolated by lich from `${services.postgres.host_port}`
// (see ../../lich.yaml env block). The query in src/index.ts uses tagged
// templates for parameter binding; this file just exports the client.
import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) {
  // Surface immediately rather than waiting for the first query to fail —
  // the connection-string-missing case has a clearer error here than a
  // generic "ECONNREFUSED localhost:5432" later.
  throw new Error("[api] DATABASE_URL is not set; cannot connect to postgres");
}

export const sql = new SQL(url);
