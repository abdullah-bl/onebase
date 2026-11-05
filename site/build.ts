// Builds the website into site/dist: the landing page plus docs/*.md rendered to HTML.
// Run: bun site/build.ts. All links are relative, so it works under any base path
// (e.g. https://<user>.github.io/onebase/).

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHighlighter } from "shiki";

const ROOT = join(import.meta.dir, "..");
const OUT = join(import.meta.dir, "dist");
/** Asset URL with a content hash, so a browser never keeps an old stylesheet or script after a change. */
const asset = (file: string) => `assets/${file}?v=${Bun.hash(readFileSync(join(import.meta.dir, "assets", file))).toString(36)}`;
const REPO = "https://github.com/abdullah-bl/onebase";
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

const NAV: { title: string; pages: string[] }[] = [
  { title: "Getting started", pages: ["index", "getting-started"] },
  { title: "Guides", pages: ["schema", "functions", "database", "search", "vector-search", "client", "client-protocol", "swift", "scheduling", "file-storage", "auth", "http-actions"] },
  { title: "Components", pages: ["components", "rate-limiter", "aggregate", "sharded-counter", "work-queue", "migrations", "workflow", "rag", "agent", "presence", "action-cache", "components-authoring"] },
  { title: "Operations", pages: ["deployment", "dashboard", "databases", "backups", "cli"] },
  { title: "Reference", pages: ["convex", "benchmarks", "how-it-works", "llm-guide"] },
];

type Page = { slug: string; title: string; heading: string; description: string; markdown: string; html: string; toc: { id: string; text: string; level: number }[] };

/** Code themes in the site's own teal: one ink, with keywords, strings, functions and comments told apart. */
function codeTheme(name: string, type: "light" | "dark", c: Record<string, string>) {
  return {
    name, type,
    colors: { "editor.background": c.bg!, "editor.foreground": c.fg! },
    tokenColors: [
      { settings: { foreground: c.fg } },
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: c.comment, fontStyle: "italic" } },
      { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "entity.name.tag", "keyword.other"], settings: { foreground: c.keyword, fontStyle: "bold" } },
      { scope: ["string", "string.quoted", "string.template", "punctuation.definition.string", "markup.inline.raw"], settings: { foreground: c.string } },
      { scope: ["constant.numeric", "constant.language", "constant.character", "support.constant", "variable.other.constant"], settings: { foreground: c.constant } },
      { scope: ["entity.name.function", "support.function", "meta.function-call", "entity.other.attribute-name"], settings: { foreground: c.fn } },
      { scope: ["entity.name.type", "support.type", "support.class", "entity.name.class", "meta.object-literal.key", "support.type.property-name"], settings: { foreground: c.type } },
      { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: c.punct } },
    ],
  };
}
const LIGHT = codeTheme("onebase-light", "light", { bg: "#f6f7f9", fg: "#1f2328", comment: "#6e7781", keyword: "#cf222e", string: "#0a3069", constant: "#0550ae", fn: "#953800", type: "#116329", punct: "#57606a" });
const DARK = codeTheme("onebase-dark", "dark", { bg: "#15181d", fg: "#e6edf3", comment: "#8b949e", keyword: "#ff7b72", string: "#a5d6ff", constant: "#79c0ff", fn: "#ffa657", type: "#7ee787", punct: "#c9d1d9" });
const THEMES = { light: "onebase-light", dark: "onebase-dark" } as const;

const highlighter = await createHighlighter({
  themes: [LIGHT as any, DARK as any],
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
  let heading = meta.title ?? slug;
  html = html.replace(/<h1>([\s\S]*?)<\/h1>\s*/, (_m, inner: string) => { heading = inner; return ""; });
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
      themes: THEMES,
      defaultColor: false,
    });
    return `<div class="code" data-lang="${lang ?? ""}">${highlighted}<button class="copy" type="button" aria-label="Copy code">Copy</button></div>`;
  });

  html = html
    .replace(/href="\.\/([\w-]+)\.md(#[\w-]+)?"/g, (_m, page: string, hash = "") => `href="./${page === "index" ? "index" : page}.html${hash}"`)
    .replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"')
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part) => (part.startsWith("<pre") ? part : part.replace(/✓/g, '<span class="yes" role="img" aria-label="Yes"></span>'))) // taste-skill-ignore: turns check marks into dots
    .join("")
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");

  return { slug, title: meta.title ?? slug, heading, description: meta.description ?? "", markdown: body, html, toc };
}

const LOGO = `<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="5" fill="currentColor"/><circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/><circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".22"/></svg>`;

const ICON_GITHUB = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
const ICON_THEME = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 1 0 0 18V3z"/><circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;550;600;650&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

/** Applies the saved theme before first paint to avoid a flash, and marks that scripting works. */
const THEME_BOOT = `<script>document.documentElement.classList.add("js");try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>`;

const ARROW = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function head(title: string, description: string, prefix: string) {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><meta name="description" content="${escape(description)}">
<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">${FONTS}
<link rel="stylesheet" href="${prefix}${asset("style.css")}">${THEME_BOOT}`;
}

function header(prefix: string, active: "home" | "docs", slug = "") {
  const cur = (s: string) => (active === "docs" && slug === s ? ' aria-current="page"' : "");
  return `<header class="topbar" data-topbar>
  <div class="wrap topbar-inner">
    ${active === "docs" ? `<button class="icon-btn menu-btn" type="button" aria-label="Open navigation" aria-expanded="false" data-menu><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>` : ""}
    <a class="brand" href="${prefix}index.html">${LOGO}<span>OneBase</span></a>
    <nav class="topnav" aria-label="Main">
      <a href="${prefix}docs/index.html"${active === "docs" && slug !== "getting-started" && slug !== "benchmarks" ? ' aria-current="page"' : ""}>Docs</a>
      <a href="${prefix}docs/getting-started.html"${cur("getting-started")}>Quick start</a>
      <a href="${prefix}index.html#ai">AI</a>
      <a href="${prefix}docs/benchmarks.html"${cur("benchmarks")}>Benchmarks</a>
    </nav>
    <div class="topbar-actions">
      ${active === "docs" ? `<button class="search-btn" type="button" data-search-open><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Search the docs</span><kbd>/</kbd></button>` : ""}
      <button class="icon-btn" type="button" aria-label="Toggle dark mode" data-theme-toggle>${ICON_THEME}</button>
      <a class="icon-btn" href="${REPO}" target="_blank" rel="noopener" aria-label="OneBase on GitHub">${ICON_GITHUB}</a>
      ${active === "home" ? `<a class="btn primary get" href="${prefix}docs/getting-started.html">Get started</a>` : ""}
    </div>
  </div>
</header>`;
}

/** A plain footer: the name and one line, three short columns of links, the licence. */
function footer(prefix: string) {
  const col = (title: string, links: [string, string, boolean?][]) =>
    `<div><p>${title}</p><ul>${links.map(([href, text, ext]) => `<li><a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ""}>${text}</a></li>`).join("")}</ul></div>`;
  return `<footer class="footer">
  <div class="wrap">
    <div class="footer-top">
      <div class="f-brand"><a class="brand" href="${prefix}index.html">${LOGO}<span>OneBase</span></a><p>A Convex-style reactive backend in one binary.</p></div>
      <div class="f-cols">
        ${col("Docs", [[`${prefix}docs/getting-started.html`, "Quick start"], [`${prefix}docs/index.html`, "Introduction"], [`${prefix}docs/convex.html`, "Coming from Convex"], [`${prefix}docs/benchmarks.html`, "Benchmarks"]])}
        ${col("For agents", [[`${prefix}docs/llm-guide.html`, "LLM guide"], [`${prefix}llms.txt`, "llms.txt"], [`${prefix}llms-full.txt`, "llms-full.txt"]])}
        ${col("Project", [[REPO, "GitHub", true], [`${REPO}/releases`, "Releases", true], [`${REPO}/issues`, "Issues", true]])}
      </div>
    </div>
    <div class="f-legal"><span>OneBase ${VERSION}</span><span>Released under the <a href="${REPO}/blob/main/LICENSE" target="_blank" rel="noopener">MIT license</a></span></div>
  </div>
</footer>`;
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
  const tocItems = page.toc.map((t) => `<li class="lvl${t.level}"><a href="#${t.id}">${escape(t.text)}</a></li>`).join("");
  const toc = page.toc.length > 1 ? `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${tocItems}</ul></nav>` : "";
  const tocMobile = page.toc.length > 1 ? `<details class="toc-mobile"><summary>On this page</summary><ul>${tocItems}</ul></details>` : "";
  const target = next ?? null;
  const sections = target ? target.toc.filter((t) => t.level === 2).slice(0, 7) : [];
  const nextBand = `<section class="next-band" aria-labelledby="next-title"><div class="wrap">
    <div class="n-main">
      <h2 class="n-title" id="next-title"><a href="${target ? `./${target.slug}.html` : "../index.html"}">${target ? `Next: ${escape(target.title)}` : "Back to the start"}</a></h2>
      <p class="n-desc">${target ? escape(target.description) : "That was the last page. The home page has the live demo and the benchmarks."}</p>
      <p class="n-row"><a class="n-go" href="${target ? `./${target.slug}.html` : "../index.html"}" tabindex="-1" aria-hidden="true">${ARROW}</a>${prev ? `<a class="n-prev" href="./${prev.slug}.html">Previous: ${escape(prev.title)}</a>` : ""}</p>
    </div>
    ${sections.length ? `<div class="n-toc"><p>On that page</p><ul>${sections.map((t) => `<li><a href="./${target!.slug}.html#${t.id}">${escape(t.text)}</a></li>`).join("")}</ul></div>` : ""}
  </div></section>`;
  return `<!doctype html>
<html lang="en"><head>${head(`${page.title} · OneBase docs`, page.description, "../")}</head>
<body class="docs-body" data-root="../">
${header("../", "docs", page.slug)}
<div class="wrap docs-layout">
  <aside class="sidebar" data-sidebar aria-label="Docs">${sidebar}
    <p class="sidebar-foot">Version ${VERSION}. All of it as one file: <a href="../llms-full.txt">llms-full.txt</a></p></aside>
  <main class="doc" id="content">
    <header class="doc-head">
      <h1>${page.heading}</h1>
      ${page.description ? `<p class="doc-lead">${escape(page.description)}</p>` : ""}
      <div class="doc-actions">
        <button class="chip primary" type="button" data-copy-md="./${page.slug}.md">Copy as Markdown</button>
        <a class="chip" href="./${page.slug}.md">View as Markdown</a>
        <a class="chip" href="${REPO}/edit/main/docs/${page.slug}.md" target="_blank" rel="noopener">Edit on GitHub</a>
      </div>
    </header>
    ${tocMobile}
    <article class="prose">${page.html}</article>
  </main>
  ${toc}
</div>
${nextBand}
${footer("../")}
<div class="search" data-search hidden>
  <div class="search-backdrop" data-search-close></div>
  <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search docs">
    <input type="search" placeholder="Search the docs…" autocomplete="off" spellcheck="false" aria-label="Search the docs" data-search-input>
    <ul class="search-results" data-search-results></ul>
  </div>
</div>
<script src="../${asset("site.js")}" defer></script>
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
  .replace('src="assets/site.js"', `src="${asset("site.js")}"`)
  .replace('src="assets/landing.js"', `src="${asset("landing.js")}"`)
  .replace("<!--HEAD-->", head("OneBase: the reactive backend in one file", "TypeScript functions, a typed document database and live queries. A Convex-style API that runs as a single binary on SQLite, Postgres or Turso.", ""))
  .replace("<!--HEADER-->", header("", "home"))
  .replace("<!--FOOTER-->", footer(""))
  .replace(/<!--VERSION-->/g, VERSION)
  .replace(/<!--REPO-->/g, REPO);
const highlightBlocks = (html: string) =>
  html.replace(/<pre data-lang="(\w+)">([\s\S]*?)<\/pre>/g, (_m, lang: string, code: string) =>
    highlighter.codeToHtml(unescape(code).replace(/^\n|\n\s*$/g, ""), { lang, themes: THEMES, defaultColor: false }),
  );
writeFileSync(join(OUT, "index.html"), highlightBlocks(landing));
writeFileSync(join(OUT, ".nojekyll"), "");

console.log(`site: ${pages.size} docs pages + landing → ${OUT}`);
