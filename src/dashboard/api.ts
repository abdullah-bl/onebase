// Talks to /_admin/api. The admin key lives in localStorage (it can come from a #key=… link).

const STORAGE_KEY = "ob-admin-key";

export class AuthError extends Error {}

function readKey(): string | null {
  const fromHash = /[#&]key=([^&]+)/.exec(location.hash)?.[1];
  if (fromHash) {
    const key = decodeURIComponent(fromHash);
    setKey(key);
    history.replaceState(null, "", location.pathname + location.search + location.hash.replace(/[#&]?key=[^&]+/, "").replace(/^#?$/, ""));
    return key;
  }
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let key: string | null = readKey();

export function getKey() {
  return key;
}

export function setKey(value: string | null) {
  key = value;
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export async function call<T = any>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/_admin/api/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("Invalid admin key.");
  const data = (await res.json()) as { ok: boolean; value?: T; error?: string };
  if (!data.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data.value as T;
}

export type CallRecord = {
  id: number;
  at: number;
  name: string;
  type: "query" | "mutation" | "action" | "http";
  source: string;
  ms: number;
  ok: boolean;
  error?: string;
  lines: { level: string; text: string }[];
};
export type Stats = { connections: number; subscriptions: number; totals: { calls: number; errors: number }; memory: number; uptimeMs: number };

type Listeners = {
  call: Set<(r: CallRecord) => void>;
  commit: Set<(e: { tables: string[] }) => void>;
  stats: Set<(s: Stats) => void>;
  status: Set<(connected: boolean) => void>;
};
const listeners: Listeners = { call: new Set(), commit: new Set(), stats: new Set(), status: new Set() };
let started = false;
export let connected = false;

export function on<K extends keyof Listeners>(event: K, fn: Listeners[K] extends Set<infer F> ? F : never): () => void {
  (listeners[event] as Set<any>).add(fn);
  return () => (listeners[event] as Set<any>).delete(fn);
}

function setConnected(value: boolean) {
  connected = value;
  for (const fn of listeners.status) fn(value);
}

/** Reads the server-sent event stream (with the key in a header) and reconnects when it drops. */
export function startEvents() {
  if (started) return;
  started = true;
  let delay = 500;
  const loop = async () => {
    for (;;) {
      try {
        const res = await fetch("/_admin/api/events", { headers: { Authorization: `Bearer ${key ?? ""}` } });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        setConnected(true);
        delay = 500;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let i: number;
          while ((i = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const event = /^event: (.+)$/m.exec(chunk)?.[1];
            const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (!event || !data) continue;
            const set = (listeners as any)[event] as Set<(v: unknown) => void> | undefined;
            if (set) for (const fn of set) fn(JSON.parse(data));
          }
        }
      } catch {}
      setConnected(false);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
    }
  };
  void loop();
}
