import express from "express";
import { dbAvailable, sql } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 4000);

// /health returns the DB mode so callers (especially e2e tests via the
// expectDbMode helper) can verify the active profile matches expectations.
//   db: "live"  → DATABASE_URL set, sql client constructed
//   db: "stub"  → DATABASE_URL empty (dev:fast profile)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", db: dbAvailable() ? "live" : "stub" });
});

app.get("/api/things", async (_req, res) => {
  if (!dbAvailable()) {
    return res.status(503).json({
      error: "DATABASE_URL not configured",
      hint: "This stack is running under the dev:fast profile. Use `lich up dev` for the full DB-backed stack.",
    });
  }
  try {
    // Bun.sql tagged template — parameter-safe.
    const rows = await sql!`select id, name from public.things order by id asc`;
    res.json(rows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api] postgres error:", message);
    res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
