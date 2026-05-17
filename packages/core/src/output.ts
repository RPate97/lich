export type OutputFormat = 'json' | 'pretty';

export function formatOutput(value: unknown, format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
