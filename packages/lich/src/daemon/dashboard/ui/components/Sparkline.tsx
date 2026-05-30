interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Forces the y-axis floor. Defaults to 0 — memory/CPU never go negative. */
  yMin?: number;
  /** Forces the y-axis ceiling. Defaults to max(values) with a 5% headroom. */
  yMax?: number;
  /** Tooltip text. */
  title?: string;
}

/** Tiny dependency-free SVG sparkline. Draws a polyline + faint area fill.
 *  Single-point series collapses to a dot; empty series renders as a flat baseline. */
export function Sparkline({
  values,
  width = 80,
  height = 22,
  color = 'var(--lich-purple-glow)',
  yMin,
  yMax,
  title,
}: SparklineProps) {
  const padding = 1;
  const w = Math.max(20, width);
  const h = Math.max(8, height);

  if (values.length === 0) {
    return (
      <svg
        className="sparkline"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={title ?? 'no data'}
      >
        {title ? <title>{title}</title> : null}
        <line
          x1={padding}
          y1={h / 2}
          x2={w - padding}
          y2={h / 2}
          stroke="var(--border-strong)"
          strokeWidth="1"
          strokeDasharray="2 2"
        />
      </svg>
    );
  }

  // y-axis: explicit overrides win; otherwise auto-range from data with a
  // floor at 0 so a flat zero series doesn't divide by zero below.
  const minVal = yMin ?? 0;
  const observedMax = Math.max(...values);
  const maxVal = yMax ?? Math.max(observedMax, minVal + 1);
  const range = Math.max(1, maxVal - minVal);

  const xStep = values.length > 1 ? (w - padding * 2) / (values.length - 1) : 0;

  const points = values.map((v, i) => {
    const x = padding + i * xStep;
    const norm = (v - minVal) / range;
    const y = h - padding - norm * (h - padding * 2);
    return [x, y] as const;
  });

  if (values.length === 1) {
    const [x, y] = points[0];
    return (
      <svg
        className="sparkline"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={title ?? 'single point'}
      >
        {title ? <title>{title}</title> : null}
        <circle cx={x} cy={y} r="1.6" fill={color} />
      </svg>
    );
  }

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');

  const areaPath =
    `M${points[0][0].toFixed(1)},${(h - padding).toFixed(1)} ` +
    points
      .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ') +
    ` L${points[points.length - 1][0].toFixed(1)},${(h - padding).toFixed(1)} Z`;

  return (
    <svg
      className="sparkline"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={title ?? 'sparkline'}
    >
      {title ? <title>{title}</title> : null}
      <path d={areaPath} fill={color} opacity="0.12" />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
