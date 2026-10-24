// Built-in auth: email/password, OAuth and sessions, served at /api/auth/*.
// Users are documents in the app's "users" table, so functions can read and extend them.
// Password hashes, OAuth account links, sessions and one-time codes live in system tables
// that functions can't reach. Tokens and codes are stored as SHA-256 hashes only.

import type { FunctionLike } from "../api";
import type { AuthMethod, OAuthMethod, OAuthProfile, OAuthTokens, PasswordMethod } from "../auth";
import type { UserIdentity } from "../server";
import { validate, type AnyValidator } from "../values";
import { OnebaseError, type DatabaseImpl } from "./database";
import { newId } from "./dialect";
import type { Exec } from "./driver";
import type { AuthConfig } from "./jwt";
import type { Runtime } from "./runtime";

/** Session tokens start with this, so they're told apart from JWTs and custom tokens. */
export const SESSION_PREFIX = "ob_s_";

const DAY = 86_400_000;
const STATE_TTL = 10 * 60_000;
const LOGIN_CODE_TTL = 2 * 60_000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 3_600_000;
const MAX_PASSWORD = 1024;
const EMAIL_CODE_TTL = 15 * 60_000;
const MAX_CODES_SENT = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An error for the person signing in, with the HTTP status to send. */
export class AuthError extends OnebaseError {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("base64url");
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** An 8-digit code, easy to type from an email. */
function randomCode(): string {
  const n = new Uint32Array(1);
  do crypto.getRandomValues(n);
  while (n[0]! >= 4_200_000_000); // a multiple of 10^8, so every code is equally likely
  return String(n[0]! % 100_000_000).padStart(8, "0");
}
const normalizeEmail = (email: unknown) => (typeof email === "string" ? email.trim().toLowerCase() : "");
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

function isUniqueViolation(err: unknown): boolean {
  const e = err as { errno?: unknown; code?: unknown; message?: unknown };
  return e?.errno === "23505" || /UNIQUE constraint|SQLITE_CONSTRAINT|duplicate key/i.test(String(e?.code ?? "") + String(e?.message ?? ""));
}

function identityFor(user: Record<string, any>, sessionId: string): UserIdentity {
  return defined({
    subject: user._id,
    issuer: "onebase",
    tokenIdentifier: `onebase|${user._id}`,
    sessionId,
    email: user.email,
    name: user.name,
    pictureUrl: user.image,
    emailVerified: typeof user.emailVerificationTime === "number" ? true : undefined,
  }) as UserIdentity;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function page(status: number, message: string): Response {
  const text = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return new Response(`<!doctype html><meta charset="utf-8"><title>Sign-in</title><p style="font:16px system-ui;margin:3em auto;max-width:32em">${text}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function withParams(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** A session, a redirect to an OAuth provider, or "check your email for a code". */
type SignInResult = { token: string; userId: string } | { redirect: string } | { codeSent: true };

export class AuthService {
  readonly methods: AuthMethod[];
  private readonly password: PasswordMethod | null;
  private readonly oauth = new Map<string, OAuthMethod>();
  private readonly sessionMs: number;
  private readonly redirects: string[];
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly runtime: Runtime,
    config: AuthConfig,
  ) {
    this.methods = config.methods ?? [];
    this.password = null;
    for (const m of this.methods) {
      if (m?.kind === "password") this.password = m;
      else if (m?.kind === "oauth") {
        if (this.oauth.has(m.id)) throw new Error(`auth.config.ts: sign-in method "${m.id}" is listed twice.`);
        this.oauth.set(m.id, m);
      } else throw new Error(`auth.config.ts: methods must come from "onebase/auth", e.g. methods: [password(), github()].`);
    }
    this.sessionMs = (config.sessionDays ?? 30) * DAY;
    this.redirects = config.redirects ?? [];
  }

  get ids(): string[] {
    return this.methods.map((m) => m.id);
  }

  /** Startup (and deploy) check: sign-in creates documents in "users", so the schema must accept them. */
  check(schema = this.runtime.schema) {
    if (!schema) return;
    const users = schema.tables.users as { validator: AnyValidator } | undefined;
    if (!users) {
      throw new Error(
        `Built-in auth keeps users in a "users" table, and schema.ts doesn't have one. ` +
          `Add it with defineSchema({ ...authTables, ... }) (import { authTables } from "onebase/server").`,
      );
    }
    if (this.password?.verifyEmail && users.validator.kind === "object" && !("emailVerificationTime" in users.validator.fields!)) {
      throw new Error(`password({ verifyEmail: true }) records verification in users.emailVerificationTime: add it to the users table (it's in authTables).`);
    }
    const errors = this.password?.profile ? [] : validate(users.validator, { email: "someone@example.com" }, "user");
    if (errors.length) {
      throw new Error(
        `The "users" table must accept new users created at sign-up, like { email }:\n  - ${errors.join("\n  - ")}\n` +
          `Make the other fields v.optional(...), or set them with password({ profile: (params) => ({ ... }) }).`,
      );
    }
  }

  // ---- Sessions ----

  /** The identity for a session token; throws if it's expired, signed out or its user is gone. */
  async identifySession(token: string): Promise<UserIdentity> {
    const row = await this.runtime.withReader((tx) => tx.get("SELECT id, user_id, expires, last_used FROM _auth_sessions WHERE token_hash = ?", [sha256(token)]));
    const now = Date.now();
    if (!row || Number(row.expires) < now) throw new AuthError("Your session has expired or you were signed out. Sign in again.", 401);
    const user = await this.runtime.adminRead((db) => db.get(row.user_id));
    if (!user) {
      await this.runtime.withWriter((tx) => tx.run("DELETE FROM _auth_sessions WHERE user_id = ?", [row.user_id]));
      throw new AuthError("This account no longer exists.", 401);
    }
    // Sessions last `sessionDays` from their last use; extending once a day keeps writes rare.
    if (now - Number(row.last_used) > DAY) {
      void this.runtime
        .withWriter((tx) => tx.run("UPDATE _auth_sessions SET last_used = ?, expires = ? WHERE id = ?", [now, now + this.sessionMs, row.id]))
        .catch(() => {});
    }
    return identityFor(user, row.id);
  }

  private async createSession(tx: Exec, userId: string): Promise<string> {
    const token = SESSION_PREFIX + randomToken();
    const now = Date.now();
    await tx.run("INSERT INTO _auth_sessions (id, token_hash, user_id, created, expires, last_used) VALUES (?, ?, ?, ?, ?, ?)", [
      newId(),
      sha256(token),
      userId,
      now,
      now + this.sessionMs,
      now,
    ]);
    if (Math.random() < 0.05) {
      await tx.run("DELETE FROM _auth_sessions WHERE expires < ?", [now]);
      await tx.run("DELETE FROM _auth_codes WHERE expires < ?", [now]);
      await tx.run("DELETE FROM _auth_attempts WHERE window_start < ?", [now - FAILURE_WINDOW]);
    }
    return token;
  }

  private async signOut(token: string | null, everywhere: boolean) {
    if (!token?.startsWith(SESSION_PREFIX)) throw new AuthError("Signing out needs the session token: Authorization: Bearer <token>.", 401);
    await this.runtime.authWrite(async ({ tx, revoke }) => {
      const row = await tx.get("SELECT id, user_id FROM _auth_sessions WHERE token_hash = ?", [sha256(token)]);
      if (!row) return; // already signed out
      if (everywhere) {
        revoke((await tx.all("SELECT id FROM _auth_sessions WHERE user_id = ?", [row.user_id])).map((r) => r.id as string));
        await tx.run("DELETE FROM _auth_sessions WHERE user_id = ?", [row.user_id]);
      } else {
        revoke([row.id]);
        await tx.run("DELETE FROM _auth_sessions WHERE id = ?", [row.id]);
      }
    });
  }

  // ---- One-time codes (OAuth state, login codes) ----

  private async saveCode(code: string, kind: string, data: Record<string, unknown>, ttl: number) {
    await this.runtime.withWriter((tx) =>
      tx.run("INSERT INTO _auth_codes (code_hash, kind, data, expires) VALUES (?, ?, ?, ?)", [sha256(code), kind, JSON.stringify(data), Date.now() + ttl]),
    );
  }

  /** Returns a code's data and deletes it: each code works once. */
  private takeCode(code: string, kind: string): Promise<Record<string, any> | null> {
    return this.runtime.withWriter(async (tx) => {
      const hash = sha256(code);
      const row = await tx.get("SELECT data, expires FROM _auth_codes WHERE code_hash = ? AND kind = ?", [hash, kind]);
      if (!row) return null;
      await tx.run("DELETE FROM _auth_codes WHERE code_hash = ?", [hash]);
      return Number(row.expires) >= Date.now() ? JSON.parse(row.data) : null;
    });
  }

  // ---- HTTP ----

  /** Handles /api/auth/*; returns null for unknown paths. `origins` are the --cors origins (null: any). */
  async handle(req: Request, url: URL, origins: Set<string> | null): Promise<Response | null> {
    const path = url.pathname.slice("/api/auth/".length);
    try {
      if (path === "methods" && req.method === "GET") {
        return json({ methods: this.methods.map((m) => ({ id: m.id, kind: m.kind, name: m.kind === "oauth" ? m.name : "Password" })) });
      }
      if (path === "signin" && req.method === "POST") return json(await this.signIn(await this.body(req), origins));
      if (path === "signout" && req.method === "POST") {
        const header = req.headers.get("Authorization");
        await this.signOut(header?.startsWith("Bearer ") ? header.slice(7) : null, (await this.body(req)).everywhere === true);
        return json({ ok: true });
      }
      const callback = /^callback\/([a-z0-9_-]+)$/.exec(path);
      if (callback && req.method === "GET") return await this.callback(callback[1]!, url);
      return null;
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message }, err.status);
      if (err instanceof OnebaseError) return json({ error: err.message }, 400);
      const message = err instanceof Error ? err.message : String(err);
      this.runtime.log.error(`Auth: ${message}`);
      return json({ error: this.runtime.dev ? message : "Sign-in failed. Try again." }, 500);
    }
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

  private async signIn(body: Record<string, any>, origins: Set<string> | null): Promise<SignInResult> {
    if (typeof body.code === "string") return this.redeemCode(body.code, body.verifier);
    const provider = body.provider;
    if (provider === "password" && this.password) return this.signInPassword(this.password, body.params ?? {});
    const method = typeof provider === "string" ? this.oauth.get(provider) : undefined;
    if (method) return { redirect: await this.startOAuth(method, body.redirectTo, body.challenge, origins) };
    throw new AuthError(`Unknown sign-in method ${JSON.stringify(provider)}. Enabled: ${this.ids.join(", ") || "none"}.`);
  }

  // ---- Password ----

  private async signInPassword(method: PasswordMethod, params: Record<string, unknown>): Promise<SignInResult> {
    const email = normalizeEmail(params.email);
    if (!EMAIL.test(email)) throw new AuthError("Enter a valid email address.");
    const flow = params.flow ?? "signIn";
    switch (flow) {
      case "signIn":
        return this.passwordSignIn(method, email, this.checkPassword(params.password, 1));
      case "signUp":
        return this.signUp(method, email, this.checkPassword(params.password, method.minLength), params);
      case "reset":
        return this.requestReset(method, email);
      case "reset-verification":
        return this.resetPassword(method, email, params.code, this.checkPassword(params.newPassword, method.minLength));
      case "email-verification":
        return this.confirmEmail(email, params.code);
      default:
        throw new AuthError(`flow must be one of signIn, signUp, reset, reset-verification, email-verification; got ${JSON.stringify(flow)}.`);
    }
  }

  private checkPassword(password: unknown, minLength: number): string {
    if (typeof password !== "string" || password.length === 0) throw new AuthError("Enter a password.");
    if (password.length > MAX_PASSWORD) throw new AuthError("That password is too long.");
    if (password.length < minLength) throw new AuthError(`Use a password with at least ${minLength} characters.`);
    return password;
  }

  /** The user behind an email's password account, or null. */
  private async passwordUser(email: string): Promise<{ user: Record<string, any>; secret: string } | null> {
    const account = await this.runtime.withReader((tx) =>
      tx.get("SELECT user_id, secret FROM _auth_accounts WHERE provider = 'password' AND account_id = ?", [email]),
    );
    const user = account ? await this.runtime.adminRead((db) => db.get(account.user_id)) : null;
    return user ? { user, secret: account!.secret } : null;
  }

  private async passwordSignIn(method: PasswordMethod, email: string, password: string): Promise<SignInResult> {
    const key = `password:${email}`;
    await this.countAttempt(key, MAX_FAILURES, "failed sign-in attempts");
    const found = await this.passwordUser(email);
    // Verify against a dummy hash for unknown emails, so timing doesn't reveal which emails have accounts.
    const valid = found ? await Bun.password.verify(password, found.secret) : (await Bun.password.verify(password, await this.dummy()), false);
    if (!valid) throw new AuthError("Invalid email or password.", 401);
    await this.runtime.withWriter((tx) => tx.run("DELETE FROM _auth_attempts WHERE key = ?", [key]));
    const user = found!.user;
    if (method.verifyEmail && typeof user.emailVerificationTime !== "number") {
      await this.sendEmailCode(method, email, "verify");
      return { codeSent: true };
    }
    return this.runtime.withWriter(async (tx) => ({ userId: user._id, token: await this.createSession(tx, user._id) }));
  }

  private async signUp(method: PasswordMethod, email: string, password: string, params: Record<string, unknown>): Promise<SignInResult> {
    const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : undefined;
    // Only a confirmed code marks an email verified (OAuth sign-ins join users by verified email).
    const fields = method.profile ? { ...method.profile(params), email, emailVerificationTime: undefined } : defined({ email, name });
    const secret = await Bun.password.hash(password);
    const taken = () => new AuthError("An account with this email already exists. Sign in instead.", 409);
    let result: SignInResult;
    try {
      result = await this.runtime.authWrite(async ({ db, tx }) => {
        const existing = await tx.get("SELECT user_id FROM _auth_accounts WHERE provider = 'password' AND account_id = ?", [email]);
        if (existing) {
          if (await db.get(existing.user_id)) throw taken();
          await tx.run("DELETE FROM _auth_accounts WHERE provider = 'password' AND account_id = ?", [email]); // its user was deleted
        }
        const userId = await db.insert("users", fields);
        await tx.run("INSERT INTO _auth_accounts (provider, account_id, user_id, secret, created) VALUES ('password', ?, ?, ?, ?)", [
          email,
          userId,
          secret,
          Date.now(),
        ]);
        // With verifyEmail, the session comes once the emailed code is confirmed.
        return method.verifyEmail ? { codeSent: true as const } : { userId, token: await this.createSession(tx, userId) };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw taken(); // signed up twice at once
      throw err;
    }
    if ("codeSent" in result) await this.sendEmailCode(method, email, "verify");
    return result;
  }

  // ---- Email codes: verification and password reset ----

  /** Context for sendCode: call your functions, e.g. an internal action that sends email. */
  private readonly sendCtx = {
    runQuery: async (fn: FunctionLike, args?: Record<string, unknown>) =>
      (await this.runtime.runQuery(fn, args ?? {}, { allowInternal: true, source: "auth" })).value,
    runMutation: (fn: FunctionLike, args?: Record<string, unknown>) => this.runtime.runMutation(fn, args ?? {}, { allowInternal: true, source: "auth" }),
    runAction: (fn: FunctionLike, args?: Record<string, unknown>) => this.runtime.runAction(fn, args ?? {}, { allowInternal: true, source: "auth" }),
  };

  /** Counts a code sent to `email`; at most MAX_CODES_SENT an hour, so nobody can flood an inbox. */
  private async countCodeSent(email: string) {
    await this.countAttempt(`send:${email}`, MAX_CODES_SENT, "codes requested for this email");
  }

  /** Creates a code (replacing earlier ones for the same email and purpose) and hands it to sendCode. */
  private async sendEmailCode(method: PasswordMethod, email: string, purpose: "verify" | "reset", counted = false) {
    if (!method.sendCode) throw new AuthError("Email codes aren't set up: add sendCode to password() in auth.config.ts.");
    if (!counted) await this.countCodeSent(email);
    const code = randomCode();
    await this.runtime.withWriter(async (tx) => {
      await tx.run("DELETE FROM _auth_codes WHERE kind = ?", [`${purpose}:${email}`]);
      await tx.run("INSERT INTO _auth_codes (code_hash, kind, data, expires) VALUES (?, ?, ?, ?)", [
        sha256(`${purpose}|${email}|${code}`),
        `${purpose}:${email}`,
        JSON.stringify({ email }),
        Date.now() + EMAIL_CODE_TTL,
      ]);
    });
    try {
      await method.sendCode({ email, code, purpose }, this.sendCtx);
    } catch (err) {
      this.runtime.log.error(`sendCode failed for ${purpose}: ${err instanceof Error ? err.message : String(err)}`);
      throw new AuthError("The code couldn't be sent. Try again in a moment.", 502);
    }
  }

  /** Consumes a code; wrong guesses count toward a lockout, like failed passwords. */
  private async takeEmailCode(purpose: "verify" | "reset", email: string, code: unknown) {
    const key = `code:${email}`;
    await this.countAttempt(key, MAX_FAILURES, "wrong codes");
    const entered = typeof code === "string" ? code.replace(/\s/g, "") : "";
    const valid =
      /^\d{8}$/.test(entered) &&
      (await this.runtime.withWriter(async (tx) => {
        const hash = sha256(`${purpose}|${email}|${entered}`);
        const row = await tx.get("SELECT expires FROM _auth_codes WHERE code_hash = ? AND kind = ?", [hash, `${purpose}:${email}`]);
        if (!row) return false;
        await tx.run("DELETE FROM _auth_codes WHERE code_hash = ?", [hash]);
        return Number(row.expires) >= Date.now();
      }));
    if (!valid) throw new AuthError("That code is wrong or has expired. Request a new one.", 401);
    await this.runtime.withWriter((tx) => tx.run("DELETE FROM _auth_attempts WHERE key = ?", [key]));
  }

  /** Step 1 of a reset. The answer is the same whether or not the email has an account. */
  private async requestReset(method: PasswordMethod, email: string): Promise<SignInResult> {
    if (!method.sendCode) throw new AuthError("Password reset isn't set up: add sendCode to password() in auth.config.ts.");
    await this.countCodeSent(email); // counted (and limited) the same way for unknown emails
    if (await this.passwordUser(email)) {
      // Sent in the background, so the response time doesn't reveal that the account exists either.
      void this.sendEmailCode(method, email, "reset", true).catch(() => {});
    }
    return { codeSent: true };
  }

  /** Step 2 of a reset: a new password, signed in, and every other session ended. */
  private async resetPassword(method: PasswordMethod, email: string, code: unknown, newPassword: string): Promise<SignInResult> {
    await this.takeEmailCode("reset", email, code);
    const secret = await Bun.password.hash(newPassword);
    return this.runtime.authWrite(async ({ db, tx, revoke }) => {
      const account = await tx.get("SELECT user_id FROM _auth_accounts WHERE provider = 'password' AND account_id = ?", [email]);
      const user = account ? await db.get(account.user_id) : null;
      if (!user) throw new AuthError("This account no longer exists.", 401);
      await tx.run("UPDATE _auth_accounts SET secret = ? WHERE provider = 'password' AND account_id = ?", [secret, email]);
      revoke((await tx.all("SELECT id FROM _auth_sessions WHERE user_id = ?", [user._id])).map((r) => r.id as string));
      await tx.run("DELETE FROM _auth_sessions WHERE user_id = ?", [user._id]);
      await tx.run("DELETE FROM _auth_attempts WHERE key = ?", [`password:${email}`]);
      // The code proves they read this inbox.
      if (typeof user.emailVerificationTime !== "number" && "emailVerificationTime" in this.fitUsers({ emailVerificationTime: 1 })) {
        await db.patch(user._id, { emailVerificationTime: Date.now() });
      }
      return { userId: user._id, token: await this.createSession(tx, user._id) };
    });
  }

  /** Confirms the email of a new account (verifyEmail) and signs in. */
  private async confirmEmail(email: string, code: unknown): Promise<SignInResult> {
    await this.takeEmailCode("verify", email, code);
    return this.runtime.authWrite(async ({ db, tx }) => {
      const account = await tx.get("SELECT user_id FROM _auth_accounts WHERE provider = 'password' AND account_id = ?", [email]);
      const user = account ? await db.get(account.user_id) : null;
      if (!user) throw new AuthError("This account no longer exists.", 401);
      if (typeof user.emailVerificationTime !== "number") await db.patch(user._id, { emailVerificationTime: Date.now() });
      return { userId: user._id, token: await this.createSession(tx, user._id) };
    });
  }

  private dummy(): Promise<string> {
    return (this.dummyHash ??= Bun.password.hash(randomToken()));
  }

  /**
   * Counts an attempt before it's made and throws once `key` has been counted more than `max` times
   * within the hour. Counting first, in one write, means parallel requests can't all slip under the
   * limit. A success clears the count.
   */
  private async countAttempt(key: string, max: number, what: string) {
    const now = Date.now();
    const { count, start } = await this.runtime.withWriter(async (tx) => {
      const row = await tx.get("SELECT count, window_start FROM _auth_attempts WHERE key = ?", [key]);
      if (!row) {
        await tx.run("INSERT INTO _auth_attempts (key, count, window_start) VALUES (?, 1, ?)", [key, now]);
        return { count: 1, start: now };
      }
      if (Number(row.window_start) < now - FAILURE_WINDOW) {
        await tx.run("UPDATE _auth_attempts SET count = 1, window_start = ? WHERE key = ?", [now, key]);
        return { count: 1, start: now };
      }
      await tx.run("UPDATE _auth_attempts SET count = count + 1 WHERE key = ?", [key]);
      return { count: Number(row.count) + 1, start: Number(row.window_start) };
    });
    if (count > max) {
      const minutes = Math.max(1, Math.ceil((start + FAILURE_WINDOW - now) / 60_000));
      throw new AuthError(`Too many ${what}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, 429);
    }
  }

  // ---- OAuth ----

  private callbackUrl(method: OAuthMethod) {
    return `${this.runtime.siteUrl}/api/auth/callback/${method.id}`;
  }

  /** Where sign-in may send people back to: the site, --cors origins, auth.config.ts redirects, and localhost in dev. */
  private redirectAllowed(target: string, origins: Set<string> | null): boolean {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (this.runtime.dev && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;
    return [this.runtime.siteUrl, ...(origins ?? []), ...this.redirects].some((allowed) => {
      try {
        // Compare parsed URLs, never the raw text: "https://App.example.com" must not allow
        // "https://App.example.com.evil.test". An origin allows any page on it; a longer URL allows pages under its path.
        const a = new URL(allowed);
        if (a.origin !== url.origin) return false;
        const path = a.pathname.replace(/\/+$/, "");
        return path === "" || url.pathname === path || url.pathname.startsWith(`${path}/`);
      } catch {
        return false;
      }
    });
  }

  private async startOAuth(method: OAuthMethod, redirectTo: unknown, challenge: unknown, origins: Set<string> | null): Promise<string> {
    if (typeof redirectTo !== "string" || !this.redirectAllowed(redirectTo, origins)) {
      throw new AuthError(
        `redirectTo ${JSON.stringify(redirectTo)} isn't allowed. Sign-in can return to ${this.runtime.siteUrl}, ` +
          `your --cors origins, or URLs listed in redirects in auth.config.ts.`,
      );
    }
    if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new AuthError("Missing challenge: send the SHA-256 (base64url) of a random verifier the client keeps until sign-in completes.");
    }
    const { authorizationUrl } = await method.endpoints();
    const state = randomToken();
    const verifier = randomToken();
    await this.saveCode(state, "oauth_state", { provider: method.id, verifier, redirectTo, challenge }, STATE_TTL);
    const url = new URL(authorizationUrl);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: method.clientId,
      redirect_uri: this.callbackUrl(method),
      state,
      code_challenge: sha256(verifier),
      code_challenge_method: "S256",
      ...(method.scopes.length ? { scope: method.scopes.join(" ") } : {}),
      ...method.authorizationParams,
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async callback(id: string, url: URL): Promise<Response> {
    const method = this.oauth.get(id);
    if (!method) return page(404, `Unknown sign-in method "${id}".`);
    const stateParam = url.searchParams.get("state");
    const state = stateParam ? await this.takeCode(stateParam, "oauth_state") : null;
    if (!state || state.provider !== id) return page(400, "This sign-in link has expired or was already used. Go back and try again.");
    const back = (params: Record<string, string>) => Response.redirect(withParams(state.redirectTo, params), 302);
    const error = url.searchParams.get("error");
    if (error) return back({ auth_error: url.searchParams.get("error_description") ?? error });
    const code = url.searchParams.get("code");
    if (!code) return back({ auth_error: `${method.name} didn't send a sign-in code.` });
    try {
      const profile = await method.profile(await this.exchange(method, code, state.verifier));
      if (!profile?.id) throw new Error(`${method.name} didn't return an account id.`);
      const userId = await this.userForOAuth(method, profile);
      const loginCode = randomToken();
      await this.saveCode(loginCode, "login", { userId, challenge: state.challenge }, LOGIN_CODE_TTL);
      return back({ onebase_code: loginCode });
    } catch (err) {
      this.runtime.log.error(`Sign-in with ${method.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      return back({ auth_error: err instanceof AuthError ? err.message : `Sign-in with ${method.name} failed. Try again.` });
    }
  }

  private async exchange(method: OAuthMethod, code: string, verifier: string): Promise<OAuthTokens> {
    const { tokenUrl } = await method.endpoints();
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.callbackUrl(method),
        client_id: method.clientId,
        client_secret: method.clientSecret,
        code_verifier: verifier,
      }),
    });
    const body = (await res.json().catch(() => null)) as OAuthTokens | null;
    if (!res.ok || typeof body?.access_token !== "string") {
      throw new Error(`the token endpoint returned ${res.status}: ${JSON.stringify(body)?.slice(0, 200)}`);
    }
    return body;
  }

  /** Finds or creates the user for an OAuth account. */
  private userForOAuth(method: OAuthMethod, profile: OAuthProfile): Promise<string> {
    return this.runtime.authWrite(async ({ db, tx }) => {
      const account = await tx.get("SELECT user_id FROM _auth_accounts WHERE provider = ? AND account_id = ?", [method.id, profile.id]);
      if (account && (await db.get(account.user_id))) return account.user_id as string;
      if (account) await tx.run("DELETE FROM _auth_accounts WHERE provider = ? AND account_id = ?", [method.id, profile.id]);
      const email = profile.email ? normalizeEmail(profile.email) : undefined;
      const verified = Boolean(email && profile.emailVerified);
      // Join an existing user only if both sides verified the email: otherwise someone could
      // sign up with another person's address first and share their account later.
      let userId: string | null = null;
      if (verified) {
        const sameEmail = await db.query("users").filter({ email }).take(20);
        userId = sameEmail.find((u) => typeof u.emailVerificationTime === "number")?._id ?? null;
      }
      userId ??= await db.insert(
        "users",
        this.fitUsers({ email, name: profile.name, image: profile.image, emailVerificationTime: verified ? Date.now() : undefined }),
      );
      await tx.run("INSERT INTO _auth_accounts (provider, account_id, user_id, secret, created) VALUES (?, ?, ?, NULL, ?)", [
        method.id,
        profile.id,
        userId,
        Date.now(),
      ]);
      return userId;
    });
  }

  /** Drops profile fields the users table doesn't declare, so a custom users table still works. */
  private fitUsers(fields: Record<string, unknown>): Record<string, unknown> {
    const validator = (this.runtime.schema?.tables.users as { validator: AnyValidator } | undefined)?.validator;
    const known = validator?.kind === "object" ? validator.fields! : null;
    return defined(Object.fromEntries(Object.entries(fields).filter(([k]) => !known || k in known)));
  }

  private async redeemCode(code: string, verifier: unknown): Promise<SignInResult> {
    const data = await this.takeCode(code, "login");
    if (!data) throw new AuthError("This sign-in code has expired or was already used. Sign in again.", 401);
    if (typeof verifier !== "string" || sha256(verifier) !== data.challenge) {
      throw new AuthError("This sign-in was started in a different browser. Sign in again here.", 401);
    }
    const user = await this.runtime.adminRead((db: DatabaseImpl) => db.get(data.userId));
    if (!user) throw new AuthError("This account no longer exists.", 401);
    return this.runtime.withWriter(async (tx) => ({ userId: user._id, token: await this.createSession(tx, user._id) }));
  }
}
