/**
 * Levenshtein edit distance + "did you mean" helpers.
 *
 * Threshold has two gates: a hard cap of {@link MAX_SUGGESTION_DISTANCE}
 * (3) and a per-input length scale (`max(1, floor(len/3))`). Both must
 * pass. This keeps very short typos (`tcp` vs. `tpc`) suggesting via the
 * floor of 1, while a 9-char input gets up to 3 edits of leeway.
 */

/** Hard cap so unrelated tokens (`frob` vs. `services`) produce no hint. */
export const MAX_SUGGESTION_DISTANCE = 3;

/** Two-row DP. O(|a|·|b|) time, O(min(|a|,|b|)) space. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution / no-op
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Candidates within the threshold and tied at the smallest distance,
 * in `allowed`-order (matters for Ajv `propertyNames` which iterates
 * in schema-declared order).
 */
export function findCloseMatches(
  unknown: string,
  allowed: readonly string[],
): string[] {
  if (allowed.length === 0) return [];

  const lengthThreshold = Math.max(1, Math.floor(unknown.length / 3));
  const threshold = Math.min(MAX_SUGGESTION_DISTANCE, lengthThreshold);

  let bestDist = Infinity;
  const candidates: Array<{ name: string; dist: number }> = [];
  for (const candidate of allowed) {
    const d = levenshtein(unknown, candidate);
    if (d > threshold) continue;
    if (d < bestDist) bestDist = d;
    candidates.push({ name: candidate, dist: d });
  }

  if (bestDist === Infinity) return [];

  const tied: string[] = [];
  for (const c of candidates) {
    if (c.dist === bestDist) tied.push(c.name);
  }
  return tied;
}

/**
 * Render a `did you mean` hint suffix. Returns `null` when no candidate
 * is close enough; otherwise a string starting with ` — ` and ending
 * with `?`, ready to splice onto an existing error message.
 */
export function suggestProperty(
  unknown: string,
  allowed: readonly string[],
): string | null {
  const matches = findCloseMatches(unknown, allowed);
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return ` — did you mean "${matches[0]}"?`;
  }
  return ` — did you mean one of: ${matches.join(", ")}?`;
}
