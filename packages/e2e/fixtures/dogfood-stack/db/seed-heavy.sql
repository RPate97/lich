-- Heavy seed: ~50,000 rows in the things table.
-- Each row is ~1KB. Cumulative INSERT takes meaningful wall time;
-- the point is to give postgres a realistic working set that warm-fork
-- preserves through snapshot/restore.

INSERT INTO things (name, description)
SELECT
  'thing-' || gs::text,
  repeat('data ', 200)
FROM generate_series(1, 50000) gs;
