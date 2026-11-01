/** @jsxImportSource preact */
// The Overview charts, drawn at the element's real size so marks and text are never stretched.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CallPoint } from "../api";
import { compact, duration } from "../ui";

const HEIGHT = 184;
const M = { top: 10, right: 6, bottom: 22, left: 56 };

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The next round number at or above `n` (1, 2, 5 × a power of ten). */
function niceMax(n: number) {
  const power = 10 ** Math.floor(Math.log10(Math.max(n, 1e-6)));
  for (const step of [1, 2, 5, 10]) if (step * power >= n) return step * power;
  return 10 * power;
}

/** Top-rounded column, square where it meets its baseline. */
function column(x: number, y: number, w: number, h: number, round: boolean) {
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x} ${y + h}V${y + r}${r ? `Q${x} ${y} ${x + r} ${y}` : ""}H${x + w - r}${r ? `Q${x + w} ${y} ${x + w} ${y + r}` : ""}V${y + h}Z`;
}

function Frame(props: {
  width: number;
  count: number;
  label: string;
  ticks: { y: number; text: string }[];
  xLabels: { x: number; text: string; anchor: string }[];
  active: number | null;
  setActive: (i: number | null) => void;
  children: ComponentChildren;
}) {
  const { width, count, active, setActive } = props;
  const plotW = Math.max(width - M.left - M.right, 1);
  const pick = (e: PointerEvent) => {
    const box = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left - M.left) / plotW) * count);
    setActive(i >= 0 && i < count ? i : null);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const from = active ?? count;
    setActive(Math.min(count - 1, Math.max(0, from + (e.key === "ArrowLeft" ? -1 : 1))));
  };
  return (
    <svg width={width} height={HEIGHT} role="img" aria-label={props.label} tabIndex={0} onPointerMove={pick} onPointerLeave={() => setActive(null)} onKeyDown={keys} onBlur={() => setActive(null)}>
      {props.ticks.map((t) => (
        <g key={t.text}>
          <line class="axis-line" x1={M.left} x2={width - M.right} y1={t.y} y2={t.y} />
          <text class="axis-text" x={M.left - 8} y={t.y + 4} text-anchor="end">{t.text}</text>
        </g>
      ))}
      {props.xLabels.map((l) => (
        <text key={l.text} class="axis-text" x={l.x} y={HEIGHT - 5} text-anchor={l.anchor}>{l.text}</text>
      ))}
      {props.children}
    </svg>
  );
}

function Tip({ width, x, children }: { width: number; x: number; children: ComponentChildren }) {
  // Flip to the other side of the pointer near the right edge, so the readout stays on screen.
  const flip = x > width - 170;
  return (
    <div class="tip" style={flip ? { right: `${width - x + 10}px` } : { left: `${x + 10}px` }}>
      {children}
    </div>
  );
}

const xLabels = (width: number, points: CallPoint[], stamp: (at: number) => string) => [
  { x: M.left, text: stamp(points[0]!.at), anchor: "start" },
  { x: width - M.right, text: "now", anchor: "end" },
];

/** Calls per bucket: successes, with failures stacked on top so they're never hidden by scale. */
export function CallsChart({ points, unit, stamp }: { points: CallPoint[]; unit: string; stamp: (at: number) => string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const plotH = HEIGHT - M.top - M.bottom;
  const plotW = Math.max(width - M.left - M.right, 1);
  const max = niceMax(Math.max(4, ...points.map((p) => p.ok + p.err)));
  const step = plotW / points.length;
  const barW = Math.max(1, Math.min(24, step > 4 ? step - 2 : step - 1));
  const base = M.top + plotH;
  const total = points.reduce((sum, p) => sum + p.ok + p.err, 0);
  const failed = points.reduce((sum, p) => sum + p.err, 0);
  const point = active === null ? null : points[active];
  return (
    <div class="plot" ref={ref}>
      {width > 0 && (
        <Frame
          width={width}
          count={points.length}
          label={`${total} calls and ${failed} failures ${unit}. Use the left and right arrow keys to read each ${unit === "per second" ? "second" : "minute"}.`}
          ticks={[0, 0.5, 1].map((f) => ({ y: base - f * plotH, text: compact(max * f) }))}
          xLabels={xLabels(width, points, stamp)}
          active={active}
          setActive={setActive}
        >
          {total === 0 && <text class="axis-text plot-empty" x={M.left + plotW / 2} y={M.top + plotH / 4 + 4}>No calls in this range</text>}
          {points.map((p, i) => {
            const x = M.left + i * step + (step - barW) / 2;
            // A failure stays visible however small it is next to the busiest bucket.
            const errH = p.err ? Math.max(2, (p.err / max) * plotH) : 0;
            const okH = p.ok ? Math.max(1, (p.ok / max) * plotH) : 0;
            const gap = errH && okH ? 2 : 0;
            return (
              <g key={p.at} class={active === i ? "mark on" : "mark"}>
                {okH > 0 && <path class="mark-ok" d={column(x, base - okH, barW, okH, !errH)} />}
                {errH > 0 && <path class="mark-err" d={column(x, base - okH - gap - errH, barW, errH, true)} />}
              </g>
            );
          })}
        </Frame>
      )}
      {point && (
        <Tip width={width} x={M.left + active! * step + step / 2}>
          <p class="tip-time">{stamp(point.at)}</p>
          <p><i class="key mark-ok" /><b>{point.ok.toLocaleString()}</b> ok</p>
          <p><i class="key mark-err" /><b>{point.err.toLocaleString()}</b> failed</p>
        </Tip>
      )}
    </div>
  );
}

/** p95 latency per bucket. A bucket with no function runs is a gap, not a zero. */
export function LatencyChart({ points, stamp }: { points: CallPoint[]; stamp: (at: number) => string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const plotH = HEIGHT - M.top - M.bottom;
  const plotW = Math.max(width - M.left - M.right, 1);
  const max = niceMax(Math.max(1, ...points.map((p) => p.p95 ?? 0)));
  const base = M.top + plotH;
  const step = plotW / points.length;
  const xOf = (i: number) => M.left + i * step + step / 2;
  const yOf = (ms: number) => base - (ms / max) * plotH;

  const runs: { i: number; ms: number }[][] = [];
  points.forEach((p, i) => {
    if (p.p95 === null) return;
    const run = runs.at(-1);
    if (run && run.at(-1)!.i === i - 1) run.push({ i, ms: p.p95 });
    else runs.push([{ i, ms: p.p95 }]);
  });
  const line = (run: { i: number; ms: number }[]) => run.map((d, n) => `${n ? "L" : "M"}${xOf(d.i)} ${yOf(d.ms)}`).join("");
  const last = runs.at(-1)?.at(-1);
  const point = active === null ? null : points[active];

  return (
    <div class="plot" ref={ref}>
      {width > 0 && (
        <Frame
          width={width}
          count={points.length}
          label={last ? `95th percentile latency, most recently ${duration(last.ms)}.` : "No function runs in this range."}
          ticks={[0, 0.5, 1].map((f) => ({ y: base - f * plotH, text: f ? duration(max * f) : "0" }))}
          xLabels={xLabels(width, points, stamp)}
          active={active}
          setActive={setActive}
        >
          {runs.length === 0 && <text class="axis-text plot-empty" x={M.left + plotW / 2} y={M.top + plotH / 4 + 4}>No function runs in this range</text>}
          {runs.map((run) => (
            <g key={run[0]!.i}>
              {run.length > 1 && <path class="line-area" d={`${line(run)}L${xOf(run.at(-1)!.i)} ${base}L${xOf(run[0]!.i)} ${base}Z`} />}
              {run.length > 1 && <path class="line-path" d={line(run)} />}
              {run.length === 1 && <circle class="line-dot" cx={xOf(run[0]!.i)} cy={yOf(run[0]!.ms)} r="2.5" />}
            </g>
          ))}
          {active !== null && <line class="crosshair" x1={xOf(active)} x2={xOf(active)} y1={M.top} y2={base} />}
          {point?.p95 != null && <circle class="line-end" cx={xOf(active!)} cy={yOf(point.p95)} r="4" />}
          {active === null && last && <circle class="line-end" cx={xOf(last.i)} cy={yOf(last.ms)} r="4" />}
        </Frame>
      )}
      {point && (
        <Tip width={width} x={xOf(active!)}>
          <p class="tip-time">{stamp(point.at)}</p>
          <p><b>{point.p95 === null ? "No runs" : duration(point.p95)}</b>{point.p95 !== null && " p95"}</p>
        </Tip>
      )}
    </div>
  );
}

/** The same numbers as text, for screen readers: only buckets that had any calls. */
export function ChartTable({ points, stamp }: { points: CallPoint[]; stamp: (at: number) => string }) {
  const rows = points.filter((p) => p.ok + p.err > 0);
  return (
    <table class="sr-only">
      <caption>Calls and latency per time bucket</caption>
      <thead><tr><th>Time</th><th>Succeeded</th><th>Failed</th><th>p95</th></tr></thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.at}><td>{stamp(p.at)}</td><td>{p.ok}</td><td>{p.err}</td><td>{p.p95 === null ? "–" : duration(p.p95)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
