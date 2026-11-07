// MCP: serve the app's tools to AI agents (Claude, ChatGPT, Cursor, Claude Code) at /mcp, with
// sign-in through OAuth 2.1 or API keys. Imported as "onebase/mcp".
//
//   // onebase/mcp.ts
//   export default defineMcp({ name: "Notes", version: "1.0.0", consentUrl: "/connect", scopes: { read: "Read your notes" } });
//   export const listNotes = tool({ description: "...", scope: "read", args: {}, handler: (ctx) => ctx.runQuery(api.notes.mine) });
//
// A tool is an internal action with a description: it runs like any action (on a worker thread,
// in the dashboard's logs), and ctx.auth is the user who approved the agent.

import type { ActionCtx, Auth, RegisteredFunction } from "./server";
import { functionBuilder } from "./server";
import { asObjectValidator, isValidator, type AnyValidator, type Infer, type ObjectType, type PropertyValidators } from "./values";

/** Hints for the agent about what a tool does (MCP tool annotations). */
export type ToolAnnotations = {
  /** The tool only reads. */
  readOnlyHint?: boolean;
  /** The tool may delete or overwrite data (meaningful when it isn't read-only). */
  destructiveHint?: boolean;
  /** Calling it again with the same arguments has no further effect. */
  idempotentHint?: boolean;
  /** It reaches outside the app (the web, other services). */
  openWorldHint?: boolean;
};

export type McpToolInfo = {
  /** The tool's name for agents (default: the export's name). Letters, digits, _ and -. */
  name?: string;
  /** A human-readable name. */
  title?: string;
  /** What the tool does and when to use it: the agent reads this to decide. */
  description: string;
  /**
   * The scope a connection needs to see and call this tool: a key of defineMcp's `scopes`.
   * Without it, every connection can use the tool.
   */
  scope?: string;
  annotations?: ToolAnnotations;
};

/** A tool: an internal action carrying its MCP description. */
export type McpTool<Args = any, Returns = any> = RegisteredFunction<"action", "internal", Args, Returns> & { readonly mcp: McpToolInfo };

type InferArgs<A> = A extends AnyValidator ? Infer<A> : A extends PropertyValidators ? ObjectType<A> : never;

/**
 * Defines a tool. `args` (and `returns`) are validators: agents get them as JSON Schema, and
 * arguments that don't match go back to the agent as an error it can fix. Declare `returns` on
 * tools that return objects: it's checked, so it also limits what reaches the agent.
 */
export function tool<A extends PropertyValidators | AnyValidator, R>(
  def: McpToolInfo & { args: A; returns?: AnyValidator; handler: (ctx: ActionCtx<any, any>, args: InferArgs<A>) => R },
): McpTool<InferArgs<A>, Awaited<R>>;
export function tool<R>(def: McpToolInfo & { args?: undefined; returns?: AnyValidator; handler: (ctx: ActionCtx<any, any>, args: {}) => R }): McpTool<{}, Awaited<R>>;
export function tool(def: any): McpTool {
  if (typeof def?.description !== "string" || !def.description.trim()) {
    throw new Error("tool({ description }) needs a description: agents read it to decide when to use the tool.");
  }
  if (def.name !== undefined && (typeof def.name !== "string" || !TOOL_NAME.test(def.name))) {
    throw new Error(`tool({ name: ${JSON.stringify(def.name)} }): use 1-64 letters, digits, _ or -.`);
  }
  if (def.args !== undefined && !isValidator(def.args) && (typeof def.args !== "object" || def.args === null)) {
    throw new Error("tool({ args }) must be validators, e.g. args: { text: v.string() }.");
  }
  const fn = functionBuilder("action", "internal")({ args: def.args, returns: def.returns, handler: def.handler });
  const info: McpToolInfo = { description: def.description.trim() };
  if (def.name !== undefined) info.name = def.name;
  if (def.title !== undefined) info.title = String(def.title);
  if (def.scope !== undefined) info.scope = String(def.scope);
  if (def.annotations !== undefined) info.annotations = { ...def.annotations };
  return { ...fn, mcp: info };
}

export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type McpConfig = {
  /** The server's name, shown to the agent and on its connection list. */
  name: string;
  version?: string;
  /** Guidance for the agent on how to use the tools together. */
  instructions?: string;
  /**
   * Your page that asks a signed-in user to approve an agent: a path on the site ("/connect") or a
   * full URL. It's opened as `<consentUrl>?request=<id>`. Without it only API keys work.
   */
  consentUrl?: string;
  /**
   * Device pairing for agents that can't open a browser: your page where a signed-in user enters
   * the agent's code ("/device"), opened as `<deviceUrl>?code=<user code>`. Without it the device
   * flow is off. It can be the same page as auth.config.ts's deviceUrl.
   */
  deviceUrl?: string;
  /** Named permissions users grant an agent, with a sentence each for the consent page: { read: "Read your notes" }. */
  scopes?: Record<string, string>;
  /** How long an access token lasts, in seconds (default 3600). Refresh tokens rotate on every use. */
  accessTokenSeconds?: number;
  /** How long an unused refresh token or connection lasts, in days (default 30). */
  refreshTokenDays?: number;
};

export type McpDefinition = McpConfig & { readonly __onebase: "mcp" };

/** Configures the MCP server: `export default defineMcp({ ... })` in onebase/mcp.ts. */
export function defineMcp(config: McpConfig): McpDefinition {
  if (typeof config?.name !== "string" || !config.name.trim()) throw new Error('defineMcp({ name }) needs a name, e.g. defineMcp({ name: "Notes" }).');
  for (const [scope, text] of Object.entries(config.scopes ?? {})) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(scope)) throw new Error(`defineMcp: scope "${scope}" must be 1-64 letters, digits or _ . : -.`);
    if (typeof text !== "string" || !text.trim()) throw new Error(`defineMcp: scope "${scope}" needs a description for the consent page.`);
  }
  for (const key of ["consentUrl", "deviceUrl"] as const) {
    const url = config[key];
    if (url !== undefined && (typeof url !== "string" || !/^(\/|https?:\/\/)/.test(url))) {
      throw new Error(`defineMcp({ ${key} }) must be a path like "/connect" or a full https:// URL.`);
    }
  }
  for (const key of ["accessTokenSeconds", "refreshTokenDays"] as const) {
    const n = config[key];
    if (n !== undefined && !(typeof n === "number" && n > 0)) throw new Error(`defineMcp({ ${key} }) must be a positive number.`);
  }
  return { ...config, __onebase: "mcp" };
}

export function isMcpTool(x: unknown): x is McpTool {
  return typeof x === "object" && x !== null && (x as any).__onebase === "function" && typeof (x as any).mcp === "object";
}

/** Who is calling a tool: the user, the agent's connection and the scopes they granted it. */
export type McpCaller = {
  userId: string;
  connectionId: string;
  clientId: string | null;
  clientName: string;
  scopes: string[];
};

/** The agent's connection behind a tool call, or null when the caller isn't an MCP agent. */
export async function getMcpCaller(ctx: { auth: Auth }): Promise<McpCaller | null> {
  const identity = await ctx.auth.getUserIdentity();
  const mcp = identity?.mcp as Omit<McpCaller, "userId"> | undefined;
  return identity && mcp && typeof mcp === "object" ? { userId: identity.subject, ...mcp } : null;
}

// ---- Validators as JSON Schema ----

/** A validator as JSON Schema, for a tool's inputSchema and outputSchema. */
export function toJsonSchema(validator: AnyValidator): Record<string, unknown> {
  switch (validator.kind) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "any":
      return {};
    case "id":
      return { type: "string", description: `An id from the "${validator.tableName}" table.` };
    case "literal":
      return { type: typeof validator.value, const: validator.value };
    case "array":
      return { type: "array", items: toJsonSchema(validator.element!) };
    case "record":
      return { type: "object", additionalProperties: toJsonSchema(validator.values!) };
    case "union": {
      const members = validator.members!;
      if (members.length && members.every((m) => m.kind === "literal")) {
        const types = [...new Set(members.map((m) => typeof m.value))];
        return { ...(types.length === 1 ? { type: types[0] } : {}), enum: members.map((m) => m.value) };
      }
      return { anyOf: members.map(toJsonSchema) };
    }
    case "object": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(validator.fields ?? {})) {
        properties[key] = toJsonSchema(field);
        if (!field.isOptional) required.push(key);
      }
      return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
    }
  }
}

/** A tool's inputSchema: always an object. */
export function inputSchema(args: AnyValidator | undefined): Record<string, unknown> {
  if (!args) return { type: "object", properties: {} };
  const schema = toJsonSchema(asObjectValidator(args));
  return schema.type === "object" ? schema : { type: "object", properties: {} };
}
