async function getThings(): Promise<{ id: number; name: string }[]> {
  const apiUrl = process.env.API_URL || "http://localhost:4000";
  const res = await fetch(`${apiUrl}/api/things`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

export default async function Page() {
  const things = await getThings();
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Things from the API</h1>
      <ul>
        {things.map((t) => (
          <li key={t.id}>
            {t.id}: {t.name}
          </li>
        ))}
      </ul>
    </main>
  );
}
