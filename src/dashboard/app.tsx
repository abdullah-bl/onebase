/** @jsxImportSource preact */
// The onebase dashboard, served at /_admin.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AuthError, call, connected, getKey, on, setKey, startEvents } from "./api";
import { Palette } from "./palette";
import { Icon, Toasts, errorText, useLive } from "./ui";
import { DataView } from "./views/data";
import { FilesView } from "./views/files";
import { FunctionsView } from "./views/functions";
import { LogsView } from "./views/logs";
import { OverviewView } from "./views/overview";
import { SchedulerView } from "./views/scheduler";

const NAV = [
  { id: "overview", label: "Overview" },
  { id: "data", label: "Data" },
  { id: "functions", label: "Functions" },
  { id: "logs", label: "Logs" },
  { id: "scheduler", label: "Scheduler" },
  { id: "files", label: "Files" },
];

/** The sidebar's problem counts. Its own component, so a refresh doesn't re-render the open page. */
function NavCount({ page }: { page: string }) {
  const { metrics, scheduler } = useLive();
  let count = 0;
  let label = "";
  if (page === "logs") {
    count = metrics?.ranges["1h"].errors ?? 0;
    label = "errors in the last hour";
  } else if (page === "scheduler") {
    count = (scheduler?.jobs.failed ?? 0) + (scheduler?.crons.filter((c) => c.lastError).length ?? 0);
    label = "failed jobs and crons";
  }
  if (!count) return null;
  return <em class="nav-count" title={`${count.toLocaleString()} ${label}`}>{count > 99 ? "99+" : count}</em>;
}

function toggleTheme() {
  const dark = (document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("ob-theme", dark ? "light" : "dark");
  } catch {}
}

function signOut() {
  setKey(null);
  location.reload();
}

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
  const [palette, setPalette] = useState(false);

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

  useEffect(() => {
    if (!authed) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [authed]);

  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const [page, ...rest] = route;

  return (
    <div class="shell">
      <aside class="side">
        <a class="brand" href="#/overview"><Logo /><span>onebase</span></a>
        <button class="side-search" onClick={() => setPalette(true)} aria-label="Go to a page, table or function">
          <Icon name="search" size={15} />
          <span>Go to…</span>
          <kbd>⌘K</kbd>
        </button>
        <nav>
          {NAV.map((n) => (
            <a href={`#/${n.id}`} aria-current={page === n.id ? "page" : undefined} aria-label={n.label}>
              <Icon name={n.id} size={17} />
              <span>{n.label}</span>
              <NavCount page={n.id} />
            </a>
          ))}
        </nav>
        <div class="side-foot">
          <span class={`live ${live ? "on" : ""}`}>{live ? "Live" : "Reconnecting…"}</span>
          <button class="icon" onClick={toggleTheme} aria-label="Toggle dark mode" title="Toggle dark mode"><Icon name="theme" /></button>
          <button class="icon" onClick={signOut} aria-label="Sign out" title="Sign out"><Icon name="signout" /></button>
        </div>
      </aside>
      <main class="main">
        {page === "overview" && <OverviewView go={go} />}
        {page === "data" && <DataView table={rest[0]} go={go} />}
        {page === "functions" && <FunctionsView name={rest[0]} go={go} />}
        {page === "logs" && <LogsView scope={rest[0]} fn={rest[1]} go={go} />}
        {page === "scheduler" && <SchedulerView state={rest[0]} go={go} />}
        {page === "files" && <FilesView />}
        {!NAV.some((n) => n.id === page) && <OverviewView go={go} />}
      </main>
      {palette && (
        <Palette
          pages={NAV}
          go={go}
          onClose={() => setPalette(false)}
          actions={[
            { label: "Toggle dark mode", icon: "theme", run: toggleTheme },
            { label: "Sign out", icon: "signout", run: signOut },
          ]}
        />
      )}
      <Toasts />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
