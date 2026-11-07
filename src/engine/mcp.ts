// The MCP server: the app's tools at POST /mcp (streamable HTTP, JSON responses), and an OAuth 2.1
// authorization server so agents can connect with one URL: discovery (RFC 9728, RFC 8414),
// dynamic client registration (RFC 7591), authorization code + PKCE, rotating refresh tokens with
// replay detection, and revocation (RFC 7009). API keys work too.
//
// A connection is one approval: a user, an agent (client) and the scopes granted to it. Tokens
// and keys belong to a connection, so revoking it ends them all. Tokens are stored as SHA-256
// hashes, and they only work at /mcp: the regular API refuses them, so an agent never gets more
// than its tools.

import { inputSchema, isMcpTool, toJsonSchema, TOOL_NAME, type McpDefinition, type McpToolInfo } from "../mcp";
import type { RegisteredFunction, UserIdentity } from "../server";
import type { AnyValidator } from "../values";
import { AuthError, identityFor, randomToken, sha256 } from "./auth";
import { OnebaseError } from "./database";
import { newId } from "./dialect";
import type { Exec } from "./driver";
import type { Runtime } from "./runtime";

export const MCP_ACCESS_PREFIX = "ob_mcp_";
export const MCP_REFRESH_PREFIX = "ob_mcpr_";
export const MCP_KEY_PREFIX = "ob_mcpk_";
/** Any token issued for MCP (access, refresh or API key). */
export const isMcpToken = (token: string) => token.startsWith("ob_mcp");

/** Newest first; the first is what we answer with when a client asks for one we don't know. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const REQUEST_TTL = 10 * 60_000;
const CODE_TTL = 5 * 60_000;
const DAY = 86_400_000;
const NEVER = 8.64e15; // API keys don't expire; this is the largest valid Date.
const MAX_REDIRECTS = 10;

type Tool = { name: string; fn: string; info: McpToolInfo; args?: AnyValidator; returns?: AnyValidator };

type ConnectionData = {
  clientName: string;
  scopes: string[];
  /** The identity at approval: used as is for external providers; built-in users are re-read on each call. */
  identity: UserIdentity;
  /** An API key's label. */
  name?: string;
};

type Connection = { id: string; userId: string; clientId: string | null; kind: "oauth" | "key"; data: ConnectionData };

type McpIdentity = UserIdentity & { mcp: { connectionId: string; clientId: string | null; clientName: string; scopes: string[] } };

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

/** An OAuth error for a JSON endpoint (token, register): { error, error_description }. */
class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...MCP_CORS, ...headers } });

function page(status: number, message: string): Response {
  const text = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return new Response(`<!doctype html><meta charset="utf-8"><title>Connect an agent</title><p style="font:16px system-ui;margin:3em auto;max-width:32em">${text}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Redirect URIs a client may register: https, http on loopback (RFC 8252), or an app's own scheme
 * (cursor://, vscode://). Never javascript:, data: and the like, and never a fragment.
 */
function checkRedirect(uri: unknown): string {
  if (typeof uri !== "string" || uri.length > 2000) throw new OAuthError("invalid_redirect_uri", "Each redirect URI must be a URL of at most 2000 characters.");
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new OAuthError("invalid_redirect_uri", `${JSON.stringify(uri)} isn't a URL.`);
  }
  if (url.hash) throw new OAuthError("invalid_redirect_uri", "Redirect URIs can't have a #fragment.");
  const scheme = url.protocol;
  if (scheme === "https:") return uri;
  if (scheme === "http:") {
    if (LOOPBACK.has(url.hostname)) return uri;
    throw new OAuthError("invalid_redirect_uri", "http redirect URIs must be on localhost, 127.0.0.1 or [::1]; use https otherwise.");
  }
  if (["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ws:", "wss:", "ftp:"].includes(scheme) || !/^[a-z][a-z0-9+.-]*:$/.test(scheme)) {
    throw new OAuthError("invalid_redirect_uri", `Redirect URIs can't use ${scheme}`);
  }
  return uri;
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    if (a.protocol !== "http:" || !LOOPBACK.has(a.hostname)) return false;
    return b.protocol === "http:" && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function withParams(url: string, params: Record<string, string | undefined>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const bearer = (req: Request) => {
  const header = req.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
};

export class McpService {
  readonly tools = new Map<string, Tool>();
  private readonly accessMs: number;
  private readonly refreshMs: number;

  constructor(
    private readonly runtime: Runtime,
    readonly config: McpDefinition,
    functions: Map<string, RegisteredFunction>,
  ) {
    const scopes = config.scopes ?? {};
    for (const [fn, value] of functions) {
      if (!isMcpTool(value) || fn.startsWith("components/")) continue;
      const name = value.mcp.name ?? fn.slice(fn.indexOf(":") + 1);
      if (!TOOL_NAME.test(name)) throw new OnebaseError(`${fn}: "${name}" can't be a tool name; pass tool({ name }) with letters, digits, _ or -.`);
      const other = this.tools.get(name);
      if (other) throw new OnebaseError(`Two tools are named "${name}" (${other.fn} and ${fn}); give one tool({ name: "..." }).`);
      if (value.mcp.scope !== undefined && !(value.mcp.scope in scopes)) {
        const known = Object.keys(scopes);
        throw new OnebaseError(`${fn}: scope "${value.mcp.scope}" isn't in defineMcp({ scopes }). ${known.length ? `Known: ${known.join(", ")}.` : "Add scopes to mcp.ts."}`);
      }
      this.tools.set(name, { name, fn, info: value.mcp, args: value.args, returns: value.returns });
    }
    this.accessMs = (config.accessTokenSeconds ?? 3600) * 1000;
    this.refreshMs = (config.refreshTokenDays ?? 30) * DAY;
  }

  private get site() {
    return this.runtime.siteUrl;
  }
  private get resource() {
    return `${this.site}/mcp`;
  }
  private get scopeNames(): string[] {
    return Object.keys(this.config.scopes ?? {});
  }

  /** Handles /mcp, the OAuth discovery documents and /api/mcp/*; null for anything else. */
  async handle(req: Request, url: URL, limited: () => { message: string; retryMs: number } | null): Promise<Response | null> {
    const path = url.pathname;
    const ours =
      path === "/mcp" ||
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp" ||
      path === "/.well-known/oauth-authorization-server" ||
      path.startsWith("/api/mcp/");
    if (!ours) return null;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: MCP_CORS });
    const counted = req.method === "POST" && path !== "/api/mcp/connections";
    const limit = counted ? limited() : null;
    if (limit) return json({ error: "rate_limited", error_description: limit.message }, 429, { "Retry-After": String(Math.ceil(limit.retryMs / 1000)) });
    try {
      if (path === "/mcp") return await this.endpoint(req);
      if (path.startsWith("/.well-known/oauth-protected-resource") && req.method === "GET") return json(this.resourceMetadata());
      if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") return json(this.serverMetadata());
      const rest = path.slice("/api/mcp/".length);
      if (rest === "oauth/register" && req.method === "POST") return await this.register(req);
      if (rest === "oauth/authorize" && req.method === "GET") return await this.authorizeStart(url);
      if (rest === "oauth/token" && req.method === "POST") return await this.token(req);
      if (rest === "oauth/revoke" && req.method === "POST") return await this.revokeToken(req);
      if (rest === "request" && req.method === "GET") return await this.describeRequest(url);
      if (rest === "authorize" && req.method === "POST") return await this.authorize(req);
      if (rest === "connections" && req.method === "GET") return json({ connections: await this.listConnections(await this.user(req)) });
      if (rest === "connections/revoke" && req.method === "POST") return await this.revokeConnection(req);
      if (rest === "keys" && req.method === "POST") return await this.createKey(req);
      return json({ error: `Unknown endpoint ${req.method} ${path}.` }, 404);
    } catch (err) {
      if (err instanceof OAuthError) return json({ error: err.error, error_description: err.message }, err.status);
      if (err instanceof AuthError) return json({ error: err.message }, err.status);
      if (err instanceof OnebaseError) return json({ error: err.message }, 400);
      const message = err instanceof Error ? err.message : String(err);
      this.runtime.log.error(`MCP ${req.method} ${path}: ${message}`);
      return json({ error: this.runtime.dev ? message : "Something went wrong. Try again." }, 500);
    }
  }

  // ---- Discovery ----

  private resourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.site],
      bearer_methods_supported: ["header"],
      scopes_supported: this.scopeNames,
      resource_name: this.config.name,
    };
  }

  private serverMetadata() {
    return {
      issuer: this.site,
      authorization_endpoint: `${this.site}/api/mcp/oauth/authorize`,
      token_endpoint: `${this.site}/api/mcp/oauth/token`,
      registration_endpoint: `${this.site}/api/mcp/oauth/register`,
      revocation_endpoint: `${this.site}/api/mcp/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: this.scopeNames,
      authorization_response_iss_parameter_supported: true,
    };
  }

  private unauthorized(error?: string, description?: string): Response {
    const params = [`resource_metadata="${this.site}/.well-known/oauth-protected-resource/mcp"`];
    if (error) params.push(`error="${error}"`, `error_description="${(description ?? "").replace(/["\\]/g, "")}"`);
    return json({ error: error ?? "unauthorized", error_description: description ?? "Connect with OAuth or an API key: Authorization: Bearer <token>." }, 401, {
      "WWW-Authenticate": `Bearer ${params.join(", ")}`,
    });
  }

  // ---- The MCP endpoint ----

  private async endpoint(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      // No server-to-client stream: every answer comes back on the POST that asked.
      return json({ error: "Send MCP messages with POST." }, 405, { Allow: "POST, OPTIONS" });
    }
    const token = bearer(req);
    if (!token) return this.unauthorized();
    const caller = await this.caller(token);
    if (!caller) return this.unauthorized("invalid_token", "This token has expired or was revoked. Connect again.");

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body must be JSON." } }, 400);
    }
    const messages = Array.isArray(body) ? body : [body];
    const replies: unknown[] = [];
    for (const message of messages) {
      const reply = await this.dispatch(message as RpcMessage, caller);
      if (reply instanceof Response) return reply; // a 403 for a tool outside the granted scopes
      if (reply) replies.push(reply);
    }
    if (!replies.length) return new Response(null, { status: 202, headers: MCP_CORS });
    return json(Array.isArray(body) ? replies : replies[0]);
  }

  private visible(tool: Tool, scopes: string[]) {
    return tool.info.scope === undefined || scopes.includes(tool.info.scope);
  }

  private async dispatch(msg: RpcMessage, identity: McpIdentity): Promise<unknown> {
    if (typeof msg !== "object" || msg === null || typeof msg.method !== "string") {
      // A response to a request of ours (we send none) or junk.
      return msg && typeof msg === "object" && "id" in msg && !("result" in msg || "error" in msg)
        ? { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Invalid request." } }
        : null;
    }
    const isNotification = !("id" in msg) || msg.id === undefined;
    const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
    const scopes = identity.mcp.scopes;

    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.config.name, version: this.config.version ?? "1.0.0" },
          ...(this.config.instructions ? { instructions: this.config.instructions } : {}),
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: [...this.tools.values()]
            .filter((t) => this.visible(t, scopes))
            .map((t) => ({
              name: t.name,
              ...(t.info.title ? { title: t.info.title } : {}),
              description: t.info.description,
              inputSchema: inputSchema(t.args),
              ...(t.returns?.kind === "object" ? { outputSchema: toJsonSchema(t.returns) } : {}),
              ...(t.info.annotations || t.info.title ? { annotations: { ...(t.info.title ? { title: t.info.title } : {}), ...t.info.annotations } } : {}),
            })),
        });
      case "tools/call": {
        const name = msg.params?.name;
        const tool = typeof name === "string" ? this.tools.get(name) : undefined;
        if (!tool) return fail(-32602, `Unknown tool ${JSON.stringify(name)}.`);
        if (!this.visible(tool, scopes)) {
          const needed = tool.info.scope!;
          return json(
            { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32001, message: `The tool "${tool.name}" needs the "${needed}" scope, which this connection wasn't granted.` } },
            403,
            {
              "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${[...new Set([...scopes, needed])].join(" ")}", resource_metadata="${this.site}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
        }
        return ok(await this.callTool(tool, msg.params?.arguments ?? {}, identity));
      }
      default:
        if (msg.method.startsWith("notifications/")) return null;
        return fail(-32601, `Method ${JSON.stringify(msg.method)} isn't supported.`);
    }
  }

  /** Runs a tool. Errors (bad arguments included) go back as a tool result the agent can act on. */
  private async callTool(tool: Tool, args: unknown, identity: UserIdentity) {
    try {
      const value = await this.runtime.runAction(tool.fn, args, { identity, allowInternal: true, source: "mcp" });
      const text = typeof value === "string" ? value : (JSON.stringify(value ?? null, null, 2) ?? "null");
      const structured = tool.returns?.kind === "object" && value && typeof value === "object" ? { structuredContent: value } : {};
      return { content: [{ type: "text", text }], ...structured, isError: false };
    } catch (err) {
      return { content: [{ type: "text", text: this.runtime.toClientError(err, tool.name).message }], isError: true };
    }
  }

  // ---- Tokens and connections ----

  /** The identity a token acts as, with its connection under `mcp`; null if it's unknown, expired or revoked. */
  async caller(token: string): Promise<McpIdentity | null> {
    if (!token.startsWith(MCP_ACCESS_PREFIX) && !token.startsWith(MCP_KEY_PREFIX)) return null;
    const row = await this.runtime.withReader((tx) =>
      tx.get(
        "SELECT t.kind AS kind, t.expires AS expires, c.id AS id, c.user_id AS user_id, c.client_id AS client_id, c.kind AS ckind, c.data AS data, c.last_used AS last_used " +
          "FROM _mcp_tokens t JOIN _mcp_connections c ON c.id = t.connection_id WHERE t.token_hash = ?",
        [sha256(token)],
      ),
    );
    const now = Date.now();
    if (!row || (row.kind !== "access" && row.kind !== "key") || Number(row.expires) < now) return null;
    const data = JSON.parse(row.data as string) as ConnectionData;
    let identity = data.identity;
    if (identity.issuer === "onebase" && this.runtime.auth) {
      const user = await this.runtime.adminRead((db) => db.get(row.user_id));
      if (!user) {
        await this.runtime.withWriter((tx) => this.deleteConnections(tx, "user_id = ?", [row.user_id]));
        return null;
      }
      identity = identityFor(user, row.id);
    }
    // Recorded at most once an hour, so calls stay read-only.
    if (now - Number(row.last_used) > 3_600_000) {
      void this.runtime.withWriter((tx) => tx.run("UPDATE _mcp_connections SET last_used = ? WHERE id = ?", [now, row.id])).catch(() => {});
    }
    return { ...identity, mcp: { connectionId: row.id, clientId: row.client_id ?? null, clientName: data.clientName, scopes: data.scopes } };
  }

  private async deleteConnections(tx: Exec, where: string, params: unknown[]) {
    await tx.run(`DELETE FROM _mcp_tokens WHERE connection_id IN (SELECT id FROM _mcp_connections WHERE ${where})`, params);
    await tx.run(`DELETE FROM _mcp_connections WHERE ${where}`, params);
  }

  private async issue(tx: Exec, connectionId: string, scopes: string[]) {
    const now = Date.now();
    const access = MCP_ACCESS_PREFIX + randomToken();
    const refresh = MCP_REFRESH_PREFIX + randomToken();
    await tx.run("INSERT INTO _mcp_tokens (token_hash, connection_id, kind, expires, used) VALUES (?, ?, 'access', ?, 0)", [sha256(access), connectionId, now + this.accessMs]);
    await tx.run("INSERT INTO _mcp_tokens (token_hash, connection_id, kind, expires, used) VALUES (?, ?, 'refresh', ?, 0)", [sha256(refresh), connectionId, now + this.refreshMs]);
    if (Math.random() < McpService.cleanupChance) await this.cleanup(tx);
    return { access_token: access, token_type: "Bearer", expires_in: Math.round(this.accessMs / 1000), refresh_token: refresh, scope: scopes.join(" ") };
  }

  static cleanupChance = 0.05;

  /** Drops expired tokens, OAuth connections unused for longer than a refresh token lasts, and clients nobody uses. */
  private async cleanup(tx: Exec) {
    const now = Date.now();
    await tx.run("DELETE FROM _mcp_tokens WHERE expires < ?", [now]);
    await this.deleteConnections(tx, "kind = 'oauth' AND last_used < ?", [now - this.refreshMs]);
    await tx.run("DELETE FROM _mcp_clients WHERE created < ? AND id NOT IN (SELECT client_id FROM _mcp_connections WHERE client_id IS NOT NULL)", [now - this.refreshMs]);
  }

  /** The signed-in user (any sign-in the app accepts, never an MCP token). */
  private async user(req: Request): Promise<UserIdentity> {
    const token = bearer(req);
    const identity = token ? await this.runtime.identify(token) : null;
    if (!identity) throw new AuthError("Sign in first: send Authorization: Bearer <session token>.", 401);
    return identity;
  }

  private async body(req: Request): Promise<Record<string, any>> {
    const text = await req.text();
    if (!text) return {};
    if ((req.headers.get("Content-Type") ?? "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && !Array.isArray(body)) return body;
    } catch {}
    throw new OAuthError("invalid_request", "The body must be a JSON object or form-encoded.");
  }

  private grantable(requested: unknown): string[] {
    const known = this.scopeNames;
    if (typeof requested !== "string" || !requested.trim()) return known;
    const asked = new Set(requested.split(/\s+/));
    const granted = known.filter((s) => asked.has(s));
    return granted.length ? granted : known;
  }

  // ---- OAuth: registration ----

  private async register(req: Request): Promise<Response> {
    const body = await this.body(req);
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECTS) {
      throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECTS} URIs.`);
    }
    const redirectUris = uris.map(checkRedirect);
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "Unnamed agent";
    const id = `mcp_${randomToken().slice(0, 24)}`;
    const created = Date.now();
    await this.runtime.withWriter((tx) =>
      tx.run("INSERT INTO _mcp_clients (id, data, created) VALUES (?, ?, ?)", [id, JSON.stringify({ name, redirectUris }), created]),
    );
    return json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(created / 1000),
        client_name: name,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  private async client(id: unknown): Promise<{ id: string; name: string; redirectUris: string[] } | null> {
    if (typeof id !== "string" || id.length > 100) return null;
    const row = await this.runtime.withReader((tx) => tx.get("SELECT data FROM _mcp_clients WHERE id = ?", [id]));
    return row ? { id, ...(JSON.parse(row.data as string) as { name: string; redirectUris: string[] }) } : null;
  }

  // ---- OAuth: authorization ----

  /** GET /api/mcp/oauth/authorize: checks the request and sends the browser to the app's consent page. */
  private async authorizeStart(url: URL): Promise<Response> {
    const p = (name: string) => url.searchParams.get(name) ?? undefined;
    const client = await this.client(p("client_id"));
    if (!client) return page(400, "This agent isn't registered with this app. Remove the connection in the agent and add it again.");
    const redirectUri = p("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.some((r) => redirectMatches(r, redirectUri))) {
      return page(400, "The agent asked to return to an address it didn't register, so the connection was stopped.");
    }
    const state = p("state");
    const back = (error: string, description: string) =>
      Response.redirect(withParams(redirectUri, { error, error_description: description, state, iss: this.site }), 302);
    if (p("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = p("code_challenge");
    if (p("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return back("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
    }
    const resource = p("resource");
    if (resource && resource.replace(/\/+$/, "") !== this.resource && resource.replace(/\/+$/, "") !== this.site) {
      return back("invalid_target", `This server is ${this.resource}.`);
    }
    if (!this.config.consentUrl) return back("access_denied", "This app only accepts API keys for MCP.");
    const request = randomToken();
    await this.saveCode(request, "mcp_request", { clientId: client.id, clientName: client.name, redirectUri, challenge, state, scopes: this.grantable(p("scope")) }, REQUEST_TTL);
    return Response.redirect(withParams(new URL(this.config.consentUrl, this.site + "/").toString(), { request }), 302);
  }

  /** GET /api/mcp/request?id=: what the consent page shows. */
  private async describeRequest(url: URL): Promise<Response> {
    const data = await this.peekCode(url.searchParams.get("id") ?? "", "mcp_request");
    if (!data) throw new OAuthError("invalid_request", "This connection request has expired or was already answered. Start again from the agent.", 404);
    let redirectHost = "";
    try {
      const u = new URL(data.redirectUri);
      redirectHost = u.protocol === "http:" || u.protocol === "https:" ? u.host : u.protocol.replace(/:$/, "");
    } catch {}
    return json({
      server: { name: this.config.name },
      client: { id: data.clientId, name: data.clientName, redirectHost },
      scopes: (data.scopes as string[]).map((scope) => ({ scope, description: this.config.scopes?.[scope] ?? scope })),
    });
  }

  /** POST /api/mcp/authorize { request, approve, scopes? }: the signed-in user's answer. */
  private async authorize(req: Request): Promise<Response> {
    const identity = await this.user(req);
    const body = await this.body(req);
    const data = await this.takeCode(String(body.request ?? ""), "mcp_request");
    if (!data) throw new OAuthError("invalid_request", "This connection request has expired or was already answered. Start again from the agent.", 404);
    if (body.approve !== true) {
      return json({ redirect: withParams(data.redirectUri, { error: "access_denied", error_description: "The user declined.", state: data.state, iss: this.site }) });
    }
    let scopes = data.scopes as string[];
    if (Array.isArray(body.scopes)) scopes = scopes.filter((s) => body.scopes.includes(s));
    const code = randomToken();
    await this.saveCode(code, "mcp_code", { ...data, scopes, identity }, CODE_TTL);
    return json({ redirect: withParams(data.redirectUri, { code, state: data.state, iss: this.site }) });
  }

  // ---- OAuth: tokens ----

  private async token(req: Request): Promise<Response> {
    const body = await this.body(req);
    if (body.grant_type === "authorization_code") return json(await this.redeem(body));
    if (body.grant_type === "refresh_token") return json(await this.refresh(body));
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  }

  private async redeem(body: Record<string, any>) {
    const data = await this.takeCode(String(body.code ?? ""), "mcp_code");
    if (!data) throw new OAuthError("invalid_grant", "This code has expired or was already used.");
    if (body.client_id !== data.clientId) throw new OAuthError("invalid_grant", "This code was issued to another client.");
    if (body.redirect_uri !== undefined && body.redirect_uri !== data.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match the authorization request.");
    if (typeof body.code_verifier !== "string" || sha256(body.code_verifier) !== data.challenge) throw new OAuthError("invalid_grant", "code_verifier doesn't match the code_challenge.");
    const identity = data.identity as UserIdentity;
    const conn: ConnectionData = { clientName: data.clientName, scopes: data.scopes, identity };
    const id = newId();
    const now = Date.now();
    return this.runtime.withWriter(async (tx) => {
      await tx.run("INSERT INTO _mcp_connections (id, user_id, client_id, kind, data, created, last_used) VALUES (?, ?, ?, 'oauth', ?, ?, ?)", [
        id,
        identity.subject,
        data.clientId,
        JSON.stringify(conn),
        now,
        now,
      ]);
      return this.issue(tx, id, conn.scopes);
    });
  }

  /** Rotates a refresh token. Using one twice means it leaked, so the whole connection ends. */
  private async refresh(body: Record<string, any>) {
    const token = String(body.refresh_token ?? "");
    const hash = sha256(token);
    const result = await this.runtime.withWriter(async (tx) => {
      const row = token.startsWith(MCP_REFRESH_PREFIX)
        ? await tx.get(
            "SELECT t.used AS used, t.expires AS expires, c.id AS id, c.client_id AS client_id, c.data AS data FROM _mcp_tokens t JOIN _mcp_connections c ON c.id = t.connection_id WHERE t.token_hash = ? AND t.kind = 'refresh'",
            [hash],
          )
        : null;
      if (!row || Number(row.expires) < Date.now()) return { error: "This refresh token has expired or was revoked. Connect again." };
      if (body.client_id !== undefined && body.client_id !== row.client_id) return { error: "This refresh token was issued to another client." };
      const { changes } = await tx.run("UPDATE _mcp_tokens SET used = 1 WHERE token_hash = ? AND used = 0", [hash]);
      if (Number(row.used) || changes !== 1) {
        await this.deleteConnections(tx, "id = ?", [row.id]);
        return { error: "This refresh token was already used, so the connection was ended to be safe. Connect again." };
      }
      await tx.run("UPDATE _mcp_connections SET last_used = ? WHERE id = ?", [Date.now(), row.id]);
      return { tokens: await this.issue(tx, row.id, (JSON.parse(row.data as string) as ConnectionData).scopes) };
    });
    if ("error" in result) throw new OAuthError("invalid_grant", result.error!);
    return result.tokens;
  }

  /** RFC 7009: always 200. A refresh token ends its connection; an access token just itself. */
  private async revokeToken(req: Request): Promise<Response> {
    const token = String((await this.body(req)).token ?? "");
    if (isMcpToken(token)) {
      await this.runtime.withWriter(async (tx) => {
        const row = await tx.get("SELECT connection_id, kind FROM _mcp_tokens WHERE token_hash = ?", [sha256(token)]);
        if (!row) return;
        if (row.kind === "refresh") await this.deleteConnections(tx, "id = ?", [row.connection_id]);
        else await tx.run("DELETE FROM _mcp_tokens WHERE token_hash = ?", [sha256(token)]);
      });
    }
    return new Response(null, { status: 200, headers: MCP_CORS });
  }

  // ---- Settings: connections and API keys ----

  async listConnections(identity: UserIdentity) {
    const rows = await this.runtime.withReader((tx) =>
      tx.all("SELECT id, kind, client_id, data, created, last_used FROM _mcp_connections WHERE user_id = ? ORDER BY created DESC", [identity.subject]),
    );
    return rows.map((r) => {
      const data = JSON.parse(r.data as string) as ConnectionData;
      return {
        id: r.id as string,
        kind: r.kind as "oauth" | "key",
        name: data.name ?? data.clientName,
        clientName: data.clientName,
        scopes: data.scopes,
        created: Number(r.created),
        lastUsed: Number(r.last_used),
      };
    });
  }

  private async revokeConnection(req: Request): Promise<Response> {
    const identity = await this.user(req);
    const { id } = await this.body(req);
    if (typeof id !== "string") throw new OAuthError("invalid_request", "Pass the connection's id: { id }.");
    const removed = await this.runtime.withWriter(async (tx) => {
      const row = await tx.get("SELECT id FROM _mcp_connections WHERE id = ? AND user_id = ?", [id, identity.subject]);
      if (row) await this.deleteConnections(tx, "id = ?", [id]);
      return Boolean(row);
    });
    return json({ ok: true, removed });
  }

  /** POST /api/mcp/keys { name, scopes? }: a key for agents configured by hand. Shown once. */
  private async createKey(req: Request): Promise<Response> {
    const identity = await this.user(req);
    const body = await this.body(req);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : "API key";
    const known = this.scopeNames;
    let scopes = known;
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || body.scopes.some((s: unknown) => typeof s !== "string" || !known.includes(s))) {
        throw new OAuthError("invalid_scope", `scopes must be a list of: ${known.join(", ") || "(this app defines no scopes)"}.`);
      }
      scopes = known.filter((s) => body.scopes.includes(s));
    }
    const key = MCP_KEY_PREFIX + randomToken();
    const id = newId();
    const now = Date.now();
    const data: ConnectionData = { clientName: name, name, scopes, identity };
    await this.runtime.withWriter(async (tx) => {
      await tx.run("INSERT INTO _mcp_connections (id, user_id, client_id, kind, data, created, last_used) VALUES (?, ?, NULL, 'key', ?, ?, ?)", [
        id,
        identity.subject,
        JSON.stringify(data),
        now,
        now,
      ]);
      await tx.run("INSERT INTO _mcp_tokens (token_hash, connection_id, kind, expires, used) VALUES (?, ?, 'key', ?, 0)", [sha256(key), id, NEVER]);
    });
    return json({ id, key, name, scopes });
  }

  // ---- One-time codes (in _auth_codes, shared with built-in auth) ----

  private saveCode(code: string, kind: string, data: Record<string, unknown>, ttl: number) {
    return this.runtime.withWriter((tx) =>
      tx.run("INSERT INTO _auth_codes (code_hash, kind, data, expires) VALUES (?, ?, ?, ?)", [sha256(code), kind, JSON.stringify(data), Date.now() + ttl]),
    );
  }

  private async peekCode(code: string, kind: string): Promise<Record<string, any> | null> {
    if (!code) return null;
    const row = await this.runtime.withReader((tx) => tx.get("SELECT data, expires FROM _auth_codes WHERE code_hash = ? AND kind = ?", [sha256(code), kind]));
    return row && Number(row.expires) >= Date.now() ? JSON.parse(row.data as string) : null;
  }

  private takeCode(code: string, kind: string): Promise<Record<string, any> | null> {
    if (!code) return Promise.resolve(null);
    return this.runtime.withWriter(async (tx) => {
      const hash = sha256(code);
      const row = await tx.get("SELECT data, expires FROM _auth_codes WHERE code_hash = ? AND kind = ?", [hash, kind]);
      if (!row) return null;
      const { changes } = await tx.run("DELETE FROM _auth_codes WHERE code_hash = ?", [hash]);
      return changes === 1 && Number(row.expires) >= Date.now() ? JSON.parse(row.data as string) : null;
    });
  }
}
