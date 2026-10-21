// Shared behavior: theme toggle, docs navigation, copy buttons, table of contents, search.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  // Theme: explicit choice wins over the OS setting.
  $("[data-theme-toggle]")?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  });

  // Copy buttons on code blocks.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest?.(".copy, [data-copy]");
    if (!btn) return;
    const text = btn.dataset.copy ?? btn.closest(".code")?.querySelector("pre")?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text.trimEnd());
      const label = btn.textContent;
      btn.textContent = "Copied";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = label; btn.classList.remove("done"); }, 1400);
    } catch {}
  });

  // Mobile sidebar.
  $("[data-menu]")?.addEventListener("click", () => document.body.classList.toggle("nav-open"));
  $("[data-sidebar]")?.addEventListener("click", (e) => { if (e.target.closest("a")) document.body.classList.remove("nav-open"); });
  $("[data-sidebar] [aria-current]")?.scrollIntoView({ block: "center" });

  // Highlight the current section in "On this page".
  const tocLinks = $$(".toc a");
  if (tocLinks.length) {
    const targets = tocLinks.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
    const update = () => {
      let current = targets[0];
      for (const t of targets) if (t.getBoundingClientRect().top < 120) current = t;
      for (const a of tocLinks) a.classList.toggle("active", a.hash === `#${current?.id}`);
    };
    addEventListener("scroll", update, { passive: true });
    update();
  }

  // Search over docs/search.json.
  const search = $("[data-search]");
  if (search) {
    const input = $("[data-search-input]");
    const results = $("[data-search-results]");
    let index = null;
    let selected = 0;
    const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const mark = (text, terms) => {
      let out = escapeHtml(text);
      for (const t of terms) out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
      return out;
    };
    const open = async () => {
      search.hidden = false;
      input.focus();
      input.select();
      index ??= await fetch("./search.json").then((r) => r.json()).catch(() => []);
      run();
    };
    const close = () => { search.hidden = true; };
    const run = () => {
      const q = input.value.trim().toLowerCase();
      if (!q || !index) { results.innerHTML = ""; return; }
      const terms = q.split(/\s+/).filter(Boolean);
      const scored = [];
      for (const e of index) {
        const heading = e.heading.toLowerCase();
        const text = e.text.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (heading.includes(t)) score += 10;
          else if (e.page.toLowerCase().includes(t)) score += 4;
          else if (text.includes(t)) score += 1;
          else { score = 0; break; }
        }
        if (score) scored.push([score, e]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      selected = 0;
      results.innerHTML = scored.length
        ? scored.slice(0, 12).map(([, e], i) => {
            const pos = e.text.toLowerCase().indexOf(terms[0]);
            const snippet = pos > 40 ? "…" + e.text.slice(pos - 30, pos + 110) : e.text.slice(0, 140);
            return `<li><a href="${e.url}" aria-selected="${i === 0}"><span class="r-title">${mark(e.heading, terms)}</span><span class="r-page">${escapeHtml(e.page)}</span><span class="r-text">${mark(snippet, terms)}</span></a></li>`;
          }).join("")
        : `<li class="search-empty">No results for “${escapeHtml(q)}”</li>`;
    };
    const move = (d) => {
      const links = $$("a", results);
      if (!links.length) return;
      selected = (selected + d + links.length) % links.length;
      links.forEach((a, i) => a.setAttribute("aria-selected", String(i === selected)));
      links[selected].scrollIntoView({ block: "nearest" });
    };
    $("[data-search-open]")?.addEventListener("click", open);
    $$("[data-search-close]").forEach((el) => el.addEventListener("click", close));
    results.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
    input.addEventListener("input", run);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      if (e.key === "Enter") { const a = $$("a", results)[selected]; if (a) { close(); location.href = a.href; } }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !search.hidden) close();
      const typing = /input|textarea|select/i.test(document.activeElement?.tagName ?? "");
      if (!typing && (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey)))) { e.preventDefault(); open(); }
    });
  }
})();
