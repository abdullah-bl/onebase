/** @jsxImportSource preact */
// Small shared pieces: formatting, JSON viewer, badges, toasts.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { live, on } from "./api";

// ---------- formatting ----------

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function duration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ${Math.round(s % 60)}s`;
  const h = m / 60;
  if (h < 48) return `${Math.floor(h)}h ${Math.round(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}

export function ago(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const text =
    abs < 5_000 ? "now" : abs < 60_000 ? `${Math.round(abs / 1000)}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  if (text === "now") return "just now";
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

/** 1,284 / 12.9K / 4.2M: whole numbers stay exact until they stop fitting. */
export function compact(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** An error share that never rounds a real failure down to 0%. */
export function percent(part: number, whole: number): string {
  if (!whole || !part) return "0%";
  const p = (part / whole) * 100;
  if (p < 0.1) return "<0.1%";
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/** Runs `fn` at most once per `ms`, and once more after the last call so the final state always lands. */
export function throttle(fn: () => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  const throttled = () => {
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return throttled;
}

export const fullTime = (ts: number) => new Date(ts).toLocaleString();
export const clockTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });

/** Re-renders every `ms` so relative times stay fresh. */
export function useTick(ms = 5000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** The shared stats, metrics and scheduler summary; re-renders when any of them refresh. */
export function useLive() {
  const [, set] = useState(0);
  useEffect(() => on("live", () => set((n) => n + 1)), []);
  return live;
}

/** A callback that always sees the latest render, for long-lived subscriptions. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Makes a clickable table row reachable and usable from the keyboard. */
export function rowLink(action: () => void) {
  return {
    tabIndex: 0,
    onClick: action,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.target === e.currentTarget) action();
    },
  };
}

// ---------- JSON ----------

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export function JsonView({ value, class: cls }: { value: unknown; class?: string }) {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<span class={m[2] ? "j-key" : "j-str"}>{m[1]}</span>, m[2] ?? "");
    else if (m[3]) parts.push(<span class="j-lit">{m[3]}</span>);
    else parts.push(<span class="j-num">{m[4]}</span>);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <pre class={`json ${cls ?? ""}`}>{parts}</pre>;
}

/** One-line preview of a value for table cells. */
export function preview(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  const s = JSON.stringify(value);
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

// ---------- validators → hints and sample args ----------

type V = { kind: string; isOptional?: boolean; tableName?: string; element?: V; fields?: Record<string, V>; values?: V; members?: V[]; value?: unknown } | null;

export function typeText(v: V): string {
  if (!v) return "any";
  switch (v.kind) {
    case "id":
      return `Id<"${v.tableName}">`;
    case "literal":
      return JSON.stringify(v.value);
    case "array":
      return `${typeText(v.element!)}[]`;
    case "union":
      return v.members!.map(typeText).join(" | ");
    case "object":
      return `{ ${Object.entries(v.fields!).map(([k, f]) => `${k}${f?.isOptional ? "?" : ""}: ${typeText(f)}`).join("; ")} }`;
    case "record":
      return `Record<string, ${typeText(v.values!)}>`;
    default:
      return v.kind;
  }
}

/** Example JSON for a validator, used to prefill the "Run function" form. */
export function sample(v: V): unknown {
  if (!v) return {};
  switch (v.kind) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "id":
      return "";
    case "literal":
      return v.value;
    case "array":
      return [];
    case "record":
      return {};
    case "union":
      return sample(v.members![0]!);
    case "object":
      return Object.fromEntries(Object.entries(v.fields!).filter(([, f]) => !f?.isOptional).map(([k, f]) => [k, sample(f)]));
    default:
      return null;
  }
}

// ---------- small components ----------

const ICONS: Record<string, string> = {
  overview: "M4 4h7v9H4zM4 17h7v3H4zM15 4h5v3h-5zM15 11h5v9h-5z",
  data: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  functions: "M8 6l-6 6 6 6M16 6l6 6-6 6",
  logs: "M4 6h16M4 12h16M4 18h10",
  scheduler: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 3.5",
  files: "M14 3H6v18h12V7zM14 3v4h4",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  theme: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18M12 8h6M12 12h9M12 16h6",
  signout: "M10 4H4v16h6M15 8l4 4-4 4M19 12H9",
  close: "M6 6l12 12M18 6L6 18",
  check: "M4 12.5l5 5L20 6.5",
  critical: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16v.5",
  warning: "M12 4L2.5 20h19zM12 10v4.5M12 17.2v.3",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5.5M12 7.5v.5",
  upload: "M12 16V5M7 10l5-5 5 5M4 20h16",
  download: "M12 5v11M7 11l5 5 5-5M4 20h16",
  retry: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5",
  play: "M7 4.5v15l12-7.5z",
  arrow: "M5 12h14M13 6l6 6-6 6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS & string; size?: number }) {
  return (
    <svg class="ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Badge({ kind, children }: { kind: string; children?: ComponentChildren }) {
  return <span class={`badge b-${kind}`}>{children ?? kind}</span>;
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <p class="empty-title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

type Toast = { id: number; text: string; kind: "ok" | "error" };
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];
let toastId = 1;

export function toast(text: string, kind: Toast["kind"] = "ok") {
  const t = { id: toastId++, text, kind };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((l) => l(toasts));
  }, kind === "error" ? 6000 : 2500);
}

export function Toasts() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    toastListeners.add(setList);
    return () => void toastListeners.delete(setList);
  }, []);
  return (
    <div class="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast t-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
