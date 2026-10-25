// Builds the website into site/dist: the landing page plus docs/*.md rendered to HTML.
// Run: bun site/build.ts. All links are relative, so it works under any base path
// (e.g. https://<user>.github.io/onebase/).

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHighlighter } from "shiki";

const ROOT = join(import.meta.dir, "..");
const OUT = join(import.meta.dir, "dist");
const REPO = "https://github.com/abdullah-bl/onebase";
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

const NAV: { title: string; pages: string[] }[] = [
  { title: "Getting started", pages: ["index", "getting-started"] },
  { title: "Guides", pages: ["schema", "functions", "database", "search", "client", "client-protocol", "swift", "scheduling", "file-storage", "auth", "http-actions"] },
  { title: "Operations", pages: ["deployment", "dashboard", "databases", "backups", "cli"] },
  { title: "Reference", pages: ["convex", "how-it-works", "llm-guide"] },
];

type Page = { slug: string; title: string; description: string; markdown: string; html: string; toc: { id: string; text: string; level: number }[] };

const highlighter = await createHighlighter({
  themes: ["github-light", "github-dark-default"],
  langs: ["ts", "tsx", "js", "bash", "json", "html", "sql", "ini", "nginx", "dockerfile", "text"],
});

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stripTags = (s: string) => unescape(s.replace(/<[^>]+>/g, ""));
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-") || "section";

function parseFrontmatter(src: string) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m ? src.slice(m[0].length) : src };
}

function render(slug: string): Page {
  const src = readFileSync(join(ROOT, "docs", `${slug}.md`), "utf8");
  const { meta, body } = parseFrontmatter(src);
  let html = Bun.markdown.html(body);
  const toc: Page["toc"] = [];
  const used = new Set<string>();

  // Headings get ids and anchor links; h2/h3 go into the page's table of contents.
  html = html.replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
    const text = stripTags(inner);
    if (level === "1") return `<h1>${inner}</h1>`;
    let id = slugify(text);
    for (let n = 2; used.has(id); n++) id = `${slugify(text)}-${n}`;
    used.add(id);
    toc.push({ id, text, level: Number(level) });
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${level}>`;
  });

  // Syntax highlighting, with light and dark colors as CSS variables.
  html = html.replace(/<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_m, lang: string | undefined, code: string) => {
    const language = lang && highlighter.getLoadedLanguages().includes(lang) ? lang : "text";
    const highlighted = highlighter.codeToHtml(unescape(code).replace(/\n$/, ""), {
      lang: language,
      themes: { light: "github-light", dark: "github-dark-default" },
      defaultColor: false,
    });
    return `<div class="code" data-lang="${lang ?? ""}">${highlighted}<button class="copy" type="button" aria-label="Copy code">Copy</button></div>`;
  });

  html = html
    .replace(/href="\.\/([\w-]+)\.md(#[\w-]+)?"/g, (_m, page: string, hash = "") => `href="./${page === "index" ? "index" : page}.html${hash}"`)
    .replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"')
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");

  return { slug, title: meta.title ?? slug, description: meta.description ?? "", markdown: body, html, toc };
}

const LOGO = `<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="5" fill="currentColor"/><circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/><circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".22"/></svg>`;

const ICON_GITHUB = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
const ICON_THEME = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 1 0 0 18V3z"/><circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">`;

/** Applies the saved theme before first paint to avoid a flash. */
const THEME_BOOT = `<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>`;

function head(title: string, description: string, prefix: string) {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}">
<link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">${FONTS}
<link rel="stylesheet" href="${prefix}assets/style.css">${THEME_BOOT}`;
}

function header(prefix: string, active: "home" | "docs") {
  return `<header class="topbar">
  <div class="topbar-inner">
    ${active === "docs" ? `<button class="icon-btn menu-btn" type="button" aria-label="Open navigation" data-menu><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>` : ""}
    <a class="brand" href="${prefix}index.html">${LOGO}<span>onebase</span></a>
    <nav class="topnav">
      <a href="${prefix}docs/index.html"${active === "docs" ? ' aria-current="page"' : ""}>Docs</a>
      <a href="${prefix}docs/getting-started.html">Quick start</a>
      <a href="${REPO}/releases" target="_blank" rel="noopener">Releases</a>
    </nav>
    <div class="topbar-actions">
      ${active === "docs" ? `<button class="search-btn" type="button" data-search-open><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Search</span><kbd>/</kbd></button>` : ""}
      <button class="icon-btn" type="button" aria-label="Toggle dark mode" data-theme-toggle>${ICON_THEME}</button>
      <a class="icon-btn" href="${REPO}" target="_blank" rel="noopener" aria-label="GitHub">${ICON_GITHUB}</a>
    </div>
  </div>
</header>`;
}

function docPage(page: Page, pages: Map<string, Page>) {
  const order = NAV.flatMap((s) => s.pages);
  const i = order.indexOf(page.slug);
  const prev = pages.get(order[i - 1] ?? "");
  const next = pages.get(order[i + 1] ?? "");
  const sidebar = NAV.map(
    (section) => `<div class="nav-section"><p class="nav-title">${section.title}</p><ul>${section.pages
      .map((slug) => {
        const p = pages.get(slug)!;
        return `<li><a href="./${slug}.html"${slug === page.slug ? ' aria-current="page"' : ""}>${escape(p.title)}</a></li>`;
      })
      .join("")}</ul></div>`,
  ).join("");
  const toc = page.toc.length > 1
    ? `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${page.toc
        .map((t) => `<li class="lvl${t.level}"><a href="#${t.id}">${escape(t.text)}</a></li>`)
        .join("")}</ul></nav>`
    : "";
  return `<!doctype html>
<html lang="en"><head>${head(`${page.title} · onebase docs`, page.description, "../")}</head>
<body class="docs-body" data-root="../">
${header("../", "docs")}
<div class="docs-layout">
  <aside class="sidebar" data-sidebar><div class="sidebar-inner">${sidebar}
    <p class="sidebar-foot">v${VERSION} · <a href="../llms-full.txt">llms-full.txt</a></p></div></aside>
  <main class="doc" id="content">
    <article class="prose">${page.html}</article>
    <div class="doc-foot">
      <a class="edit" href="${REPO}/edit/main/docs/${page.slug}.md" target="_blank" rel="noopener">Edit this page on GitHub</a>
      <div class="pager">
        ${prev ? `<a class="pager-link prev" href="./${prev.slug}.html"><span>Previous</span>${escape(prev.title)}</a>` : "<span></span>"}
        ${next ? `<a class="pager-link next" href="./${next.slug}.html"><span>Next</span>${escape(next.title)}</a>` : "<span></span>"}
      </div>
    </div>
  </main>
  ${toc}
</div>
<div class="search" data-search hidden>
  <div class="search-backdrop" data-search-close></div>
  <div class="search-panel" role="dialog" aria-label="Search docs">
    <input type="search" placeholder="Search the docs…" autocomplete="off" spellcheck="false" data-search-input>
    <ul class="search-results" data-search-results></ul>
  </div>
</div>
<script src="../assets/site.js" defer></script>
</body></html>`;
}

/** Splits each page at h2 headings into search entries. */
function searchIndex(pages: Page[]) {
  const entries: { page: string; heading: string; url: string; text: string }[] = [];
  for (const p of pages) {
    const parts = p.html.split(/(?=<h2 id=")/);
    for (const part of parts) {
      const m = /<h2 id="([^"]+)">([\s\S]*?)<\/h2>/.exec(part);
      const text = stripTags(part.replace(/<h[12][^>]*>[\s\S]*?<\/h[12]>/g, " ").replace(/<button[\s\S]*?<\/button>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000);
      entries.push({
        page: p.title,
        heading: m ? stripTags(m[2]!).replace(/^#/, "") : p.title,
        url: `./${p.slug}.html${m ? `#${m[1]}` : ""}`,
        text,
      });
    }
  }
  return entries;
}

// ---- Build ----

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "docs"), { recursive: true });
cpSync(join(import.meta.dir, "assets"), join(OUT, "assets"), { recursive: true });

const pages = new Map(NAV.flatMap((s) => s.pages).map((slug) => [slug, render(slug)]));
for (const page of pages.values()) {
  writeFileSync(join(OUT, "docs", `${page.slug}.html`), docPage(page, pages));
}
writeFileSync(join(OUT, "docs", "search.json"), JSON.stringify(searchIndex([...pages.values()])));

// Plain-text docs for AI assistants (https://llmstxt.org).
const all = [...pages.values()];
writeFileSync(
  join(OUT, "llms.txt"),
  `# onebase\n\n> A lightweight, Convex-style reactive backend: TypeScript functions, a typed document database and live queries in one executable.\n\n## Docs\n\n${all
    .map((p) => `- [${p.title}](docs/${p.slug}.md): ${p.description}`)
    .join("\n")}\n\n## Full text\n\n- [llms-full.txt](llms-full.txt): every page in one file\n`,
);
writeFileSync(join(OUT, "llms-full.txt"), all.map((p) => p.markdown.trim()).join("\n\n---\n\n") + "\n");
for (const p of all) writeFileSync(join(OUT, "docs", `${p.slug}.md`), p.markdown);

const landing = readFileSync(join(import.meta.dir, "index.html"), "utf8")
  .replace("<!--HEAD-->", head("onebase: the reactive backend in one file", "TypeScript functions, a typed document database and live queries. A Convex-style API that runs as a single binary on SQLite, Postgres or Turso.", ""))
  .replace("<!--HEADER-->", header("", "home"))
  .replace(/<!--VERSION-->/g, VERSION)
  .replace(/<!--REPO-->/g, REPO);
const highlightBlocks = (html: string) =>
  html.replace(/<pre data-lang="(\w+)">([\s\S]*?)<\/pre>/g, (_m, lang: string, code: string) =>
    highlighter.codeToHtml(unescape(code).replace(/^\n|\n\s*$/g, ""), { lang, themes: { light: "github-light", dark: "github-dark-default" }, defaultColor: false }),
  );
writeFileSync(join(OUT, "index.html"), highlightBlocks(landing));
writeFileSync(join(OUT, ".nojekyll"), "");

console.log(`site: ${pages.size} docs pages + landing → ${OUT}`);
