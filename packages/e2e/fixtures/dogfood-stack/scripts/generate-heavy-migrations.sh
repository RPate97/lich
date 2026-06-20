#!/usr/bin/env bash
# Generates ~500 synthetic migrations under db/migrations-heavy/.
# Each migration is small individually but their cumulative apply-time
# simulates a long-running codebase's migration history.
set -euo pipefail

OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/db/migrations-heavy"
COUNT="${MIGRATION_COUNT:-500}"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.sql

for i in $(seq 1 "$COUNT"); do
  num=$(printf "%04d" "$i")
  cat > "$OUT_DIR/${num}_synthetic.sql" <<SQL
-- Synthetic migration ${num}: adds a column, creates an index.
ALTER TABLE things ADD COLUMN col_${num} TEXT;
CREATE INDEX idx_things_col_${num} ON things (col_${num});
SQL
done

echo "Generated ${COUNT} migrations in $OUT_DIR"
