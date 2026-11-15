// Docs for the optional component packages, which live in their own repository
// (https://github.com/abdullah-bl/onebase-components). The site build reads a checkout of
// it: a package's README.md when it has one, otherwise a page put together from the
// package's source (its header comment, configuration type, functions and tables).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const COMPONENTS_REPO = "https://github.com/abdullah-bl/onebase-components";
const COMPONENTS_GIT = `${COMPONENTS_REPO}.git`;

export type ComponentDoc = {
  /** Page slug on the site: the package directory name, e.g. "teams". */
  slug: string;
  /** npm name, e.g. "@onebase/teams". */
  name: string;
  description: string;
  /** Markdown, with frontmatter, in the same form as docs/*.md. */
  markdown: string;
  /** Where "Edit on GitHub" goes: the README, or the source when the page is generated. */
  editUrl: string;
  /** True when the page comes from the package's README.md. */
  fromReadme: boolean;
};

/**
 * Finds a checkout of onebase-components: $ONEBASE_COMPONENTS_DIR, else site/.components
 * (the Pages workflow checks the repository out there), else a fresh shallow clone into it.
 * Returns null when there is none and none can be made (offline, say).
 */
export function componentsCheckout(cacheDir: string): { dir: string; commit: string } | null {
  const fromEnv = process.env.ONEBASE_COMPONENTS_DIR;
  let dir = fromEnv ?? cacheDir;
  if (!fromEnv) {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { stdout: "ignore", stderr: "pipe" });
    if (existsSync(join(cacheDir, ".git"))) {
      if (!process.env.CI) git("-C", cacheDir, "pull", "--ff-only", "--quiet"); // best effort; offline keeps the old copy
    } else {
      const r = git("clone", "--depth", "1", "--quiet", COMPONENTS_GIT, cacheDir);
      if (r.exitCode !== 0) {
        console.warn(`site: couldn't clone ${COMPONENTS_GIT} (${r.stderr.toString().trim()}); building without component pages`);
        return null;
      }
    }
  }
  if (!existsSync(join(dir, "packages"))) return null;
  const head = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return { dir, commit: head.exitCode === 0 ? head.stdout.toString().trim() : "main" };
}

/** Reads every package in the checkout, in the order the repository's README lists them. */
export function loadComponents(dir: string, published: Set<string>): ComponentDoc[] {
  const pkgsDir = join(dir, "packages");
  const names = readdirSync(pkgsDir).filter((d) => existsSync(join(pkgsDir, d, "package.json")));
  const readme = existsSync(join(dir, "README.md")) ? readFileSync(join(dir, "README.md"), "utf8") : "";
  const rank = (d: string) => {
    const i = readme.indexOf(`(packages/${d})`);
    return i < 0 ? Infinity : i;
  };
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names.map((d) => loadPackage(join(pkgsDir, d), d, published));
}

function loadPackage(pkgDir: string, slug: string, published: Set<string>): ComponentDoc {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name: string; description?: string };
  const description = (pkg.description ?? "").replace(/\.$/, "") + (pkg.description ? "." : "");
  const tree = `${COMPONENTS_REPO}/tree/main/packages/${slug}`;
  const readmePath = join(pkgDir, "README.md");
  if (existsSync(readmePath)) {
    let body = readFileSync(readmePath, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    if (!/^#\s/m.test(body)) body = `# ${pkg.name}\n\n${body}`;
    return {
      slug, name: pkg.name, description, fromReadme: true,
      editUrl: `${COMPONENTS_REPO}/edit/main/packages/${slug}/README.md`,
      markdown: frontmatter(pkg.name, description) + resolveLinks(body, `${COMPONENTS_REPO}/blob/main/packages/${slug}/`),
    };
  }
  return {
    slug, name: pkg.name, description, fromReadme: false,
    editUrl: `${tree}/src`,
    markdown: frontmatter(pkg.name, description) + generated(pkgDir, slug, pkg.name, published.has(pkg.name)),
  };
}

const frontmatter = (title: string, description: string) =>
  `---\ntitle: ${title}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n`;

/** Relative links in a README point into the repository on GitHub, since its files aren't on the site. */
function resolveLinks(md: string, base: string) {
  return md.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_m, href: string) => `](${new URL(href, base).href})`);
}

// ---- Pages generated from source ----

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * A file's leading `//` comment as Markdown. Lines indented two or more spaces are code
 * (consecutive ones, with blank lines between, form one block); `  * ` lines are list items.
 */
export function headerMarkdown(src: string): string {
  const lines: string[] = [];
  for (const line of src.split("\n")) {
    if (!line.startsWith("//")) break;
    lines.push(line.replace(/^\/\/ ?/, ""));
  }
  const out: string[] = [];
  let code: string[] = [];
  const flush = () => {
    while (code.length && code[code.length - 1] === "") code.pop();
    if (code.length) {
      const indent = Math.min(...code.filter(Boolean).map((l) => /^ */.exec(l)![0].length));
      out.push("```ts", ...code.map((l) => l.slice(indent)), "```", "");
    }
    code = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const isCode = (l: string) => /^ {2,}\S/.test(l) && !/^ {2}[*-] /.test(l);
    if (isCode(line)) {
      code.push(line);
      // Keep blank lines only when more code follows them.
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      if (j < lines.length && isCode(lines[j]!)) for (let k = i + 1; k < j; k++) code.push("");
      else { flush(); out.push(""); }
      i = j;
      continue;
    }
    flush();
    const item = /^ {2}[*-] (.*)$/.exec(line);
    if (item) {
      let text = item[1]!;
      while (i + 1 < lines.length && /^ {4,}\S/.test(lines[i + 1]!)) text += " " + lines[++i]!.trim();
      out.push(`- ${text}`);
    } else if (line.trim() === "") {
      out.push("");
    } else {
      // Join wrapped prose into one paragraph line.
      if (out.length && out[out.length - 1] !== "" && !out[out.length - 1]!.startsWith("- ") && !out[out.length - 1]!.startsWith("```")) {
        out[out.length - 1] += " " + line.trim();
      } else out.push(line.trim());
    }
    i++;
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The source of `export type <Name> = …;` up to its closing brace at column 0. */
function typeSource(src: string, pattern: RegExp): string | null {
  const m = pattern.exec(src);
  if (!m) return null;
  const start = src.lastIndexOf("\n", m.index) + 1;
  const end = src.indexOf("\n};", m.index);
  if (end < 0) return null;
  return src.slice(start, end + 3);
}

function generated(pkgDir: string, slug: string, name: string, onNpm: boolean): string {
  const srcDir = join(pkgDir, "src");
  const files = sourceFiles(srcDir);
  const index = readFileSync(join(srcDir, "index.ts"), "utf8");
  const blob = (file: string) => `${COMPONENTS_REPO}/blob/main/packages/${slug}/${relative(pkgDir, file)}`;
  const parts: string[] = [`# ${name}`];

  // Overview: the entry point's header comment; for a thin one, every file's.
  let overview = headerMarkdown(index);
  if (overview.split(/\s+/).length < 12) {
    // Top-level files first; a header without code becomes one list item naming its file.
    const depth = (f: string) => relative(srcDir, f).split("/").length;
    overview = files
      .filter((f) => !f.endsWith("/index.ts"))
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
      .map((f) => {
        const md = headerMarkdown(readFileSync(f, "utf8"));
        return !md || md.includes("```") ? md : `- [\`${relative(srcDir, f)}\`](${blob(f)}): ${md.replace(/\n+/g, " ")}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (overview) parts.push(overview);

  parts.push("## Install");
  parts.push(
    onNpm
      ? `\`\`\`bash\nbun add ${name}\n\`\`\``
      : `\`${name}\` isn't on npm yet. Until it is, clone [onebase-components](${COMPONENTS_REPO}) next to your app and add the package from that checkout, after onebase itself (see [Getting started](./getting-started.md)):\n\n\`\`\`bash\ngit clone ${COMPONENTS_REPO}.git\nbun add ${name}@file:../onebase-components/packages/${slug}\n\`\`\``,
  );

  const config = typeSource(index, /^export type \w*Config\b[^=]*=/m);
  if (config) {
    parts.push("## Configuration", "The options the mount function takes, from the package's source:", "```ts\n" + config + "\n```");
  }

  const api = typeSource(index, /^export type \w+Api\b[^=]*=/m);
  if (api) {
    const rows = [...api.matchAll(/^\s+(\w+): ComponentFn<"(\w+)", \((.*)\) => Promise<(.*)>>;$/gm)].map(
      ([, fn, kind, args, ret]) => `| \`${fn}\` | ${kind} | \`${(args ?? "").replace(/^args: /, "").replace(/\|/g, "\\|")}\` → \`${(ret ?? "").replace(/\|/g, "\\|")}\` |`,
    );
    if (rows.length) {
      parts.push(
        "## Functions",
        "Call them from your functions as `ctx.components.<mount name>.<function>(args)`. Pass a function's name in `expose` when mounting to call it from clients.",
        "| Function | Kind | Arguments → result |\n|---|---|---|\n" + rows.join("\n"),
      );
    }
  }

  const schema = /const schema = defineSchema\(\{([\s\S]*?)\n\}\);/.exec(index)?.[1];
  if (schema) {
    const tables = [...schema.matchAll(/^ {2}(\w+): defineTable\(/gm)].map((m) => {
      const after = schema.slice(m.index!);
      const end = after.search(/\n {2}\w+: defineTable\(|$/);
      const body = after.slice(0, end > 0 ? end : undefined);
      const indexes = [...body.matchAll(/\.index\("(\w+)"/g)].map((x) => `\`${x[1]}\``);
      return `| \`${m[1]}\` | ${indexes.join(", ") || "none"} |`;
    });
    if (tables.length) {
      parts.push("## Tables", "The component's own tables. Your functions can't read them; the dashboard lists them under the mount name.", "| Table | Indexes |\n|---|---|\n" + tables.join("\n"));
    }
  }

  // Exported functions and values, with their one-line doc comments where they have one.
  const docs = new Map<string, string>();
  for (const f of files) {
    for (const [, doc, fn] of readFileSync(f, "utf8").matchAll(/\/\*\* ([^\n]*?) \*\/\nexport (?:async )?(?:function|const) (\w+)/g)) docs.set(fn!, doc!);
  }
  const exported = new Set<string>();
  for (const [, fn] of index.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)) exported.add(fn!);
  for (const [, list] of index.matchAll(/^export \{([^}]*)\} from/gm)) {
    for (const item of list!.split(",").map((s) => s.trim())) if (item && !item.startsWith("type ")) exported.add(item.split(/\s+as\s+/).pop()!);
  }
  exported.delete("definition");
  if (exported.size) {
    parts.push("## Exports", [...exported].map((fn) => `- \`${fn}\`${docs.has(fn) ? `: ${docs.get(fn)}` : ""}`).join("\n"));
  }

  parts.push(
    "## Source",
    `This page is generated from the package's source in [onebase-components](${COMPONENTS_REPO}/tree/main/packages/${slug}). Start with [src/index.ts](${blob(join(srcDir, "index.ts"))}); the tests in \`test/\` show each function in use. See [Components](./components.md) for how mounting, \`expose\` and \`auth\` work.`,
  );
  return parts.join("\n\n") + "\n";
}

/** Which package names are on npm, so the install section can say `bun add`. */
export async function publishedOnNpm(names: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  await Promise.all(
    names.map(async (n) => {
      try {
        const r = await fetch(`https://registry.npmjs.org/${n.replace("/", "%2f")}`, { method: "HEAD", signal: AbortSignal.timeout(4000) });
        if (r.ok) found.add(n);
      } catch {}
    }),
  );
  return found;
}

/** Package names for every package directory, read before the pages are built. */
export function packageNames(dir: string): string[] {
  const pkgsDir = join(dir, "packages");
  return readdirSync(pkgsDir)
    .filter((d) => existsSync(join(pkgsDir, d, "package.json")))
    .map((d) => (JSON.parse(readFileSync(join(pkgsDir, d, "package.json"), "utf8")) as { name: string }).name);
}
