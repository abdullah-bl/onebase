// File storage: bytes in a blob backend (local disk or S3), metadata in the _storage table.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OnebaseError } from "./database";
import { newId } from "./dialect";
import type { Exec } from "./driver";

/** `sha256` is null for a file uploaded straight to the bucket (`generateUploadUrl({ direct: true })`): the server never saw its bytes. */
export type FileMetadata = { _id: string; _creationTime: number; sha256: string | null; size: number; contentType: string | null };

/** What the backend knows about stored bytes. */
export type BlobStat = { size: number; contentType: string | null };

export interface BlobBackend {
  readonly description: string;
  put(id: string, body: ReadableStream<Uint8Array>, contentType: string | null): Promise<void>;
  /** A lazy Blob for reading the file. */
  get(id: string): Blob;
  /** Response for GET /api/storage/<id>. */
  serve(id: string, meta: FileMetadata): Response;
  remove(id: string): Promise<void>;
  /** Size and type of the stored bytes, or null when there are none. */
  stat(id: string): Promise<BlobStat | null>;
  /**
   * A URL the client can PUT the file's bytes to, straight into storage, valid for `expiresIn`
   * seconds. Absent when the backend can't take uploads directly (local disk).
   */
  presignUpload?(id: string, expiresIn: number): string;
}

/**
 * Types a browser shows inline without running script. Anything else (HTML, SVG, XML, unknown)
 * downloads instead, so an uploaded file can't run script on the app's (and dashboard's) origin.
 */
const INLINE_TYPE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)(;|$)/i;

/**
 * The single type a browser will use for `contentType`, or null when it could read it as another
 * one: browsers take the last entry of a comma list, so "text/plain;,text/html" is HTML to them.
 */
function singleType(contentType: string | null): string | null {
  if (!contentType || /[,"\r\n]/.test(contentType)) return null;
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(type) ? type : null;
}

/** Whether a browser may show this type inline (see INLINE_TYPE). */
function isInline(contentType: string | null): boolean {
  const type = singleType(contentType);
  return type !== null && INLINE_TYPE.test(type);
}

/** Whether `contentType` matches one of `allowed`: exact types ("image/png") or a family ("image/*"). */
export function typeAllowed(contentType: string | null, allowed: readonly string[]): boolean {
  const type = singleType(contentType);
  if (!type) return false;
  return allowed.some((a) => {
    const want = a.trim().toLowerCase();
    return want === "*/*" || want === type || (want.endsWith("/*") && type.startsWith(want.slice(0, -1)));
  });
}

/** Headers that keep an uploaded file from being treated as a page on this origin. */
function fileSafetyHeaders(contentType: string | null): Record<string, string> {
  const inline = isInline(contentType);
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
        "Content-Type": singleType(meta.contentType) ? meta.contentType! : "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        ...(meta.sha256 ? { ETag: `"${meta.sha256}"` } : {}),
        ...fileSafetyHeaders(meta.contentType),
      },
    });
  }
  async remove(id: string) {
    rmSync(this.path(id), { force: true });
  }
  async stat(id: string) {
    const file = Bun.file(this.path(id));
    // A local file has no type of its own: the upload records it.
    return (await file.exists()) ? { size: file.size, contentType: null } : null;
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

/**
 * Files in any S3-compatible store (AWS S3, R2, MinIO, B2, Spaces, Wasabi…). Downloads redirect to
 * short-lived presigned URLs, and direct uploads PUT to presigned URLs, so bytes don't pass through
 * the server. Only plain S3 calls are used: PUT, GET, HEAD and DELETE of single objects.
 */
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
  serve(id: string, meta: FileMetadata) {
    // The type and disposition the bucket answers with are pinned here (response-content-type /
    // response-content-disposition, plain S3 GET parameters), not taken from the stored object:
    // a client that uploaded directly chose the object's own Content-Type.
    const url = this.loc.client.presign(this.key(id), {
      expiresIn: 3600,
      type: singleType(meta.contentType) ? meta.contentType! : "application/octet-stream",
      ...(isInline(meta.contentType) ? {} : { contentDisposition: "attachment" }),
    });
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, max-age=3000" } });
  }
  async remove(id: string) {
    await this.loc.client.delete(this.key(id));
  }
  async stat(id: string) {
    try {
      const stat = await this.loc.client.file(this.key(id)).stat();
      return { size: stat.size, contentType: stat.type || null };
    } catch (err) {
      if ((err as { code?: string })?.code === "NoSuchKey" || (err as { code?: string })?.code === "NotFound") return null;
      throw err;
    }
  }
  presignUpload(id: string, expiresIn: number) {
    // Content-Type isn't part of the signature (Bun signs only the host), so any type is accepted
    // here and checked by confirmUpload; serve() pins the type downloads are answered with.
    return this.loc.client.presign(this.key(id), { method: "PUT", expiresIn });
  }
}

const UPLOAD_URL_TTL_MS = 60 * 60_000;

/** Direct-upload URLs last 15 minutes unless asked otherwise, and at most 7 days (S3's limit for presigned URLs). */
export const DIRECT_UPLOAD_DEFAULT_SECONDS = 15 * 60;
export const DIRECT_UPLOAD_MAX_SECONDS = 7 * 24 * 3600;
/**
 * After a reservation expires, an upload started just before then still has this long to finish
 * and be confirmed; the sweep removes what's left only after twice as long, so it never races a confirm.
 */
export const RESERVATION_GRACE_MS = 60 * 60_000;

export type Reservation = { id: string; token: string; expires: number; size: number | null; contentType: string | null; sha256: string | null };

/** size while a POST to a local reservation is still streaming. */
const UPLOADING = -1;

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
  async write(body: ReadableStream<Uint8Array>, contentType: string | null, id: string = newId("_storage")): Promise<FileMetadata> {
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
    try {
      await this.backend.put(id, counted, contentType || null);
    } catch (err) {
      // Say, the upload went over the size limit or the client went away: drop what was written.
      await this.backend.remove(id).catch(() => {});
      throw err;
    }
    return { _id: id, _creationTime: this.nextCreationTime(), sha256: hasher.digest("base64"), size, contentType: contentType || null };
  }

  async insert(tx: Exec, meta: FileMetadata) {
    await tx.run("INSERT INTO _storage (id, ct, sha256, size, content_type) VALUES (?, ?, ?, ?, ?)", [
      meta._id,
      meta._creationTime,
      meta.sha256 ?? "",
      meta.size,
      meta.contentType,
    ]);
  }

  async metadata(tx: Exec, id: unknown): Promise<FileMetadata | null> {
    if (typeof id !== "string") throw new OnebaseError(`Expected a storage id (string), got ${typeof id}.`);
    const row = await tx.get("SELECT id, ct, sha256, size, content_type FROM _storage WHERE id = ?", [id]);
    // The column is NOT NULL (older onebases read it); a file with no known hash stores "".
    return row
      ? { _id: row.id, _creationTime: Number(row.ct), sha256: row.sha256 || null, size: Number(row.size), contentType: row.content_type }
      : null;
  }

  // ---- Direct uploads: reserve an id, the client sends the bytes, confirmUpload() makes it a file ----

  async reserve(tx: Exec, expiresInSeconds: number): Promise<Reservation> {
    const r: Reservation = { id: newId("_storage"), token: newId() + newId(), expires: Date.now() + expiresInSeconds * 1000, size: null, contentType: null, sha256: null };
    await tx.run("INSERT INTO _upload_reservations (id, token, expires) VALUES (?, ?, ?)", [r.id, r.token, r.expires]);
    return r;
  }

  async reservation(tx: Exec, id: string): Promise<Reservation | null> {
    const row = await tx.get("SELECT id, token, expires, size, content_type, sha256 FROM _upload_reservations WHERE id = ?", [id]);
    if (!row) return null;
    return {
      id: row.id,
      token: row.token,
      expires: Number(row.expires),
      size: row.size === null || row.size === undefined ? null : Number(row.size),
      contentType: row.content_type ?? null,
      sha256: row.sha256 ?? null,
    };
  }

  async dropReservation(tx: Exec, id: string) {
    await tx.run("DELETE FROM _upload_reservations WHERE id = ?", [id]);
  }

  /**
   * The upload endpoint's half of a reservation on a backend without presigned PUTs: claims it
   * (one upload at a time, before it expires), streams and hashes the bytes, and records what came.
   * Like a presigned PUT, the URL may be used again (replacing the bytes) until confirmUpload().
   */
  async writeReserved(
    writer: <T>(fn: (tx: Exec) => Promise<T>) => Promise<T>,
    id: string,
    token: string,
    body: ReadableStream<Uint8Array>,
    contentType: string | null,
  ): Promise<void> {
    checkId(id);
    const claimed = await writer(async (tx) => {
      const { changes } = await tx.run("UPDATE _upload_reservations SET size = ? WHERE id = ? AND token = ? AND (size IS NULL OR size >= 0) AND expires > ?", [
        UPLOADING,
        id,
        token,
        Date.now(),
      ]);
      return changes === 1;
    });
    if (!claimed) throw new OnebaseError("Upload URL is invalid or expired, its file was already confirmed, or another upload to it is in progress. Get a fresh one from ctx.storage.generateUploadUrl({ direct: true }).");
    let meta: FileMetadata;
    try {
      meta = await this.write(body, contentType, id);
    } catch (err) {
      await writer((tx) => tx.run("UPDATE _upload_reservations SET size = NULL WHERE id = ?", [id])).catch(() => {});
      throw err;
    }
    await writer((tx) =>
      tx.run("UPDATE _upload_reservations SET size = ?, content_type = ?, sha256 = ? WHERE id = ?", [meta.size, meta.contentType, meta.sha256, id]),
    );
  }

  /** Reservations whose time (plus twice the grace period) is up: their bytes can go. */
  async expiredReservations(tx: Exec, now = Date.now(), limit = 500): Promise<string[]> {
    const rows = await tx.all(`SELECT id FROM _upload_reservations WHERE expires < ? ORDER BY expires LIMIT ${limit}`, [now - 2 * RESERVATION_GRACE_MS]);
    return rows.map((r) => r.id as string);
  }

  async dropExpiredReservations(tx: Exec, ids: string[], now = Date.now()) {
    for (const id of ids) await tx.run("DELETE FROM _upload_reservations WHERE id = ? AND expires < ?", [id, now - 2 * RESERVATION_GRACE_MS]);
  }

  /** Removes the metadata row; the caller deletes the bytes once the transaction commits. */
  async deleteMetadata(tx: Exec, id: unknown) {
    if (!(await this.metadata(tx, id))) throw new OnebaseError(`storage.delete(): file "${String(id)}" doesn't exist.`);
    await tx.run("DELETE FROM _storage WHERE id = ?", [id as string]);
  }
}
