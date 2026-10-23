/**
 * The dashboard's charts: plain SVG, sized to their container.
 *
 * Each chart shows one measure, so one colour: warm ink bars, Beharry red on
 * the bar under the pointer. Thin marks with 4px rounded ends on the baseline,
 * a 2px gap between bars, a recessive grid with a few round ticks, a tooltip
 * on hover and focus, and a table of the same numbers for screen readers.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

const INK = "#3b3330";
const HOVER = "#ed2c25";
const GRID = "#ede8e6";
const AXIS = "#d6cfcc";
const MUTED = "#8a807c";

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A round top for the axis, and the ticks under it: 0, ⅓, ⅔, max. */
function niceScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { top, ticks };
}

export interface Column {
  label: string;
  /** Shorter label under the axis; omit to skip it (crowded axes). */
  tick?: string;
  value: number;
  /** Lines in the tooltip. The first is the heading. */
  tip: string[];
}

export function ColumnChart({
  data,
  height = 220,
  format,
  title,
  valueLabel,
}: {
  data: Column[];
  height?: number;
  format: (v: number) => string;
  title: string;
  valueLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const left = 56;
  const bottom = 24;
  const top = 8;
  const plotW = Math.max(0, width - left - 4);
  const plotH = height - bottom - top;
  const { top: maxV, ticks } = niceScale(Math.max(0, ...data.map((d) => d.value)));
  const slot = data.length ? plotW / data.length : 0;
  const gap = Math.max(2, Math.min(8, slot * 0.25));
  const barW = Math.max(1, slot - gap);
  const y = (v: number) => top + plotH - (v / maxV) * plotH;
  const hovered = hover != null ? data[hover] : null;

  return (
    <figure className="relative m-0" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={title} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - 4} y1={y(t)} y2={y(t)} stroke={t === 0 ? AXIS : GRID} strokeWidth={1} />
              <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={MUTED} style={{ fontVariantNumeric: "tabular-nums" }}>
                {format(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = left + i * slot + gap / 2;
            const h = Math.max(0, y(0) - y(d.value));
            const r = Math.min(4, barW / 2, h);
            return (
              <g key={d.label}>
                {/* Data end rounded, baseline end square: the bar sits on the axis. */}
                {h > 0 && (
                  <path
                    d={`M${x},${y(0)} V${y(d.value) + r} Q${x},${y(d.value)} ${x + r},${y(d.value)} H${x + barW - r} Q${x + barW},${y(d.value)} ${x + barW},${y(d.value) + r} V${y(0)} Z`}
                    fill={hover === i ? HOVER : INK}
                  />
                )}
                {d.tick && (
                  <text x={x + barW / 2} y={height - 6} textAnchor="middle" fontSize={11} fill={MUTED}>
                    {d.tick}
                  </text>
                )}
                {/* A hit target the full height of the slot, bigger than the mark. */}
                <rect
                  x={left + i * slot}
                  y={top}
                  width={slot}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${d.label}: ${format(d.value)}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  style={{ outline: "none", cursor: "default" }}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hovered && hover != null && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lg"
          style={{ left: Math.min(Math.max(left + hover * slot + slot / 2, 80), width - 80), top: Math.max(0, y(hovered.value) - 70) }}
        >
          {hovered.tip.map((line, i) => (
            <div key={i} className={i === 0 ? "font-semibold text-ink" : "text-muted tnum"}>
              {line}
            </div>
          ))}
        </div>
      )}
      <ScreenReaderTable caption={title} head={["", valueLabel]} rows={data.map((d) => [d.label, format(d.value)])} />
    </figure>
  );
}

export interface Bar {
  key: string;
  label: ReactNode;
  /** Plain-text label, for the table and the tooltip. */
  text: string;
  value: number;
  /** The figure shown at the bar's end. */
  display: string;
  detail?: string;
  muted?: boolean;
}

/** Horizontal bars, labelled at the end: for a handful of named things, like stores. */
export function BarList({ data, title, valueLabel }: { data: Bar[]; title: string; valueLabel: string }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  const [hover, setHover] = useState<string | null>(null);
  return (
    <figure className="m-0">
      <ul className="flex flex-col gap-3" aria-label={title}>
        {data.map((d) => (
          <li
            key={d.key}
            className={`grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-3 ${d.muted ? "opacity-55" : ""}`}
            onMouseEnter={() => setHover(d.key)}
            onMouseLeave={() => setHover(null)}
            title={d.detail ? `${d.text}: ${d.display}. ${d.detail}` : `${d.text}: ${d.display}`}
          >
            <div className="min-w-0">{d.label}</div>
            <div className="flex min-w-0 items-center gap-2">
              <div className="h-5 min-w-0 flex-1">
                <div
                  className="h-full rounded-r transition-colors"
                  style={{ width: `${max > 0 ? Math.max(d.value > 0 ? 1.5 : 0, (d.value / max) * 100) : 0}%`, background: hover === d.key ? HOVER : INK }}
                />
              </div>
              <span className="w-28 shrink-0 text-right text-sm font-semibold tnum">{d.display}</span>
            </div>
          </li>
        ))}
      </ul>
      <ScreenReaderTable caption={title} head={["", valueLabel]} rows={data.map((d) => [d.text, d.display])} />
    </figure>
  );
}

function ScreenReaderTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
