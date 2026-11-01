/** @jsxImportSource preact */
// ⌘K: jump to any page, table or function, or run a dashboard action.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { call } from "./api";
import { Icon } from "./ui";

export type PaletteAction = { label: string; icon: string; run: () => void };
type Entry = { key: string; label: string; group: string; icon: string; run: () => void };

/** Letters of `query` in order, anywhere in `text`; earlier and tighter matches score lower. */
function score(text: string, query: string): number | null {
  const t = text.toLowerCase();
  const direct = t.indexOf(query);
  if (direct >= 0) return direct;
  let at = -1;
  let spread = 0;
  for (const ch of query) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return null;
    if (at >= 0) spread += next - at - 1;
    at = next;
  }
  return 100 + spread;
}

export function Palette({ pages, actions, go, onClose }: { pages: { id: string; label: string }[]; actions: PaletteAction[]; go: (route: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [tables, setTables] = useState<string[]>([]);
  const [fns, setFns] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus();
    call<{ name: string }[]>("tables").then((t) => setTables(t.map((x) => x.name))).catch(() => {});
    call<{ name: string }[]>("functions").then((f) => setFns(f.map((x) => x.name))).catch(() => {});
    return () => before?.focus?.();
  }, []);

  const entries = useMemo(() => {
    const all: Entry[] = [
      ...pages.map((p) => ({ key: `p-${p.id}`, label: p.label, group: "Pages", icon: p.id, run: () => go(p.id) })),
      ...tables.map((t) => ({ key: `t-${t}`, label: t, group: "Tables", icon: "data", run: () => go(`data/${encodeURIComponent(t)}`) })),
      ...fns.map((f) => ({ key: `f-${f}`, label: f, group: "Functions", icon: "functions", run: () => go(`functions/${encodeURIComponent(f)}`) })),
      ...actions.map((a) => ({ key: `a-${a.label}`, label: a.label, group: "Actions", icon: a.icon, run: a.run })),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 40);
    return all
      .flatMap((entry) => {
        const s = score(entry.label, q);
        return s === null ? [] : [{ entry, s }];
      })
      .sort((a, b) => a.s - b.s)
      .slice(0, 40)
      .map((m) => m.entry);
  }, [query, tables, fns]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (entry?: Entry) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "Enter") choose(entries[active]);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (entries.length) setActive((active + (e.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length);
    }
  };

  return (
    <>
      <div class="drawer-backdrop" onClick={onClose} />
      <div class="palette" role="dialog" aria-modal="true" aria-label="Go to">
        <div class="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={entries[active] ? entries[active]!.key : undefined}
            placeholder="Go to a page, table or function"
            spellcheck={false}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={keys}
          />
          <kbd>esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" ref={list}>
          {entries.map((entry, i) => (
            <li
              key={entry.key}
              id={entry.key}
              role="option"
              aria-selected={i === active}
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => choose(entry)}
            >
              <Icon name={entry.icon} size={15} />
              <span class={entry.group === "Pages" || entry.group === "Actions" ? "" : "mono"}>{entry.label}</span>
              <small>{entry.group}</small>
            </li>
          ))}
          {entries.length === 0 && <li class="palette-none">Nothing matches "{query}".</li>}
        </ul>
      </div>
    </>
  );
}
