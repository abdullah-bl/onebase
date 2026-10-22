/** @jsxImportSource preact */
// Small shared pieces: formatting, JSON viewer, badges, toasts.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

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
