/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { call } from "../api";
import { Badge, Empty, Icon, ago, errorText, fullTime, toast } from "../ui";

type EnvVar = { name: string; value: string; updated: number; overridden: boolean };
type EnvChange = { changed: string[]; overridden: string[]; reload: "deployment" | "local" | "none"; error?: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a change did, as one toast (and a second one for a failed reload). */
function announce(r: EnvChange, what: string) {
  if (!r.changed.length) return toast("Nothing changed");
  if (r.error) toast(`Saved, but the deployment failed to reload with it and keeps running as it was: ${r.error}`, "error");
  else if (r.overridden.length) toast(`${what}. ${r.overridden.join(", ")} is set in the server's own environment, which wins.`, "error");
  else if (r.reload === "local") toast(`${what}. Code that reads it when it loads (like auth.config.ts) needs a restart.`);
  else toast(`${what}. Live now`);
}

/** Parses pasted KEY=value lines (with optional export, quotes and comments). */
function parseLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2]!.trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]!] = value;
  }
  return out;
}

const masked = (value: string) => (value.length ? "•".repeat(Math.min(12, Math.max(6, value.length))) : "(empty)");

export function EnvView() {
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [bulk, setBulk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setVars(await call<EnvVar[]>("envList"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => void load(), []);

  const save = async (set: Record<string, string>, remove: string[], what: string) => {
    setBusy(true);
    try {
      announce(await call<EnvChange>("envSet", { set, remove }), what);
      await load();
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const n = name.trim();
    if (await save({ [n]: value }, [], `${n} ${editing ? "updated" : "set"}`)) {
      setName("");
      setValue("");
      setEditing(null);
    }
  };

  const importBulk = async () => {
    const set = parseLines(bulk ?? "");
    const count = Object.keys(set).length;
    if (!count) return toast("No NAME=value lines found", "error");
    if (await save(set, [], `${count} variable${count === 1 ? "" : "s"} saved`)) setBulk(null);
  };

  const remove = async (v: EnvVar) => {
    if (!confirm(`Remove ${v.name}? Code reading it will get undefined.`)) return;
    await save({}, [v.name], `${v.name} removed`);
  };

  const edit = (v: EnvVar) => {
    setEditing(v.name);
    setName(v.name);
    setValue(v.value);
    setBulk(null);
  };

  const toggle = (n: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (!next.delete(n)) next.add(n);
      return next;
    });

  const copy = async (v: EnvVar) => {
    try {
      await navigator.clipboard.writeText(v.value);
      toast(`${v.name} copied`);
    } catch {
      toast("Couldn't copy: the browser blocked it", "error");
    }
  };

  const nameOk = NAME.test(name.trim()) && !/^ONEBASE_/i.test(name.trim());

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Environment variables</h1>
          <p class="muted">
            Read with <code>process.env</code>. Changes apply on every instance at once, without a redeploy. Also <code>onebase env set</code>.
          </p>
        </div>
        <div class="toolbar">
          <button class="btn" onClick={() => setBulk(bulk === null ? "" : null)}><Icon name="upload" size={14} /> Paste .env</button>
        </div>
      </header>
      {error && <p class="error-box">{error}</p>}

      {bulk !== null && (
        <div class="card">
          <div class="card-head"><h3>Paste .env</h3></div>
          <div class="pad">
            <textarea
              class="env-bulk"
              rows={8}
              spellcheck={false}
              placeholder={"STRIPE_KEY=sk_live_…\nRESEND_API_KEY=re_…"}
              value={bulk}
              onInput={(e) => setBulk((e.target as HTMLTextAreaElement).value)}
            />
            <div class="toolbar env-actions">
              <button class="btn primary" disabled={busy || !bulk.trim()} onClick={importBulk}>Save all</button>
              <button class="btn" onClick={() => setBulk(null)}>Cancel</button>
              <span class="muted">Existing names are overwritten; others are kept.</span>
            </div>
          </div>
        </div>
      )}

      <form class="card env-form" onSubmit={submit}>
        <div class="card-head"><h3>{editing ? `Edit ${editing}` : "Add a variable"}</h3></div>
        <div class="env-row pad">
          <input
            aria-label="Name"
            placeholder="NAME"
            class="mono"
            value={name}
            readOnly={editing !== null}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <input
            aria-label="Value"
            placeholder="value"
            class="mono"
            type="password"
            autocomplete="new-password"
            spellcheck={false}
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
          <button class="btn primary" disabled={busy || !nameOk}>{editing ? "Save" : "Add"}</button>
          {editing && (
            <button type="button" class="btn" onClick={() => { setEditing(null); setName(""); setValue(""); }}>Cancel</button>
          )}
        </div>
        {name.trim() && !nameOk && (
          <p class="muted env-hint">
            {/^ONEBASE_/i.test(name.trim()) ? "ONEBASE_* settings are read at startup: set them in the server's environment." : "Use letters, digits and _, not starting with a digit."}
          </p>
        )}
      </form>

      <div class="card">
        {vars === null && !error ? (
          <div class="skeleton" style="height:120px;margin:14px 16px" />
        ) : vars?.length === 0 ? (
          <Empty title="No variables yet">Add one above, paste a .env file, or run onebase env set NAME value.</Empty>
        ) : (
          <div class="grid-wrap flat">
            <table class="tbl">
              <thead><tr><th>Name</th><th>Value</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                {vars?.map((v) => (
                  <tr>
                    <td>
                      <code>{v.name}</code>{" "}
                      {v.overridden && (
                        <span title="The server's own environment (or a .env file it read) sets this name, and that value wins. Remove it there for this one to apply.">
                          <Badge kind="warn">overridden</Badge>
                        </span>
                      )}
                    </td>
                    <td class="mono ellipsis">
                      <button class="btn small env-reveal" onClick={() => toggle(v.name)} aria-label={shown.has(v.name) ? `Hide ${v.name}` : `Show ${v.name}`}>
                        {shown.has(v.name) ? "Hide" : "Show"}
                      </button>{" "}
                      {shown.has(v.name) ? v.value || <span class="muted">(empty)</span> : <span class="muted">{masked(v.value)}</span>}
                    </td>
                    <td title={fullTime(v.updated)}>{ago(v.updated)}</td>
                    <td class="actions">
                      <button class="btn small" onClick={() => void copy(v)}><Icon name="copy" size={12} /> Copy</button>
                      <button class="btn small" onClick={() => edit(v)}>Edit</button>
                      <button class="btn small danger" onClick={() => void remove(v)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
