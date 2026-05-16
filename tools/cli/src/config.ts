export interface LevelzeroConfig {
  name?: string;
  // Adapter slots and services land in later plans. Keep this surface
  // minimal in plan 01 — every later plan extends it via module
  // declaration merging or interface extension.
}

export async function loadConfig(configPath: string): Promise<LevelzeroConfig> {
  // Dynamic import works under Bun for .ts files natively. Use a cache-busting
  // query so successive loads in a single process pick up edits during tests.
  const url = `file://${configPath}?t=${Date.now()}`;
  const mod = (await import(url)) as { default?: LevelzeroConfig };
  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(
      `levelzero config at ${configPath} has no default export (expected: \`export default { ... }\`)`,
    );
  }
  return mod.default;
}
