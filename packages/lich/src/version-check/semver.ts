const STRICT_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parse(v: string): [number, number, number] | null {
  const m = STRICT_SEMVER.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function isOutdated(current: string, latest: string): boolean {
  const cmp = compareVersions(current, latest);
  if (cmp === null) return false;
  return cmp < 0;
}
