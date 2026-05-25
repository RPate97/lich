import express from "express";
import { sql } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 4000);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/things", async (_req, res) => {
  try {
    // Bun.sql tagged template — parameter-safe (no values interpolated here
    // anyway, but the pattern is the same for queries that take args).
    const rows = await sql`select id, name from public.things order by id asc`;
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
