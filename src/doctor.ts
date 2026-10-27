// `onebase doctor`: catches the mistakes people (and LLMs) commonly make, with the fix.

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { staleGeneratedFiles } from "./codegen";
import { listSourceFiles, loadProject, modulePathFor, type Project } from "./project";
import { isRegisteredFunction } from "./server";
import type { SearchIndexDef, VectorIndexDef } from "./schema";
import { describeValidator, type AnyValidator } from "./values";

export type Finding = { level: "error" | "warn"; where: string; message: string; fix?: string };

function collectIds(val: AnyValidator | undefined, out: string[]) {
  if (!val) return;
  if (val.kind === "id" && val.tableName) out.push(val.tableName);
  if (val.element) collectIds(val.element, out);
  if (val.values) collectIds(val.values, out);
  for (const m of val.members ?? []) collectIds(m, out);
  for (const f of Object.values(val.fields ?? {})) collectIds(f, out);
}

function acceptsString(val: AnyValidator): boolean {
  return val.kind === "string" || val.kind === "any" || (val.kind === "union" && val.members!.some(acceptsString));
}

/** Can hold an array of numbers (v.array(v.number()), possibly optional or in a union)? */
function acceptsNumberArray(val: AnyValidator): boolean {
  if (val.kind === "any") return true;
  if (val.kind === "union") return val.members!.some(acceptsNumberArray);
  return val.kind === "array" && (val.element!.kind === "number" || val.element!.kind === "any");
}

function checkSchema(project: Project, findings: Finding[]) {
  const schema = project.schema;
  if (!schema) {
    findings.push({
      level: "warn",
      where: "schema.ts",
      message: "No schema.ts: documents aren't validated and ctx.db isn't typed.",
      fix: 'Create schema.ts: export default defineSchema({ messages: defineTable({ body: v.string() }) })',
    });
    return;
  }
  const tables = Object.keys(schema.tables);
  for (const [table, def] of Object.entries(schema.tables) as [string, any][]) {
    const fields = def.validator.kind === "object" ? Object.keys(def.validator.fields) : null;
    const names = new Set<string>();
    for (const index of def.indexes as { name: string; fields: string[] }[]) {
      if (names.has(index.name)) {
        findings.push({ level: "error", where: `schema.ts › ${table}`, message: `Index "${index.name}" is defined twice.` });
      }
      names.add(index.name);
      if (index.name === "by_creation_time" || index.name === "by_id") {
        findings.push({ level: "error", where: `schema.ts › ${table}`, message: `Index name "${index.name}" is reserved.` });
      }
      for (const field of index.fields) {
        const top = field.split(".")[0]!;
        if (fields && top !== "_creationTime" && !fields.includes(top)) {
          findings.push({
            level: "error",
            where: `schema.ts › ${table}.index("${index.name}")`,
            message: `Field "${field}" doesn't exist on "${table}".`,
            fix: `Known fields: ${fields.join(", ")}`,
          });
        }
      }
    }
    for (const index of (def.searchIndexes ?? []) as SearchIndexDef[]) {
      const where = `schema.ts › ${table}.searchIndex("${index.name}")`;
      for (const field of [index.searchField, ...index.filterFields]) {
        if (fields && !fields.includes(field.split(".")[0]!)) {
          findings.push({ level: "error", where, message: `Field "${field}" doesn't exist on "${table}".`, fix: `Known fields: ${fields.join(", ")}` });
        }
      }
      const searched: AnyValidator | undefined = def.validator.fields?.[index.searchField];
      if (searched && !acceptsString(searched)) {
        findings.push({
          level: "error",
          where,
          message: `searchField "${index.searchField}" is ${describeValidator(searched)}; only string fields can be searched.`,
        });
      }
    }
    for (const index of (def.vectorIndexes ?? []) as VectorIndexDef[]) {
      const where = `schema.ts › ${table}.vectorIndex("${index.name}")`;
      for (const field of [index.vectorField, ...index.filterFields]) {
        if (fields && !fields.includes(field.split(".")[0]!)) {
          findings.push({ level: "error", where, message: `Field "${field}" doesn't exist on "${table}".`, fix: `Known fields: ${fields.join(", ")}` });
        }
      }
      const vectors: AnyValidator | undefined = def.validator.fields?.[index.vectorField];
      if (vectors && !acceptsNumberArray(vectors)) {
        findings.push({
          level: "error",
          where,
          message: `vectorField "${index.vectorField}" is ${describeValidator(vectors)}; vectors are arrays of numbers.`,
          fix: `Use v.array(v.float64()), or v.optional(v.array(v.float64())) for documents without one.`,
        });
      }
    }
    const refs: string[] = [];
    collectIds(def.validator, refs);
    for (const ref of refs) {
      if (!tables.includes(ref) && ref !== "_storage") {
        findings.push({
          level: "error",
          where: `schema.ts › ${table}`,
          message: `v.id("${ref}") refers to a table that isn't in the schema.`,
          fix: `Tables: ${tables.join(", ")}`,
        });
      }
    }
  }
}

function checkFunctions(project: Project, findings: Finding[]) {
  let count = 0;
  for (const [modulePath, exports] of Object.entries(project.modules)) {
    for (const [name, value] of Object.entries(exports)) {
      if (!isRegisteredFunction(value)) continue;
      count++;
      const where = `${modulePath}.ts › ${name}`;
      if (!value.args) {
        findings.push({
          level: "warn",
          where,
          message: `${value.type} has no args validator, so any input is accepted.`,
          fix: `Add args: { ... } (use args: {} if it takes none).`,
        });
      }
      if (project.schema && value.args) {
        const refs: string[] = [];
        collectIds(value.args, refs);
        for (const ref of refs.filter((r) => r !== "_storage" && !(r in project.schema!.tables))) {
          findings.push({ level: "error", where, message: `args use v.id("${ref}") but "${ref}" isn't a table in schema.ts.` });
        }
      }
    }
  }
  const names = new Set(Object.entries(project.modules).flatMap(([m, ex]) => Object.keys(ex).map((e) => `${m}:${e}`)));
  for (const job of project.crons?.jobs ?? []) {
    if (!names.has(job.fn)) {
      findings.push({ level: "error", where: `crons.ts › ${job.name}`, message: `Cron calls "${job.fn}", which doesn't exist.` });
    }
  }
  if (count === 0 && !findings.some((f) => f.message.startsWith("Failed to load"))) {
    findings.push({
      level: "warn",
      where: relative(process.cwd(), project.dir) || ".",
      message: "No functions found.",
      fix: 'Export one: export const list = query({ args: {}, handler: async (ctx) => ctx.db.query("messages").collect() })',
    });
  }
}

/**
 * Is the `.filter(` at `column` of `lines[i]` called on a database query rather than an array?
 * Follows a method chain back over lines that start with "." and looks for `.query(` with no
 * array-producing call (`.collect()`, `.take()`, …) between it and the filter.
 */
function filtersQuery(lines: string[], i: number, column: number): boolean {
  let start = i;
  while (start > 0 && i - start < 10 && /^\s*\./.test(lines[start]!)) start--;
  const before = [...lines.slice(start, i), lines[i]!.slice(0, column)].join("\n");
  const q = before.lastIndexOf(".query(");
  return q !== -1 && !/\.(collect|take|first|unique|paginate)\(/.test(before.slice(q));
}

const SOURCE_RULES: {
  pattern: RegExp;
  message: string;
  fix: string;
  level: "error" | "warn";
  /** Extra check on a match, for rules a regex alone can't decide. */
  applies?: (lines: string[], i: number, match: RegExpExecArray) => boolean;
}[] = [
  {
    pattern: /from\s+["']convex\/(server|values)["']/,
    message: "Imports from the convex package instead of onebase.",
    fix: 'Use "./_generated/server" for query/mutation/action and "onebase/values" for v.',
    level: "error",
  },
  {
    pattern: /["']use node["']/,
    message: '"use node" is not needed: every function can use Node and npm packages.',
    fix: 'Remove the "use node" line.',
    level: "warn",
  },
  {
    pattern: /\.filter\(\s*\(?\s*\w+(\s*:\s*[\w<>[\]]+)?\s*\)?\s*=>\s*\w+\.(?!eq|neq|lt|lte|gt|gte|and|or|not|field)\w+\s*(===|!==|==|!=|<|>)/,
    message: ".filter() on a query gets a filter builder, not a document.",
    fix: 'Write .filter(q => q.eq(q.field("x"), value)) or .filter({ x: value }).',
    level: "error",
    // Array .filter() takes a document callback, as usual.
    applies: (lines, i, match) => filtersQuery(lines, i, match.index),
  },
];

function checkSources(dir: string, files: string[], findings: Finding[]) {
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of SOURCE_RULES) {
        const match = rule.pattern.exec(line);
        if (match && (!rule.applies || rule.applies(lines, i, match))) {
          findings.push({ level: rule.level, where: `${modulePathFor(dir, file)}.ts:${i + 1}`, message: rule.message, fix: rule.fix });
        }
      }
    });
  }
}

export async function doctor(dirInput: string): Promise<Finding[]> {
  const dir = resolve(dirInput);
  const findings: Finding[] = [];
  const files = await listSourceFiles(dir).catch(() => []);
  checkSources(dir, files, findings);
  let project: Project;
  try {
    project = await loadProject(dir, (err) => {
      const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
      findings.push({ level: "error", where: `${modulePathFor(dir, err.file)}.ts`, message: `Failed to load: ${cause}` });
    });
  } catch (err) {
    findings.push({ level: "error", where: relative(process.cwd(), dir) || ".", message: err instanceof Error ? err.message : String(err) });
    return findings;
  }
  checkSchema(project, findings);
  checkFunctions(project, findings);
  const stale = await staleGeneratedFiles(dir);
  if (stale.length) {
    findings.push({
      level: "warn",
      where: "_generated",
      message: `${stale.length} generated file(s) are missing or out of date.`,
      fix: "Run onebase codegen (onebase dev does it automatically).",
    });
  }
  return findings;
}

export function printFindings(findings: Finding[], log: (line: string) => void = console.log): void {
  if (findings.length === 0) {
    log("\x1b[32m✓\x1b[0m No problems found.");
    return;
  }
  for (const f of findings) {
    const tag = f.level === "error" ? "\x1b[31m✗ error\x1b[0m" : "\x1b[33m⚠ warn \x1b[0m";
    log(`${tag} ${f.where}: ${f.message}`);
    if (f.fix) log(`         fix: ${f.fix}`);
  }
  const errors = findings.filter((f) => f.level === "error").length;
  log(`\n${errors} error(s), ${findings.length - errors} warning(s)`);
}
