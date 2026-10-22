/** @jsxImportSource preact */
// The onebase dashboard, served at /_admin.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AuthError, call, connected, getKey, on, setKey, startEvents } from "./api";
import { Toasts, errorText } from "./ui";
import { DataView } from "./views/data";
import { FilesView } from "./views/files";
import { FunctionsView } from "./views/functions";
import { LogsView } from "./views/logs";
import { OverviewView } from "./views/overview";
import { SchedulerView } from "./views/scheduler";

const NAV = [
  { id: "overview", label: "Overview", icon: "M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6v-9h-6v9zm0-16v5h6V4h-6z" },
  { id: "data", label: "Data", icon: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zm-8 6c0 1.7 3.6 3 8 3s8-1.3 8-3v4c0 1.7-3.6 3-8 3s-8-1.3-8-3V9zm0 7c0 1.7 3.6 3 8 3s8-1.3 8-3v2c0 1.7-3.6 3-8 3s-8-1.3-8-3v-2z" },
  { id: "functions", label: "Functions", icon: "M8 6 2 12l6 6 1.4-1.4L4.8 12l4.6-4.6L8 6zm8 0-1.4 1.4 4.6 4.6-4.6 4.6L16 18l6-6-6-6z" },
  { id: "logs", label: "Logs", icon: "M4 5h16v2H4V5zm0 6h16v2H4v-2zm0 6h10v2H4v-2z" },
  { id: "scheduler", label: "Scheduler", icon: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6 3.2 3.2-1.4 1.4-3.8-3.8V6h2v6.6z" },
  { id: "files", label: "Files", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z" },
];

function useRoute(): [string[], (r: string) => void] {
  const parse = () => (location.hash.replace(/^#\/?/, "") || "overview").split("/").map(decodeURIComponent);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return [route, (r) => (location.hash = `/${r}`)];
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    setKey(value.trim());
    try {
      await call("overview");
      onDone();
    } catch (err) {
      setKey(null);
      setError(err instanceof AuthError ? "That key doesn't match this server." : errorText(err));
    }
  };
  return (
    <div class="login">
      <form class="login-card" onSubmit={submit}>
        <Logo />
        <h1>onebase dashboard</h1>
        <p class="muted">
          Enter the admin key. It's in <code>onebase_data/admin.key</code> (or <code>$ONEBASE_ADMIN_KEY</code>); in <code>onebase dev</code> the startup link signs you in.
        </p>
        <input type="password" autocomplete="current-password" placeholder="Admin key" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} autofocus />
        {error && <p class="error-box">{error}</p>}
        <button class="btn primary" disabled={!value.trim()}>Sign in</button>
      </form>
    </div>
  );
}

function Logo() {
  return (
    <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="5" fill="currentColor" />
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" stroke-width="2" opacity=".55" />
      <circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".22" />
    </svg>
  );
}

function App() {
  const [authed, setAuthed] = useState<boolean | null>(getKey() ? null : false);
  const [live, setLive] = useState(connected);
  const [route, go] = useRoute();

  useEffect(() => {
    if (authed !== null) return;
    call("overview")
      .then(() => setAuthed(true))
      .catch(() => {
        setKey(null);
        setAuthed(false);
      });
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    startEvents();
    return on("status", setLive);
  }, [authed]);

  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const [page, ...rest] = route;
  const toggleTheme = () => {
    const dark = (document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("ob-theme", dark ? "light" : "dark");
    } catch {}
  };

  return (
    <div class="shell">
      <aside class="side">
        <a class="brand" href="#/overview"><Logo /><span>onebase</span></a>
        <nav>
          {NAV.map((n) => (
            <a href={`#/${n.id}`} aria-current={page === n.id ? "page" : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={n.icon} fill="currentColor" /></svg>
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <div class="side-foot">
          <span class={`live ${live ? "on" : ""}`}>{live ? "Live" : "Reconnecting…"}</span>
          <button class="icon" onClick={toggleTheme} aria-label="Toggle dark mode" title="Toggle dark mode">◐</button>
          <button
            class="icon"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => {
              setKey(null);
              location.reload();
            }}
          >⎋</button>
        </div>
      </aside>
      <main class="main">
        {page === "overview" && <OverviewView go={go} />}
        {page === "data" && <DataView table={rest[0]} go={go} />}
        {page === "functions" && <FunctionsView name={rest[0]} go={go} />}
        {page === "logs" && <LogsView />}
        {page === "scheduler" && <SchedulerView />}
        {page === "files" && <FilesView />}
        {!NAV.some((n) => n.id === page) && <OverviewView go={go} />}
      </main>
      <Toasts />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
