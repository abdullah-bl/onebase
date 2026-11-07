/** @jsxImportSource preact */
// Editing one field of a document in place: double-click a cell in the Data grid. Saves with
// Enter (or at once for a checkbox or choice), Escape cancels. Only simple values: objects and
// arrays open the document editor instead.

import { useEffect, useRef, useState } from "preact/hooks";

type V = { kind: string; isOptional?: boolean; members?: V[]; value?: unknown } | null | undefined;

export type CellKind = { type: "text" } | { type: "number" } | { type: "boolean" } | { type: "choice"; options: (string | number | boolean)[] };

/** How a field can be edited in place, from its validator (or, outside the schema, its value); null when it can't. */
export function cellKind(v: V, value: unknown): CellKind | null {
  if (!v || v.kind === "any") {
    if (typeof value === "string") return { type: "text" };
    if (typeof value === "number") return { type: "number" };
    if (typeof value === "boolean") return { type: "boolean" };
    return null;
  }
  switch (v.kind) {
    case "string":
    case "id":
      return { type: "text" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "union":
      if (v.members?.length && v.members.every((m) => m?.kind === "literal")) {
        return { type: "choice", options: v.members.map((m) => m!.value as string | number | boolean) };
      }
      return null;
    default:
      return null;
  }
}

export function CellEditor({
  kind,
  value,
  onSave,
  onCancel,
}: {
  kind: CellKind;
  value: unknown;
  onSave: (value: unknown) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => {
    input.current?.focus();
    if (kind.type === "text" || kind.type === "number") input.current?.select();
  }, []);

  const save = async (next: unknown) => {
    if (busy) return;
    setBusy(true);
    const ok = await onSave(next);
    setBusy(false);
    if (!ok) input.current?.focus();
  };

  const submitText = () => {
    if (kind.type === "number") {
      const n = Number(text);
      if (text.trim() === "" || !Number.isFinite(n)) return setInvalid(true);
      return save(n);
    }
    return save(text);
  };

  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && kind.type !== "choice") {
      e.preventDefault();
      void submitText();
    }
  };

  // Clicks inside the editor mustn't reach the row, which opens the document.
  const stop = (e: Event) => e.stopPropagation();

  if (kind.type === "boolean") {
    return (
      <span class="cell-edit" onClick={stop} onDblClick={stop}>
        <label>
          <input ref={input} type="checkbox" checked={value === true} disabled={busy} onKeyDown={keys} onChange={(e) => void save((e.target as HTMLInputElement).checked)} />{" "}
          {String(value === true)}
        </label>
        <button class="btn small" onClick={onCancel}>Done</button>
      </span>
    );
  }
  if (kind.type === "choice") {
    const current = kind.options.findIndex((o) => o === value);
    return (
      <span class="cell-edit" onClick={stop} onDblClick={stop}>
        <select ref={input} disabled={busy} value={String(current)} onKeyDown={keys} onBlur={onCancel} onChange={(e) => void save(kind.options[Number((e.target as HTMLSelectElement).value)])}>
          {current < 0 && <option value="-1">{value === undefined ? "–" : JSON.stringify(value)}</option>}
          {kind.options.map((o, i) => <option value={String(i)}>{JSON.stringify(o)}</option>)}
        </select>
      </span>
    );
  }
  return (
    <span class="cell-edit" onClick={stop} onDblClick={stop}>
      <input
        ref={input}
        class={invalid ? "invalid" : ""}
        type="text"
        inputMode={kind.type === "number" ? "decimal" : undefined}
        spellcheck={false}
        value={text}
        disabled={busy}
        aria-label="New value"
        onInput={(e) => {
          setText((e.target as HTMLInputElement).value);
          setInvalid(false);
        }}
        onKeyDown={keys}
        onBlur={() => !busy && onCancel()}
      />
    </span>
  );
}
