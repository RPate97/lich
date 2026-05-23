import express from "express";
import { supabase } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 4000);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/things", async (_req, res) => {
  const { data, error } = await supabase
    .from("things")
    .select("id, name")
    .order("id", { ascending: true });

  if (error) {
    console.error("[api] supabase error:", error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json(data ?? []);
});

app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
