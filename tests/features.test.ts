import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { nextCronTime, parseCron } from "../src/cron";
import { createAuthenticate, JwtVerifier } from "../src/engine/jwt";
import { Runtime } from "../src/engine/runtime";
import { SqliteDriver } from "../src/engine/driver";
import { action, cronJobs, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";

// ---------- JWT ----------

const b64url = (data: string | ArrayBuffer) => Buffer.from(data as any).toString("base64url");

async function makeIssuer(alg: "RS256" | "ES256") {
  const params =
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" };
  const pair = (await crypto.subtle.generateKey(params as any, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: `key-${alg}`, alg };
  let jwksFetches = 0;
  let origin = "";
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (path === "/.well-known/openid-configuration") return Response.json({ jwks_uri: `${origin}/jwks` });
      if (path === "/jwks") {
        jwksFetches++;
        return Response.json({ keys: [jwk] });
      }
      return new Response("no", { status: 404 });
    },
  });
  origin = `http://localhost:${server.port}`;
  const sign = async (claims: Record<string, unknown>, kid = jwk.kid) => {
    const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
    const payload = b64url(JSON.stringify(claims));
    const signParams = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
    const sig = await crypto.subtle.sign(signParams as any, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(sig)}`;
  };
  return { origin, sign, server, fetches: () => jwksFetches };
}

describe("JWT auth providers", () => {
  let rs: Awaited<ReturnType<typeof makeIssuer>>;
  let es: Awaited<ReturnType<typeof makeIssuer>>;
  beforeAll(async () => {
    rs = await makeIssuer("RS256");
    es = await makeIssuer("ES256");
  });
  afterAll(() => {
    rs.server.stop(true);
    es.server.stop(true);
  });
  const now = () => Math.floor(Date.now() / 1000);

  test("verifies OIDC (RS256) and custom JWKS (ES256) tokens into an identity", async () => {
    const verifier = new JwtVerifier([
      { domain: rs.origin, applicationID: "my-app" },
      { type: "customJwt", issuer: es.origin, jwks: `${es.origin}/jwks`, algorithm: "ES256" },
    ]);
    const id = await verifier.verify(
      await rs.sign({ iss: rs.origin, sub: "user_1", aud: "my-app", exp: now() + 60, email: "a@b.c", given_name: "Ali", picture: "https://x/p.png" }),
    );
    expect(id).toMatchObject({
      subject: "user_1",
      issuer: rs.origin,
      tokenIdentifier: `${rs.origin}|user_1`,
      email: "a@b.c",
      givenName: "Ali",
      pictureUrl: "https://x/p.png",
    });
    const id2 = await verifier.verify(await es.sign({ iss: es.origin, sub: "u2", exp: now() + 60 }));
    expect(id2.subject).toBe("u2");
    // JWKS is cached between verifications.
    await verifier.verify(await rs.sign({ iss: rs.origin, sub: "user_1", aud: "my-app", exp: now() + 60 }));
    expect(rs.fetches()).toBe(1);
  });

  test("rejects bad tokens with a clear reason", async () => {
    const verifier = new JwtVerifier([{ domain: rs.origin, applicationID: "my-app" }]);
    const reason = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);
    expect(await reason(verifier.verify(await rs.sign({ iss: rs.origin, sub: "u", aud: "my-app", exp: now() - 3600 })))).toContain("expired");
    expect(await reason(verifier.verify(await rs.sign({ iss: rs.origin, sub: "u", aud: "other", exp: now() + 60 })))).toContain("audience");
    expect(await reason(verifier.verify(await rs.sign({ iss: "https://evil.example", sub: "u", aud: "my-app" })))).toContain("isn't configured");
    // Signed by a different key than the issuer's.
    expect(await reason(verifier.verify(await es.sign({ iss: rs.origin, sub: "u", aud: "my-app" }, "key-RS256")))).toMatch(/signature|algorithm|key/);
    const good = await rs.sign({ iss: rs.origin, sub: "u", aud: "my-app", exp: now() + 60 });
    const [h, p, s] = good.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ iss: rs.origin, sub: "admin", aud: "my-app", exp: now() + 60 }))}.${s}`;
    expect(await reason(verifier.verify(forged))).toContain("signature is invalid");
    expect(await reason(verifier.verify("not-a-jwt"))).toContain("expected a JWT");
  });

  test("claims can't replace the identity fields onebase derives", async () => {
    const verifier = new JwtVerifier([{ domain: rs.origin, applicationID: "my-app" }]);
    const id = await verifier.verify(
      await rs.sign({
        iss: rs.origin,
        sub: "attacker",
        aud: "my-app",
        exp: now() + 60,
        tokenIdentifier: "onebase|victimUserId",
        subject: "victimUserId",
        issuer: "onebase",
        sessionId: "victim-session",
        email: "a@b.c",
      }),
    );
    expect(id).toMatchObject({ subject: "attacker", issuer: rs.origin, tokenIdentifier: `${rs.origin}|attacker`, email: "a@b.c" });
    expect(id.sessionId).toBeUndefined();
  });

  test("providers and a custom authenticate() can be combined", async () => {
    const verify = createAuthenticate({
      providers: [{ domain: rs.origin }],
      authenticate: (token) => (token === "api-key-123" ? { subject: "service", tokenIdentifier: "key|service" } : null),
    })!;
    const authenticate = (token: string) => verify(token, { db: null as any });
    expect((await authenticate("api-key-123"))?.subject).toBe("service");
    expect(await authenticate("nope")).toBeNull();
    expect((await authenticate(await rs.sign({ iss: rs.origin, sub: "jwt-user", exp: now() + 60 })))?.subject).toBe("jwt-user");
  });
});

// ---------- Cron ----------

describe("cron expressions", () => {
  const at = (iso: string) => Date.parse(iso);
  const next = (expr: string, from: string) => new Date(nextCronTime(parseCron(expr), at(from))).toISOString();

  test("computes next run times in UTC", () => {
    expect(next("*/15 * * * *", "2026-01-01T10:07:30Z")).toBe("2026-01-01T10:15:00.000Z");
    expect(next("0 3 * * *", "2026-01-01T03:00:00Z")).toBe("2026-01-02T03:00:00.000Z");
    expect(next("30 9 * * mon-fri", "2026-01-02T10:00:00Z")).toBe("2026-01-05T09:30:00.000Z"); // Fri → Mon
    expect(next("0 0 1 */3 *", "2026-02-10T00:00:00Z")).toBe("2026-04-01T00:00:00.000Z");
    expect(next("0 12 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T12:00:00.000Z");
  });

  test("explains invalid expressions", () => {
    expect(() => parseCron("* * *")).toThrow("expected 5 fields");
    expect(() => parseCron("61 * * * *")).toThrow('Invalid cron minute "61"');
    expect(() => cronJobs().interval("x", { seconds: 0 }, "a:b")).toThrow("at least 1 second");
  });
});

describe("cron runner", () => {
  let dir: string;
  let driver: SqliteDriver;
  let runtime: Runtime;
  const ticks: number[] = [];
  const modules = {
    jobs: {
      tick: internalMutation({ args: { n: v.number() }, handler: async (_ctx, { n }) => void ticks.push(n) }),
    },
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onebase-cron-"));
    driver = new SqliteDriver(join(dir, "db.sqlite"));
    ticks.length = 0;
  });
  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs interval jobs and persists the schedule", async () => {
    const crons = cronJobs();
    crons.interval("tick", { seconds: 1 }, "jobs:tick", { n: 7 });
    runtime = new Runtime({ driver, schema: null, modules, crons: crons.jobs, log: { info() {}, warn() {}, error() {} } });
    await runtime.init();
    await runtime.startScheduler();
    await Bun.sleep(1150);
    expect(ticks).toEqual([7]);
    const row = driver.writer.query("SELECT next_run, last_run, last_error FROM _crons WHERE name = 'tick'").get() as any;
    expect(row.last_run).toBeGreaterThan(0);
    expect(row.next_run).toBeGreaterThan(Date.now());
    expect(row.last_error).toBeNull();
  });

  test("fails fast when a cron points at a missing function", async () => {
    const crons = cronJobs();
    crons.daily("bad", { hourUTC: 1, minuteUTC: 0 }, "jobs:nope");
    const errors: string[] = [];
    runtime = new Runtime({ driver, schema: null, modules, crons: crons.jobs, log: { info() {}, warn() {}, error: (m) => errors.push(m) } });
    await runtime.init();
    await runtime.startScheduler();
    await Bun.sleep(20);
    expect(errors.join()).toContain('Function "jobs:nope" not found');
  });
});

// ---------- File storage ----------

/** Local disk always; S3 too when TEST_S3_URL is set (e.g. s3://bucket/prefix?endpoint=http://localhost:9000). */
const FILE_BACKENDS: [string, string | undefined][] = [
  ["local", undefined],
  ...(process.env.TEST_S3_URL ? [["s3", `${process.env.TEST_S3_URL.replace(/\?.*/, "")}/files-${Date.now()}${process.env.TEST_S3_URL.match(/\?.*/)?.[0] ?? ""}`] as [string, string]] : []),
];

for (const [backendName, filesUrl] of FILE_BACKENDS) describe(`file storage (${backendName})`, () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;
  const modules = {
    files: {
      uploadUrl: mutation({ args: {}, handler: (ctx) => ctx.storage.generateUploadUrl() }),
      url: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.getUrl(id) }),
      meta: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.getMetadata(id) }),
      remove: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.delete(id) }),
      removeThenFail: mutation({
        args: { id: v.string() },
        handler: async (ctx, { id }) => {
          await ctx.storage.delete(id);
          throw new Error("rollback");
        },
      }),
      storeFromAction: action({
        args: { text: v.string() },
        handler: async (ctx, { text }) => {
          const id = await ctx.storage.store(new Blob([text], { type: "text/plain" }));
          const blob = await ctx.storage.get(id);
          return { id, roundTrip: await blob!.text() };
        },
      }),
    },
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-files-"));
    app = await startApp({ schema: null, modules, dataDir, files: filesUrl, port: 0, hostname: "127.0.0.1", dev: true, quiet: true });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const stored = (id: string) => (app.runtime.files.backend.get(id) as Blob & { exists(): Promise<boolean> }).exists();

  const call = async (kind: string, path: string, args: unknown) => {
    const res = (await fetch(`${base}/api/${kind}`, { method: "POST", body: JSON.stringify({ path, args }) }).then((r) => r.json())) as any;
    if (res.status !== "success") throw new Error(res.errorMessage);
    return res.value;
  };

  test("upload, serve, metadata, transactional delete", async () => {
    const uploadUrl: string = await call("mutation", "files:uploadUrl", {});
    expect(uploadUrl).toStartWith(`${base}/api/storage/upload?token=`);
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const { storageId } = (await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: png }).then((r) => r.json())) as any;
    expect(typeof storageId).toBe("string");

    // Upload URLs work once.
    const again = await fetch(uploadUrl, { method: "POST", body: "x" });
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error).toContain("invalid or expired");

    const url: string = await call("query", "files:url", { id: storageId });
    const served = await fetch(url);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    expect(await call("query", "files:meta", { id: storageId })).toMatchObject({ _id: storageId, size: 8, contentType: "image/png" });

    // A delete inside a failed mutation is rolled back, and the file stays.
    await expect(call("mutation", "files:removeThenFail", { id: storageId })).rejects.toThrow("rollback");
    expect(await stored(storageId)).toBe(true);
    expect((await fetch(url)).status).toBe(200);

    await call("mutation", "files:remove", { id: storageId });
    expect(await stored(storageId)).toBe(false);
    expect(await call("query", "files:url", { id: storageId })).toBeNull();
    expect((await fetch(url)).status).toBe(404);
  });

  // S3 downloads redirect to the bucket's own origin, so only local files are served from ours.
  test.if(backendName === "local")("uploads that could run script download instead of rendering on this origin", async () => {
    const upload = async (contentType: string, body: string) => {
      const uploadUrl: string = await call("mutation", "files:uploadUrl", {});
      const { storageId } = (await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": contentType }, body }).then((r) => r.json())) as any;
      return fetch(`${base}/api/storage/${storageId}`);
    };
    for (const [type, body] of [
      ["text/html", "<script>localStorage.getItem('ob-admin-key')</script>"],
      ["image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"],
      ["application/x-unknown", "?"],
    ] as const) {
      const res = await upload(type, body);
      expect(res.headers.get("content-disposition")).toBe("attachment");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // Images, media and plain text still show inline.
    const png = await upload("image/png", "png");
    expect(png.headers.get("content-disposition")).toBeNull();
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("actions can store and read blobs", async () => {
    const { id, roundTrip } = await call("action", "files:storeFromAction", { text: "hello files" });
    expect(roundTrip).toBe("hello files");
    expect(await (await fetch(`${base}/api/storage/${id}`)).text()).toBe("hello files");
  });
});

// ---------- Backups to S3 ----------

describe.if(Boolean(process.env.TEST_S3_URL))("backups to S3", () => {
  test("snapshots, retention and restore (database + local files)", async () => {
    const base = process.env.TEST_S3_URL!;
    const url = `${base.replace(/\?.*/, "")}/backups-${Date.now()}${base.match(/\?.*/)?.[0] ?? ""}`;
    const dataDir = mkdtempSync(join(tmpdir(), "onebase-backup-"));
    const restoreDir = mkdtempSync(join(tmpdir(), "onebase-restore-"));
    const modules = {
      notes: {
        add: mutation({ args: { text: v.string() }, handler: (ctx, args) => ctx.db.insert("notes", args) }),
        all: query({ args: {}, handler: (ctx) => ctx.db.query("notes").collect() }),
        attach: action({ args: {}, handler: (ctx) => ctx.storage.store(new Blob(["file body"], { type: "text/plain" })) }),
      },
    };
    const app = await startApp({ schema: null, modules, dataDir, port: 0, hostname: "127.0.0.1", dev: true, quiet: true });
    try {
      await app.runtime.runMutation("notes:add", { text: "first" });
      const fileId = (await app.runtime.runAction("notes:attach", {})) as string;
      const { backupNow, listBackups, restore } = await import("../src/backup");
      const r1 = await backupNow(app.driver, url, 2, app.runtime.files.backend);
      expect(r1.filesUploaded).toBe(1);
      await app.runtime.runMutation("notes:add", { text: "second" });
      await Bun.sleep(1100); // snapshot names have 1-second resolution
      await backupNow(app.driver, url, 2, app.runtime.files.backend);
      await Bun.sleep(1100);
      const r3 = await backupNow(app.driver, url, 2, app.runtime.files.backend);
      expect(r3.filesUploaded).toBe(0); // already uploaded
      expect((await listBackups(url)).length).toBe(2); // keep = 2

      const restored = await restore(url, join(restoreDir, "db.sqlite"), join(restoreDir, "files"));
      expect(restored.key).toBe(r3.key);
      expect(restored.files).toBe(1);
      expect(readFileSync(join(restoreDir, "files", fileId), "utf8")).toBe("file body");
      await expect(restore(url, join(restoreDir, "db.sqlite"), join(restoreDir, "files"))).rejects.toThrow("already exists");

      const copy = new SqliteDriver(join(restoreDir, "db.sqlite"));
      const rows = copy.writer.query("SELECT doc FROM documents ORDER BY ct").all() as { doc: string }[];
      expect(rows.map((r) => JSON.parse(r.doc).text)).toEqual(["first", "second"]);
      await copy.close();
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });
});
