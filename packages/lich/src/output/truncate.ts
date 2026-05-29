/**
 * Spinner-line truncation. Phase names like `start 2/2 (api, web, ...)`
 * can exceed terminal width and cause the redraw to wrap — graceful
 * degradation in four tiers: full, list-with-`… +N more`, count form,
 * hard truncate. Pure helper; pretty renderer calls it every tick.
 */

// `⠼ ` = one braille glyph + one space. ANSI escapes don't count as cells.
const SPINNER_PREFIX_WIDTH = 2;

/** Fallback when `process.stdout.columns` is undefined (piped, no TTY). */
export const DEFAULT_COLUMNS = 80;

/** Fit a spinner phase-name into `columns` total terminal cells (prefix + name); returns the original when it already fits. */
export function truncateSpinnerName(name: string, columns: number): string {
  // Defensive against pathological column counts.
  const totalWidth =
    Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_COLUMNS;
  const available = Math.max(1, totalWidth - SPINNER_PREFIX_WIDTH);

  if (name.length <= available) return name;

  const parsed = parseListGroup(name);

  if (parsed !== null) {
    const { prefix, items } = parsed;

    // Tier 2: keep a leading subset of items, swap the rest for
    // `… +N more`. Require at least one named item to remain — else
    // the bare count form below is clearer.
    for (let keep = items.length - 1; keep >= 1; keep--) {
      const more = items.length - keep;
      const candidate = `${prefix}(${items.slice(0, keep).join(", ")}, … +${more} more)`;
      if (candidate.length <= available) return candidate;
    }

    // Tier 3: count form (`start 2/2 (11 items)`) for very narrow terminals.
    const countLabel = `${items.length} ${items.length === 1 ? "item" : "items"}`;
    const countForm = `${prefix}(${countLabel})`;
    if (countForm.length <= available) return countForm;
  }

  // Tier 4: hard-truncate. `available` is guaranteed >=1.
  if (available <= 1) return name.slice(0, available);
  return `${name.slice(0, available - 1)}…`;
}

interface ParsedListGroup {
  prefix: string;
  items: string[];
}

/** Pull a trailing `(a, b, c)` group off a name. Conservative — only matches when the parens are the last tokens. */
function parseListGroup(name: string): ParsedListGroup | null {
  if (!name.endsWith(")")) return null;
  const openIdx = name.lastIndexOf("(");
  if (openIdx < 0) return null;
  // Empty body — nothing to truncate, hard-cut instead.
  const inside = name.slice(openIdx + 1, name.length - 1).trim();
  if (inside.length === 0) return null;
  const items = inside.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length === 0) return null;
  return { prefix: name.slice(0, openIdx), items };
}
