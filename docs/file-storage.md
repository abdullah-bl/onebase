---
title: File storage
description: Upload, serve and delete files, on local disk or in S3, R2 or MinIO.
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

Upload URLs work once and expire after an hour. Uploads are streamed straight to storage and hashed on the way, so even large files never sit in memory.

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
| S3 / R2 / MinIO | `--files s3://bucket/prefix` |

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
