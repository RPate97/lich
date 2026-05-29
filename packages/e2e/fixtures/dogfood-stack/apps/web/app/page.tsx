type Thing = { id: number; name: string };

type ThingsResult =
  | { kind: "ok"; things: Thing[] }
  | { kind: "no-db"; hint: string }
  | { kind: "error"; status: number; message: string };

async function getThings(): Promise<ThingsResult> {
  const apiUrl = process.env.API_URL || "http://localhost:4000";
  const res = await fetch(`${apiUrl}/api/things`, { cache: "no-store" });
  if (res.status === 503) {
    // dev:fast profile: API has no DATABASE_URL, /api/things 503s with
    // a hint. Render a friendly placeholder rather than crashing.
    const body = (await res.json()) as { error: string; hint?: string };
    return { kind: "no-db", hint: body.hint ?? body.error };
  }
  if (!res.ok) {
    return { kind: "error", status: res.status, message: await res.text() };
  }
  return { kind: "ok", things: (await res.json()) as Thing[] };
}

export default async function Page() {
  const result = await getThings();
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Things from the API</h1>
      {result.kind === "ok" && (
        <ul>
          {result.things.map((t) => (
            <li key={t.id}>
              {t.id}: {t.name}
            </li>
          ))}
        </ul>
      )}
      {result.kind === "no-db" && (
        <p style={{ color: "#666" }}>
          <em>No database configured.</em> {result.hint}
        </p>
      )}
      {result.kind === "error" && (
        <p style={{ color: "crimson" }}>
          API error ({result.status}): {result.message}
        </p>
      )}
    </main>
  );
}
