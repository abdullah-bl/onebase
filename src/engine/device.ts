// Device pairing (RFC 8628): a TV, CLI or agent that can't show a sign-in page asks for a code,
// shows the user a short one (WDJB-MJHT), and polls while the user approves it on a device where
// they're signed in. Built-in sign-in uses it to hand the device a session; MCP, to connect an
// agent. Both share the approval endpoints:
//
//   GET  /api/auth/device/request?code=   what's asking (signed in)
//   POST /api/auth/device/approve         { code, approve, scopes? } (signed in)
//   POST /api/auth/device/start           { name? } → codes, for a session (built-in sign-in)
//   POST /api/auth/device/poll            { deviceCode } → status, then { token, userId }
//
// Codes live in _auth_codes, hashed: one row by device code (the secret the device keeps) and one
// by user code (what the user types). A user code is 8 letters from 19 consonants (1.7e10
// codes), lasts 10 minutes, and wrong entries count toward a lockout per user.

import type { UserIdentity } from "../server";
import { AuthError, randomToken, sha256 } from "./auth";
import { OnebaseError } from "./database";
import type { Exec } from "./driver";
import type { Runtime } from "./runtime";

/** No vowels (no words), and nothing that looks alike (0/O, 1/I/L). */
const ALPHABET = "BCDFGHJKMNPQRSTVWXZ";
const CODE_LENGTH = 8;
const TTL = 10 * 60_000;
const MAX_WRONG = 10;
const WINDOW = 3_600_000;
const DEVICE_PREFIX = "ob_d_";

export type DeviceGrant = {
  /** What the device gets once approved: a built-in session, or an MCP connection. */
  kind: "session" | "mcp";
  /** What the device calls itself, shown on the approval page (it can claim any name). */
  name: string;
  /** MCP: the scopes asked for. */
  scopes?: string[];
  /** MCP: the registered client, if any. */
  clientId?: string | null;
  /** The approval page. */
  url: string;
};

type Stored = DeviceGrant & {
  state: "pending" | "approved" | "denied";
  /** Seconds the device must wait between polls; grows each time it polls too fast. */
  interval: number;
  lastPoll: number;
  created: number;
  /** Who approved it, and the scopes they kept. */
  identity?: UserIdentity;
};

export type DeviceCodes = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type PollResult =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; grant: Stored & { identity: UserIdentity } };

function randomUserCode(): string {
  const n = new Uint8Array(1);
  let out = "";
  while (out.length < CODE_LENGTH) {
    crypto.getRandomValues(n);
    // 247 = 13 * 19: every letter equally likely.
    if (n[0]! < 247) out += ALPHABET[n[0]! % ALPHABET.length];
  }
  return out;
}

/** "wdjb mjht", "WDJB-MJHT" and "WDJBMJHT" are the same code. */
export const normalizeUserCode = (code: unknown) => (typeof code === "string" ? code.toUpperCase().replace(/[^A-Z]/g, "") : "");
const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const userKey = (code: string) => sha256(`device-user|${code}`);

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export class DeviceService {
  /** Seconds a device waits between polls at first (RFC 8628 suggests 5). Lower it in tests. */
  static intervalSeconds = 5;

  constructor(private readonly runtime: Runtime) {}

  /** Creates the codes for a device. */
  async start(grant: DeviceGrant): Promise<DeviceCodes> {
    const deviceCode = DEVICE_PREFIX + randomToken();
    const userCode = randomUserCode();
    const now = Date.now();
    const stored: Stored = { ...grant, state: "pending", interval: DeviceService.intervalSeconds, lastPoll: 0, created: now };
    await this.runtime.withWriter(async (tx) => {
      await tx.run("INSERT INTO _auth_codes (code_hash, kind, data, expires) VALUES (?, 'device', ?, ?)", [sha256(deviceCode), JSON.stringify(stored), now + TTL]);
      await tx.run("INSERT INTO _auth_codes (code_hash, kind, data, expires) VALUES (?, 'device_user', ?, ?)", [
        userKey(userCode),
        JSON.stringify({ device: sha256(deviceCode) }),
        now + TTL,
      ]);
    });
    const page = new URL(grant.url, this.runtime.siteUrl + "/").toString();
    const complete = new URL(page);
    complete.searchParams.set("code", formatUserCode(userCode));
    return {
      deviceCode,
      userCode: formatUserCode(userCode),
      verificationUri: page,
      verificationUriComplete: complete.toString(),
      expiresIn: TTL / 1000,
      interval: DeviceService.intervalSeconds,
    };
  }

  /** The device's turn: where the approval stands. An approved (or declined) code is used up here. */
  poll(deviceCode: unknown): Promise<PollResult> {
    if (typeof deviceCode !== "string" || !deviceCode.startsWith(DEVICE_PREFIX)) return Promise.resolve({ status: "expired" });
    const hash = sha256(deviceCode);
    return this.runtime.withWriter(async (tx): Promise<PollResult> => {
      const row = await tx.get("SELECT data, expires FROM _auth_codes WHERE code_hash = ? AND kind = 'device'", [hash]);
      const now = Date.now();
      if (!row || Number(row.expires) < now) return { status: "expired" };
      const stored = JSON.parse(row.data as string) as Stored;
      if (stored.state !== "pending") {
        await this.forget(tx, hash);
        return stored.state === "approved" ? { status: "approved", grant: stored as Stored & { identity: UserIdentity } } : { status: "denied" };
      }
      if (now - stored.lastPoll < stored.interval * 1000) {
        stored.interval += 5;
        stored.lastPoll = now;
        await tx.run("UPDATE _auth_codes SET data = ? WHERE code_hash = ?", [JSON.stringify(stored), hash]);
        return { status: "slow_down", interval: stored.interval };
      }
      stored.lastPoll = now;
      await tx.run("UPDATE _auth_codes SET data = ? WHERE code_hash = ?", [JSON.stringify(stored), hash]);
      return { status: "pending" };
    });
  }

  private async forget(tx: Exec, deviceHash: string) {
    await tx.run("DELETE FROM _auth_codes WHERE code_hash = ?", [deviceHash]);
    await tx.run("DELETE FROM _auth_codes WHERE kind = 'device_user' AND data = ?", [JSON.stringify({ device: deviceHash })]);
  }

  /**
   * The pending request behind a user code, for the signed-in user who typed it. Wrong codes count
   * toward a lockout per user, so nobody can work through the codes from one account.
   */
  private async find(code: unknown, identity: UserIdentity): Promise<{ hash: string; stored: Stored }> {
    const key = `device:${identity.subject}`;
    await this.countAttempt(key);
    const normalized = normalizeUserCode(code);
    const found =
      normalized.length === CODE_LENGTH
        ? await this.runtime.withReader(async (tx) => {
            const user = await tx.get("SELECT data, expires FROM _auth_codes WHERE code_hash = ? AND kind = 'device_user'", [userKey(normalized)]);
            if (!user || Number(user.expires) < Date.now()) return null;
            const hash = (JSON.parse(user.data as string) as { device: string }).device;
            const row = await tx.get("SELECT data FROM _auth_codes WHERE code_hash = ? AND kind = 'device'", [hash]);
            return row ? { hash, stored: JSON.parse(row.data as string) as Stored } : null;
          })
        : null;
    if (!found || found.stored.state !== "pending") throw new AuthError("That code is wrong or has expired. Check the code on your device.", 404);
    await this.runtime.withWriter((tx) => tx.run('DELETE FROM _auth_attempts WHERE "key" = ?', [key]));
    return found;
  }

  private describe(stored: Stored) {
    const descriptions = this.runtime.mcp?.config.scopes ?? {};
    return {
      kind: stored.kind,
      name: stored.name,
      scopes: (stored.scopes ?? []).map((scope) => ({ scope, description: descriptions[scope] ?? scope })),
      created: stored.created,
    };
  }

  private async approve(code: unknown, identity: UserIdentity, approve: boolean, scopes?: unknown) {
    const { hash, stored } = await this.find(code, identity);
    if (approve && stored.kind === "session" && identity.issuer !== "onebase") {
      throw new AuthError("Signing a device in needs a built-in account; this one comes from an external provider.", 400);
    }
    stored.state = approve ? "approved" : "denied";
    if (approve) {
      stored.identity = identity;
      if (Array.isArray(scopes) && stored.scopes) stored.scopes = stored.scopes.filter((s) => scopes.includes(s));
    }
    const { changes } = await this.runtime.withWriter((tx) =>
      tx.run("UPDATE _auth_codes SET data = ? WHERE code_hash = ? AND kind = 'device' AND data LIKE ?", [JSON.stringify(stored), hash, '%"state":"pending"%']),
    );
    if (changes !== 1) throw new AuthError("That code was answered already.", 409);
  }

  private async countAttempt(key: string) {
    const now = Date.now();
    const count = await this.runtime.withWriter(async (tx) => {
      const row = await tx.get('SELECT count, window_start FROM _auth_attempts WHERE "key" = ?', [key]);
      if (!row || Number(row.window_start) < now - WINDOW) {
        await tx.run('DELETE FROM _auth_attempts WHERE "key" = ?', [key]);
        await tx.run('INSERT INTO _auth_attempts ("key", count, window_start) VALUES (?, 1, ?)', [key, now]);
        return 1;
      }
      await tx.run('UPDATE _auth_attempts SET count = count + 1 WHERE "key" = ?', [key]);
      return Number(row.count) + 1;
    });
    if (count > MAX_WRONG) throw new AuthError("Too many wrong codes. Try again in an hour.", 429);
  }

  // ---- HTTP: /api/auth/device/* ----

  /** Handles /api/auth/device/*; null for other paths. */
  async handle(req: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith("/api/auth/device/")) return null;
    const path = url.pathname.slice("/api/auth/device/".length);
    try {
      if (path === "start" && req.method === "POST") return json(await this.startSession(await this.body(req)));
      if (path === "poll" && req.method === "POST") return json(await this.pollSession((await this.body(req)).deviceCode));
      if (path === "request" && req.method === "GET") {
        const { stored } = await this.find(url.searchParams.get("code"), await this.user(req));
        return json(this.describe(stored));
      }
      if (path === "approve" && req.method === "POST") {
        const body = await this.body(req);
        await this.approve(body.code, await this.user(req), body.approve === true, body.scopes);
        return json({ ok: true });
      }
      return json({ error: `Unknown endpoint ${req.method} ${url.pathname}.` }, 404);
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message }, err.status);
      if (err instanceof OnebaseError) return json({ error: err.message }, 400);
      const message = err instanceof Error ? err.message : String(err);
      this.runtime.log.error(`Device sign-in: ${message}`);
      return json({ error: this.runtime.dev ? message : "Something went wrong. Try again." }, 500);
    }
  }

  private async startSession(body: Record<string, any>): Promise<DeviceCodes> {
    const auth = this.runtime.auth;
    if (!auth?.deviceUrl) throw new AuthError('Device sign-in isn\'t set up: add deviceUrl: "/device" to auth.config.ts (with built-in sign-in methods).', 404);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : "A device";
    return this.start({ kind: "session", name, url: auth.deviceUrl });
  }

  private async pollSession(deviceCode: unknown) {
    const result = await this.poll(deviceCode);
    if (result.status !== "approved") return result;
    if (result.grant.kind !== "session" || !this.runtime.auth) return { status: "expired" as const };
    const userId = result.grant.identity.subject;
    if (!(await this.runtime.adminRead((db) => db.get(userId)))) return { status: "expired" as const };
    return { status: "approved" as const, token: await this.runtime.auth.sessionFor(userId), userId };
  }

  private async user(req: Request): Promise<UserIdentity> {
    const header = req.headers.get("Authorization");
    const identity = header?.startsWith("Bearer ") ? await this.runtime.identify(header.slice(7)) : null;
    if (!identity) throw new AuthError("Sign in first: send Authorization: Bearer <session token>.", 401);
    return identity;
  }

  private async body(req: Request): Promise<Record<string, any>> {
    const text = await req.text();
    if (!text) return {};
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && !Array.isArray(body)) return body;
    } catch {}
    throw new AuthError("The request body must be a JSON object.");
  }
}
