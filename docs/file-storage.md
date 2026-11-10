---
title: File storage
description: Upload, serve and delete files, on local disk or in any S3-compatible store, including uploads straight to the bucket.
---

# File storage

Files are stored as bytes plus metadata. Reference them from documents with `v.id("_storage")`.

## Uploading from the browser

**1.** Add a mutation that returns an upload URL:

```ts
export const generateUploadUrl = mutation({
  args: {},
  handler: (ctx) => ctx.storage.generateUploadUrl(),
});

export const savePhoto = mutation({
  args: { image: v.id("_storage"), caption: v.string() },
  handler: (ctx, args) => ctx.db.insert("photos", args),
});
```

**2.** On the client, POST the file to that URL, then save the returned id:

```ts
const uploadUrl = await client.mutation(api.photos.generateUploadUrl);
const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
const { storageId } = await res.json();
await client.mutation(api.photos.savePhoto, { image: storageId, caption });
```

Upload URLs work once and expire after an hour. Uploads are streamed straight to storage and hashed on the way, so even large files never sit in memory. The largest body the server accepts is set by `--max-upload` (default 1 GB).

## Uploading straight to the bucket

With S3 storage, the bytes can skip the server: the client PUTs the file to a presigned URL, then a mutation confirms it. The server only signs a URL and checks the result, so big uploads don't tie it up.

```ts
export const generateUploadUrl = mutation({
  args: { contentType: v.string() },
  handler: (ctx, { contentType }) => ctx.storage.generateUploadUrl({ direct: true, contentType }),
});

export const savePhoto = mutation({
  args: { image: v.id("_storage"), caption: v.string() },
  handler: async (ctx, { image, caption }) => {
    // Checks what arrived: deletes it and throws if it's too big or the wrong type.
    await ctx.storage.confirmUpload(image, { maxBytes: 20 * 2 ** 20, contentTypes: ["image/*"] });
    return ctx.db.insert("photos", { image, caption });
  },
});
```

```ts
const { url, method, headers, storageId } = await client.mutation(api.photos.generateUploadUrl, { contentType: file.type });
const res = await fetch(url, { method, headers, body: file });
if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
await client.mutation(api.photos.savePhoto, { image: storageId, caption });
```

`generateUploadUrl({ direct: true, contentType?, expiresIn? })` reserves a storage id and returns:

| | |
|---|---|
| `storageId` | The file's id once confirmed. |
| `url`, `method`, `headers` | Where to send the bytes: `fetch(url, { method, headers, body })`. |
| `expiresAt` | When the URL stops working (ms). `expiresIn` sets it, in seconds: default 900, at most 7 days. |
| `direct` | `true` for a presigned `PUT` straight to the bucket. `false` with local-disk storage: the URL is this server's upload endpoint (`POST`), so the same client code works on both. |

The presigned URL points at a staging object (`<prefix>uploads/<storageId>`), never at the file itself. `confirmUpload(storageId, { maxBytes?, contentTypes? })` copies what was uploaded to the file's own key and checks the copy (an S3 `HEAD`), so nothing the client sends afterwards can change the file. It then does one of four things:

- **The file passes:** it becomes a file with its size and type from the bucket, and you get its metadata.
- **It's larger than `maxBytes`** (default: the server's `--max-upload`) **or its type isn't in `contentTypes`** (`"image/png"` or `"image/*"`): it throws and deletes the bytes.
- **Nothing has arrived yet:** it throws and keeps the reservation, so the client can still upload.
- **It's already a file:** you get its metadata again if it meets `maxBytes` and `contentTypes` too, so it's safe to retry; otherwise it throws (without deleting the file). Any existing storage id passes this way, including one uploaded elsewhere, so `confirmUpload` doesn't prove the caller uploaded it: check ownership yourself if that matters.

A rejection throws, which rolls back the rest of the mutation. The reservation lasts until its URL expires, so the client can send another file to the same URL.

Mutations and actions can both call it. In an action, the copy and the `HEAD` happen before the write lock is taken.

**Cleanup.** A reservation nobody confirms is deleted, bytes and all, two hours after its URL expires. For a confirmed one, the staging object is deleted on confirm, and again at that point in case the URL was used after the confirm. The server sweeps at startup and every 10 minutes, so you don't need a bucket lifecycle rule. Confirming still works for an hour after expiry, for an upload that started just in time.

**What the server can't enforce.** A presigned PUT doesn't sign the size or the `Content-Type`, so the bucket takes whatever the client sends. That's why `confirmUpload` checks both. Downloads are answered with the confirmed type, pinned with `response-content-type`. Types a browser could run as a page are sent as `attachment` downloads. A presigned URL can't be revoked, so until `expiresAt` the client can still PUT to the staging object, even after the confirm; that never reaches the file, and the sweep deletes it.

**`sha256`.** Files uploaded straight to the bucket have `sha256: null`, because the server never sees their bytes. Every S3-compatible store implements plain `PUT`/`HEAD`, but checksum headers on presigned URLs are optional and inconsistently supported across them. Downloads come from the bucket, which sets its own `ETag` for caching. If you need a hash, compute it in an action with `ctx.storage.get(id)`. Uploads through the server, including the local-disk fallback, are hashed as they stream.

### Provider notes

Direct uploads use plain S3 calls: presigned `PUT` and `GET`, plus `HEAD` and `DELETE`. They need no multipart uploads, lifecycle rules, checksums or provider-specific APIs.

| Provider | Largest single PUT | CORS for browser uploads |
|---|---|---|
| AWS S3 | 5 GB | Bucket CORS: `aws s3api put-bucket-cors` |
| Cloudflare R2 | 5 GiB (about 4.995) | Bucket → Settings → CORS policy, or `wrangler r2 bucket cors set` |
| MinIO | 5 TiB | Server-wide: `MINIO_API_CORS_ALLOW_ORIGIN` (default `*`) |
| Backblaze B2 | 5 GB | Bucket CORS rules with `s3_put`, `s3_get` and `s3_head` (web UI or `b2` CLI) |
| DigitalOcean Spaces | 5 GB | Space → Settings → CORS, or `PutBucketCors` |
| Wasabi | 5 GB | `PutBucketCors` |

Bigger files need multipart uploads, which onebase doesn't sign. Set `maxBytes` (or `--max-upload`) below your provider's limit.

Browsers need a CORS rule on the bucket that allows `PUT` from your app's origin, with the `Content-Type` header. Native apps don't. An S3-style rule looks like this:

```json
[{ "AllowedOrigins": ["https://app.example.com"], "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["Content-Type"], "MaxAgeSeconds": 3600 }]
```

## Serving files

```ts
export const list = query({
  args: {},
  handler: async (ctx) => {
    const photos = await ctx.db.query("photos").collect();
    return Promise.all(photos.map(async (p) => ({ ...p, url: await ctx.storage.getUrl(p.image) })));
  },
});
```

`getUrl` returns a stable URL, `/api/storage/<id>`:
- **On disk:** the server sends the file with long-lived caching headers. Images, audio, video, PDFs and plain text show in the browser; anything else (HTML, SVG, unknown types) downloads, so an uploaded file can't run script on your app's or the dashboard's origin.
- **In S3:** the server redirects to a short-lived presigned URL, so the bytes come straight from S3.

Set `--url https://api.example.com` so these URLs use your public address.

## API

| | query | mutation | action |
|---|:-:|:-:|:-:|
| `ctx.storage.getUrl(id)` | ✓ | ✓ | ✓ |
| `ctx.storage.getMetadata(id)` → `{ sha256, size, contentType, … }` | ✓ | ✓ | ✓ |
| `ctx.storage.generateUploadUrl()` | | ✓ | ✓ |
| `ctx.storage.generateUploadUrl({ direct: true })` → `{ url, method, headers, storageId, expiresAt, direct }` | | ✓ | ✓ |
| `ctx.storage.confirmUpload(id, { maxBytes?, contentTypes? })` → metadata | | ✓ | ✓ |
| `ctx.storage.delete(id)` | | ✓ | ✓ |
| `ctx.storage.store(blob)` → id | | | ✓ |
| `ctx.storage.get(id)` → `Blob` | | | ✓ |

A `delete` inside a mutation is transactional. The bytes are removed only if the mutation commits.

Actions can save generated content:

```ts
const image = await fetch("https://example.com/cat.png").then((r) => r.blob());
const storageId = await ctx.storage.store(image);
```

## Where files go

| | |
|---|---|
| Default | `<data dir>/files` (`./onebase_data/files`) |
| Any S3-compatible store (AWS S3, R2, MinIO, B2, Spaces, Wasabi…) | `--files s3://bucket/prefix` |

S3 credentials come from environment variables:

```bash
export S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
export S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # for R2, MinIO, etc. (omit for AWS)
export S3_REGION=auto
```

```bash
onebase serve --files s3://my-bucket/uploads
```

The `AWS_*` equivalents work too, and so do query parameters on the URL (`s3://bucket/prefix?endpoint=…&region=…`).
