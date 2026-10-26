// File storage: bytes in a blob backend (local disk or S3), metadata in the _storage table.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OnebaseError } from "./database";
import { newId } from "./dialect";
import type { Exec } from "./driver";

export type FileMetadata = { _id: string; _creationTime: number; sha256: string; size: number; contentType: string | null };

export interface BlobBackend {
  readonly description: string;
  put(id: string, body: ReadableStream<Uint8Array>, contentType: string | null): Promise<void>;
  /** A lazy Blob for reading the file. */
  get(id: string): Blob;
  /** Response for GET /api/storage/<id>. */
  serve(id: string, meta: FileMetadata): Response;
  remove(id: string): Promise<void>;
}

/**
 * Types a browser shows inline without running script. Anything else (HTML, SVG, XML, unknown)
 * downloads instead, so an uploaded file can't run script on the app's (and dashboard's) origin.
 */
const INLINE_TYPE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)(;|$)/i;

/** Headers that keep an uploaded file from being treated as a page on this origin. */
function fileSafetyHeaders(contentType: string | null): Record<string, string> {
  const inline = contentType !== null && INLINE_TYPE.test(contentType.trim());
  return {
    "X-Content-Type-Options": "nosniff",
    ...(inline ? {} : { "Content-Disposition": "attachment", "Content-Security-Policy": "sandbox; default-src 'none'" }),
  };
}

const ID = /^[0-9a-z]+$/;
const checkId = (id: string) => {
  if (!ID.test(id)) throw new OnebaseError(`Invalid storage id "${id}".`);
  return id;
};

export class LocalBlobs implements BlobBackend {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  get description() {
    return this.dir;
  }
  path(id: string) {
    return join(this.dir, checkId(id));
  }
  async put(id: string, body: ReadableStream<Uint8Array>) {
    await Bun.write(this.path(id), new Response(body));
  }
  get(id: string) {
    return Bun.file(this.path(id));
  }
  serve(id: string, meta: FileMetadata) {
    return new Response(Bun.file(this.path(id)), {
      headers: {
        "Content-Type": meta.contentType ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${meta.sha256}"`,
        ...fileSafetyHeaders(meta.contentType),
      },
    });
  }
  async remove(id: string) {
    rmSync(this.path(id), { force: true });
  }
}

export type S3Location = { client: InstanceType<typeof Bun.S3Client>; bucket: string; prefix: string; description: string };

/**
 * Parses s3://bucket/prefix. Credentials and endpoint come from the usual env vars
 * (S3_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT, S3_REGION) or
 * from query params: s3://bucket/prefix?endpoint=https://...&region=auto
 */
export function parseS3Url(url: string): S3Location {
  const u = new URL(url);
  if (u.protocol !== "s3:" || !u.hostname) throw new Error(`Expected s3://bucket/prefix, got "${url}".`);
  const env = process.env;
  const q = (k: string) => u.searchParams.get(k) ?? undefined;
  const bucket = u.hostname;
  const path = u.pathname.replace(/^\/+|\/+$/g, "");
  const prefix = path ? `${path}/` : "";
  const client = new Bun.S3Client({
    bucket,
    endpoint: q("endpoint") ?? env.S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL,
    region: q("region") ?? env.S3_REGION ?? env.AWS_REGION,
    accessKeyId: q("accessKeyId") ?? env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
    secretAccessKey: q("secretAccessKey") ?? env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
  });
  return { client, bucket, prefix, description: `s3://${bucket}/${prefix}` };
}

/** Files in S3 / R2 / MinIO. Downloads redirect to short-lived presigned URLs, so bytes don't pass through the server. */
export class S3Blobs implements BlobBackend {
  constructor(private readonly loc: S3Location) {}
  get description() {
    return this.loc.description;
  }
  private key(id: string) {
    return this.loc.prefix + checkId(id);
  }
  async put(id: string, body: ReadableStream<Uint8Array>, contentType: string | null) {
    await this.loc.client.write(this.key(id), new Response(body), contentType ? { type: contentType } : undefined);
  }
  get(id: string) {
    return this.loc.client.file(this.key(id));
  }
  serve(id: string) {
    const url = this.loc.client.presign(this.key(id), { expiresIn: 3600 });
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, max-age=3000" } });
  }
  async remove(id: string) {
    await this.loc.client.delete(this.key(id));
  }
}

const UPLOAD_URL_TTL_MS = 60 * 60_000;

export class FileStore {
  constructor(
    readonly backend: BlobBackend,
    private readonly nextCreationTime: () => number,
  ) {}

  async createUploadToken(tx: Exec): Promise<string> {
    const token = newId() + newId();
    await tx.run("INSERT INTO _upload_tokens (token, expires) VALUES (?, ?)", [token, Date.now() + UPLOAD_URL_TTL_MS]);
    return token;
  }

  /** Upload URLs work once and expire after an hour. */
  async consumeToken(tx: Exec, token: string): Promise<boolean> {
    await tx.run("DELETE FROM _upload_tokens WHERE expires < ?", [Date.now()]);
    return (await tx.run("DELETE FROM _upload_tokens WHERE token = ?", [token])).changes > 0;
  }

  /** Streams the body to the backend, hashing it on the way (never buffers the whole file). */
  async write(body: ReadableStream<Uint8Array>, contentType: string | null): Promise<FileMetadata> {
    const id = newId("_storage");
    const hasher = new Bun.CryptoHasher("sha256");
    let size = 0;
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hasher.update(chunk);
          size += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
    await this.backend.put(id, counted, contentType || null);
    return { _id: id, _creationTime: this.nextCreationTime(), sha256: hasher.digest("base64"), size, contentType: contentType || null };
  }

  async insert(tx: Exec, meta: FileMetadata) {
    await tx.run("INSERT INTO _storage (id, ct, sha256, size, content_type) VALUES (?, ?, ?, ?, ?)", [
      meta._id,
      meta._creationTime,
      meta.sha256,
      meta.size,
      meta.contentType,
    ]);
  }

  async metadata(tx: Exec, id: unknown): Promise<FileMetadata | null> {
    if (typeof id !== "string") throw new OnebaseError(`Expected a storage id (string), got ${typeof id}.`);
    const row = await tx.get("SELECT id, ct, sha256, size, content_type FROM _storage WHERE id = ?", [id]);
    return row
      ? { _id: row.id, _creationTime: Number(row.ct), sha256: row.sha256, size: Number(row.size), contentType: row.content_type }
      : null;
  }

  /** Removes the metadata row; the caller deletes the bytes once the transaction commits. */
  async deleteMetadata(tx: Exec, id: unknown) {
    if (!(await this.metadata(tx, id))) throw new OnebaseError(`storage.delete(): file "${String(id)}" doesn't exist.`);
    await tx.run("DELETE FROM _storage WHERE id = ?", [id as string]);
  }
}
