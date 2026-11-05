// Landing page: the dashboard's screens, the code tabs, the live-query demo, the streaming agent
// reply and the Convex tabs. Everything is readable without this script.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const onView = (el, fn) => {
    if (!el) return;
    if (!("IntersectionObserver" in window)) return fn();
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { rootMargin: "0px 0px -20% 0px" });
    io.observe(el);
  };

  // Tabs: one selected at a time, arrow keys move between them.
  const tabs = (buttons, panels) => {
    const select = (n, focus) => {
      buttons.forEach((b, k) => { b.setAttribute("aria-selected", String(k === n)); b.tabIndex = k === n ? 0 : -1; });
      panels.forEach((p, k) => { p.hidden = k !== n; });
      if (focus) buttons[n].focus();
    };
    buttons.forEach((b, k) => {
      b.addEventListener("click", () => select(k));
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        select((k + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length, true);
      });
    });
    select(0);
  };
  const code = $("[data-tabs]");
  if (code) tabs($$("[data-tab]", code), $$("[data-panel]", code));
  const vs = $("[data-vs]");
  if (vs) tabs($$("[data-vs-tab]", vs), $$("[data-vs-panel]", vs));

  // Dashboard: Overview, Data and Logs take turns, paused while the tab is hidden.
  const dash = $("[data-dash]");
  if (dash && !reduced) {
    const views = $$("[data-dash-view]", dash);
    const marks = $$("[data-dash-tab]", dash);
    let i = 0;
    let timer = null;
    const show = (n) => {
      views.forEach((v, k) => v.classList.toggle("on", k === n));
      marks.forEach((t) => t.classList.toggle("on", Number(t.dataset.dashTab) === n));
    };
    const run = () => { timer = setInterval(() => { i = (i + 1) % views.length; show(i); }, 6000); };
    document.addEventListener("visibilitychange", () => { clearInterval(timer); if (!document.hidden) run(); });
    run();
  }

  // Live demo: three clients, two channels; a write re-runs only the matching query.
  const live = $("[data-live]");
  if (live) {
    const form = $("[data-composer]", live);
    const input = $("input", form);
    const log = $("[data-log]", live);
    const clients = $$("[data-client]", live);
    const btns = $$("[data-channel-btn]", live);
    const names = { general: "Alice and Bob", random: "Cara" };
    let channel = "general";
    let touched = false;
    const setChannel = (c) => {
      channel = c;
      live.dataset.channel = c;
      btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.channelBtn === c)));
    };
    btns.forEach((b) => b.addEventListener("click", () => { touched = true; setChannel(b.dataset.channelBtn); input.focus({ preventScroll: true }); }));
    const send = (author, body) => {
      const c = channel;
      const t0 = performance.now();
      setTimeout(() => {
        for (const el of clients) {
          el.classList.remove("pushed");
          if (el.dataset.client === c) {
            void el.offsetWidth;
            el.classList.add("pushed");
            const ul = $("ul", el);
            const li = document.createElement("li");
            const b = document.createElement("b");
            b.textContent = author;
            li.append(b, document.createTextNode(body));
            ul.append(li);
            while (ul.children.length > 4) ul.firstElementChild.remove();
            $("[data-state]", el).textContent = "Pushed the new result";
          } else {
            $("[data-state]", el).textContent = "Not re-run";
          }
        }
        const other = c === "general" ? "random" : "general";
        log.textContent = `messages:send committed. 1 query re-ran (#${c}) and went to ${names[c]}; ${names[other]}'s query on #${other} didn't run. ${Math.max(1, Math.round(performance.now() - t0 - 60))} ms in this tab.`;
      }, 60);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      touched = true;
      const body = input.value.trim();
      if (!body) { input.focus(); return; }
      send("You", body);
      input.value = "";
    });
    input.addEventListener("focus", () => { touched = true; });
    const script = [["general", "Alice", "pushed the index"], ["random", "Cara", "only my query ran"], ["general", "Bob", "no refresh needed"]];
    if (!reduced) {
      onView(live, () => {
        let step = 0;
        const tick = () => {
          if (touched || step >= script.length) return;
          const [c, a, b] = script[step++];
          setChannel(c);
          send(a, b);
          setTimeout(tick, 2400);
        };
        setTimeout(tick, 800);
      });
    }
  }

  // Agent thread: the reply streams in word by word when it comes into view.
  const thread = $("[data-thread]");
  if (thread && !reduced) {
    const out = $("[data-stream]", thread);
    const state = $("[data-stream-state]", thread);
    const words = out.textContent.split(" ");
    onView(thread, () => {
      let n = 0;
      out.textContent = "";
      out.classList.add("typing");
      state.textContent = "Streaming to 2 clients";
      const step = () => {
        n += 1;
        out.textContent = words.slice(0, n).join(" ");
        if (n < words.length) setTimeout(step, 60 + Math.random() * 80);
        else { out.classList.remove("typing"); state.textContent = "Streamed to 2 clients"; }
      };
      setTimeout(step, 400);
    });
  }
})();
