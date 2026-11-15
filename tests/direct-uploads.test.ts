// Direct uploads: generateUploadUrl({ direct: true }) + confirmUpload(), on local disk (where the
// URL is this server's upload endpoint) and, when TEST_S3_URL is set, an S3-compatible bucket
// (where the client PUTs straight to it). For MinIO:
//
//   docker run -d --rm --name onebase-minio -p 9000:9000 pgsty/minio server /data
//   curl --aws-sigv4 aws:amz:us-east-1:s3 --user minioadmin:minioadmin -X PUT http://localhost:9000/onebase-test
//   TEST_S3_URL='s3://onebase-test?endpoint=http://localhost:9000&region=us-east-1&accessKeyId=minioadmin&secretAccessKey=minioadmin' bun test tests/direct-uploads.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { DIRECT_UPLOAD_DEFAULT_SECONDS, RESERVATION_GRACE_MS, typeAllowed } from "../src/engine/files";
import { action, mutation, query, type DirectUploadUrl } from "../src/server";
import { v } from "../src/values";

const MAX = 4096;

const BACKENDS: [string, string | undefined][] = [
  ["local", undefined],
  ...(process.env.TEST_S3_URL
    ? [["s3", `${process.env.TEST_S3_URL.replace(/\?.*/, "")}/direct-${Date.now()}${process.env.TEST_S3_URL.match(/\?.*/)?.[0] ?? ""}`] as [string, string]]
    : []),
];

test("content type patterns", () => {
  expect(typeAllowed("image/png", ["image/*"])).toBe(true);
  expect(typeAllowed("image/png; x=1", ["image/png"])).toBe(true);
  expect(typeAllowed("IMAGE/PNG", ["image/png"])).toBe(true);
  expect(typeAllowed("video/mp4", ["image/*", "audio/*"])).toBe(false);
  expect(typeAllowed("imagex/png", ["image/*"])).toBe(false);
  expect(typeAllowed(null, ["*/*"])).toBe(false);
  // A comma list is HTML to a browser, whatever comes first.
  expect(typeAllowed("image/png, text/html", ["image/*"])).toBe(false);
});

for (const [backend, filesUrl] of BACKENDS) describe(`direct uploads (${backend})`, () => {
  const isS3 = backend === "s3";
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;
  const modules = {
    files: {
      plainUrl: mutation({ args: {}, handler: (ctx) => ctx.storage.generateUploadUrl() }),
      directUrl: mutation({
        args: { contentType: v.optional(v.string()), expiresIn: v.optional(v.number()) },
        handler: (ctx, args) => ctx.storage.generateUploadUrl({ direct: true, ...args }),
      }),
      confirm: mutation({
        args: { id: v.string(), maxBytes: v.optional(v.number()), contentTypes: v.optional(v.array(v.string())) },
        handler: (ctx, { id, ...opts }) => ctx.storage.confirmUpload(id, opts),
      }),
      meta: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.getMetadata(id) }),
      url: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.getUrl(id) }),
      remove: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.delete(id) }),
      directUrlFromAction: action({ args: {}, handler: (ctx) => ctx.storage.generateUploadUrl({ direct: true }) }),
      confirmFromAction: action({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.confirmUpload(id, { contentTypes: ["text/*"] }) }),
    },
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-direct-"));
    app = await startApp({ schema: null, modules, dataDir, files: filesUrl, port: 0, hostname: "127.0.0.1", dev: true, quiet: true, maxBodyBytes: MAX });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const call = async (kind: string, path: string, args: unknown) => {
    const res = (await fetch(`${base}/api/${kind}`, { method: "POST", body: JSON.stringify({ path, args }) }).then((r) => r.json())) as any;
    if (res.status !== "success") throw new Error(res.errorMessage);
    return res.value;
  };
  const directUrl = (args: { contentType?: string; expiresIn?: number } = {}) => call("mutation", "files:directUrl", args) as Promise<DirectUploadUrl>;
  /** What client code does, whatever the backend. */
  const send = (u: DirectUploadUrl, body: BodyInit, headers: Record<string, string> = u.headers) => fetch(u.url, { method: u.method, headers, body });
  const stat = (id: string) => app.runtime.files.backend.stat(id);

  test("plain generateUploadUrl() is unchanged", async () => {
    expect(await call("mutation", "files:plainUrl", {})).toStartWith(`${base}/api/storage/upload?token=`);
  });

  test("upload, confirm, serve; confirming again returns the same file", async () => {
    const before = Date.now();
    const u = await directUrl({ contentType: "text/plain" });
    expect(u.method).toBe(isS3 ? "PUT" : "POST");
    expect(u.direct).toBe(isS3);
    expect(u.headers).toEqual({ "Content-Type": "text/plain" });
    expect(u.expiresAt).toBeGreaterThanOrEqual(before + DIRECT_UPLOAD_DEFAULT_SECONDS * 1000);
    if (isS3) expect(u.url).not.toContain(base);
    else expect(u.url).toStartWith(`${base}/api/storage/upload?id=${u.storageId}&token=`);

    const res = await send(u, "hello direct");
    expect(res.status).toBe(200);
    // Uploaded but not confirmed: not a file yet.
    expect(await call("query", "files:meta", { id: u.storageId })).toBeNull();

    const meta = await call("mutation", "files:confirm", { id: u.storageId, contentTypes: ["text/*"] });
    expect(meta).toMatchObject({ _id: u.storageId, size: 12, contentType: "text/plain" });
    // The server hashes what streams through it; bytes that went straight to the bucket it never saw.
    if (isS3) expect(meta.sha256).toBeNull();
    else expect(meta.sha256).toBe(new Bun.CryptoHasher("sha256").update("hello direct").digest("base64"));
    expect(await call("query", "files:meta", { id: u.storageId })).toEqual(meta);

    // Idempotent. A stricter second confirm refuses the file (confirmUpload doesn't know where an
    // existing id came from) but doesn't delete a file already accepted.
    expect(await call("mutation", "files:confirm", { id: u.storageId, contentTypes: ["text/*"] })).toEqual(meta);
    await expect(call("mutation", "files:confirm", { id: u.storageId, maxBytes: 1 })).rejects.toThrow("more than the 1 allowed");
    await expect(call("mutation", "files:confirm", { id: u.storageId, contentTypes: ["image/*"] })).rejects.toThrow("isn't one of image/*");
    expect(await stat(u.storageId)).not.toBeNull();
    expect(await call("query", "files:meta", { id: u.storageId })).toEqual(meta);

    const served = await fetch(await call("query", "files:url", { id: u.storageId }));
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("hello direct");
    expect(served.headers.get("content-type")).toStartWith("text/plain");
  });

  test("confirming before the bytes arrive keeps the reservation", async () => {
    const u = await directUrl();
    await expect(call("mutation", "files:confirm", { id: u.storageId })).rejects.toThrow("nothing was uploaded");
    expect((await send(u, "late", { "Content-Type": "text/plain" })).status).toBe(200);
    expect(await call("mutation", "files:confirm", { id: u.storageId })).toMatchObject({ size: 4 });
  });

  test("too large: rejected and deleted (default limit: the server's --max-upload)", async () => {
    const u = await directUrl();
    const res = await send(u, new Uint8Array(MAX + 1));
    if (isS3) {
      // The bucket takes it (a presigned PUT can't cap the size); confirm doesn't.
      expect(res.status).toBe(200);
      await expect(call("mutation", "files:confirm", { id: u.storageId })).rejects.toThrow(`more than the ${MAX} allowed`);
      expect(await stat(u.storageId)).toBeNull();
    } else {
      // Through this server, the body limit stops it on the way in, and nothing is kept.
      expect(res.status).toBe(413);
      expect(await stat(u.storageId)).toBeNull();
      await expect(call("mutation", "files:confirm", { id: u.storageId })).rejects.toThrow("nothing was uploaded");
    }

    const small = await directUrl();
    await send(small, new Uint8Array(100));
    await expect(call("mutation", "files:confirm", { id: small.storageId, maxBytes: 99 })).rejects.toThrow("more than the 99 allowed");
    expect(await stat(small.storageId)).toBeNull();
    // The rejection threw, so the mutation rolled back; the reservation stays until it expires but
    // has nothing in it, and the client may send a smaller file with the same URL.
    await expect(call("mutation", "files:confirm", { id: small.storageId, maxBytes: 1000 })).rejects.toThrow("nothing was uploaded");
    expect((await send(small, new Uint8Array(50))).status).toBe(200);
    expect(await call("mutation", "files:confirm", { id: small.storageId, maxBytes: 99 })).toMatchObject({ size: 50 });
  });

  test("a type not allowed: rejected and deleted", async () => {
    const u = await directUrl({ contentType: "image/png" });
    // The client may send any type; the signature doesn't cover it, so confirm checks it.
    await send(u, "<script>1</script>", { "Content-Type": "text/html" });
    await expect(call("mutation", "files:confirm", { id: u.storageId, contentTypes: ["image/*"] })).rejects.toThrow('"text/html" isn\'t one of image/*');
    expect(await stat(u.storageId)).toBeNull();
    expect(await call("query", "files:meta", { id: u.storageId })).toBeNull();
  });

  test("files served from the bucket keep the confirmed type, and risky types download", async () => {
    const u = await directUrl();
    await send(u, "<script>1</script>", { "Content-Type": "text/html" });
    await call("mutation", "files:confirm", { id: u.storageId });
    const res = await fetch(`${base}/api/storage/${u.storageId}`, { redirect: "manual" });
    if (isS3) {
      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toContain("response-content-disposition=attachment");
      const fromBucket = await fetch(location);
      expect(fromBucket.headers.get("content-disposition")).toBe("attachment");
      expect(fromBucket.headers.get("content-type")).toStartWith("text/html");
    } else {
      expect(res.headers.get("content-disposition")).toBe("attachment");
    }
  });

  test("unknown ids, bad options", async () => {
    await expect(call("mutation", "files:confirm", { id: "nosuchupload" })).rejects.toThrow("no upload");
    await expect(call("mutation", "files:confirm", { id: "../etc" })).rejects.toThrow("expected a storage id");
    await expect(directUrl({ expiresIn: 0 })).rejects.toThrow("expiresIn");
    await expect(directUrl({ expiresIn: 8 * 86400 })).rejects.toThrow("expiresIn");
  });

  test("actions can reserve and confirm", async () => {
    const u = (await call("action", "files:directUrlFromAction", {})) as DirectUploadUrl;
    await send(u, "from an action", { "Content-Type": "text/plain" });
    expect(await call("action", "files:confirmFromAction", { id: u.storageId })).toMatchObject({ size: 14, contentType: "text/plain" });
  });

  test.if(!isS3)("the local upload URL needs its token and stops working once confirmed", async () => {
    const u = await directUrl();
    expect((await fetch(u.url.replace(/token=\w+/, "token=wrong"), { method: "POST", body: "x" })).status).toBe(400);
    expect((await send(u, "one")).status).toBe(200);
    // Like a presigned PUT, sending again replaces the bytes.
    expect((await send(u, "three")).status).toBe(200);
    expect(await call("mutation", "files:confirm", { id: u.storageId })).toMatchObject({ size: 5 });
    const after = await send(u, "four");
    expect(after.status).toBe(400);
    expect(((await after.json()) as any).error).toContain("already confirmed");
  });

  test("an existing file passed to confirmUpload must meet its limits", async () => {
    // Say, uploaded through plain generateUploadUrl(), which checks nothing.
    const plain = await call("mutation", "files:plainUrl", {});
    const { storageId } = (await (await fetch(plain, { method: "POST", headers: { "Content-Type": "text/html" }, body: "<b>hi</b>" })).json()) as any;
    await expect(call("mutation", "files:confirm", { id: storageId, contentTypes: ["image/*"] })).rejects.toThrow('"text/html" isn\'t one of image/*');
    await expect(call("mutation", "files:confirm", { id: storageId, maxBytes: 3 })).rejects.toThrow("more than the 3 allowed");
    expect(await call("mutation", "files:confirm", { id: storageId, contentTypes: ["text/*"] })).toMatchObject({ _id: storageId, size: 9 });
    expect(await call("query", "files:meta", { id: storageId })).not.toBeNull();
  });

  test.if(isS3)("the presigned URL can't replace, or re-create, a confirmed file", async () => {
    const u = await directUrl({ contentType: "image/png" });
    expect((await send(u, "tiny png")).status).toBe(200);
    const meta = await call("mutation", "files:confirm", { id: u.storageId, maxBytes: 100, contentTypes: ["image/*"] });
    expect(meta).toMatchObject({ size: 8, contentType: "image/png" });
    // The URL still works (S3 can't revoke it), but it points at a staging object, not the file.
    expect((await send(u, new Uint8Array(MAX), { "Content-Type": "text/html" })).status).toBe(200);
    expect(await stat(u.storageId)).toEqual({ size: 8, contentType: "image/png" });
    const served = await fetch(`${base}/api/storage/${u.storageId}`);
    expect(await served.text()).toBe("tiny png");
    expect(await call("mutation", "files:confirm", { id: u.storageId, maxBytes: 100 })).toEqual(meta);

    // Deleted, it stays deleted.
    await call("mutation", "files:remove", { id: u.storageId });
    expect((await send(u, "again")).status).toBe(200);
    expect(await stat(u.storageId)).toBeNull();
    expect(await call("query", "files:meta", { id: u.storageId })).toBeNull();
    await expect(call("mutation", "files:confirm", { id: u.storageId })).rejects.toThrow("no upload");

    // Bytes PUT after the confirm are swept once the URL is long expired.
    const staged = () => app.runtime.files.backend.direct!.stat(u.storageId);
    expect(await staged()).not.toBeNull();
    expect(await app.runtime.sweepUploads(u.expiresAt + 2 * RESERVATION_GRACE_MS + 1)).toBeGreaterThanOrEqual(1);
    expect(await staged()).toBeNull();
  });

  test("unconfirmed uploads are deleted once expired, confirmed ones never", async () => {
    const stale = await directUrl({ expiresIn: 60 });
    await send(stale, "abandoned", { "Content-Type": "text/plain" });
    const kept = await directUrl({ expiresIn: 60 });
    await send(kept, "confirmed", { "Content-Type": "text/plain" });
    await call("mutation", "files:confirm", { id: kept.storageId });
    const fresh = await directUrl();
    await send(fresh, "still uploading", { "Content-Type": "text/plain" });

    // Not yet: the grace period after expiry still allows a confirm.
    expect(await app.runtime.sweepUploads(stale.expiresAt + RESERVATION_GRACE_MS)).toBe(0);
    // Past twice the grace period it goes, bytes and all; the newer reservation stays.
    const later = stale.expiresAt + 2 * RESERVATION_GRACE_MS + 1;
    expect(await app.runtime.sweepUploads(later)).toBeGreaterThanOrEqual(1);
    expect(await stat(stale.storageId)).toBeNull();
    await expect(call("mutation", "files:confirm", { id: stale.storageId })).rejects.toThrow("no upload");
    expect(await stat(kept.storageId)).not.toBeNull();
    expect(await call("mutation", "files:confirm", { id: fresh.storageId })).toMatchObject({ size: 15 });
  });
});
