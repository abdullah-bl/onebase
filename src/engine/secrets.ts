// Encryption at rest with $ONEBASE_SECRET_KEY: stored environment variables, and backups.
//
// The key never goes in the database or the bucket, so a copy of either one is not enough to read
// the secrets in it. AES-256-GCM through WebCrypto (node:crypto would add about 5 MB of memory).

import { OnebaseError } from "./database";

export const SECRET_KEY_ENV = "ONEBASE_SECRET_KEY";
const MIN_SECRET = 32;
const VALUE_PREFIX = "enc:v1:";

/** $ONEBASE_SECRET_KEY, or null when encryption is off. Throws when it is too short to be a key. */
export function secretKey(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env[SECRET_KEY_ENV]?.trim();
  if (!secret) return null;
  if (secret.length < MIN_SECRET) {
    throw new OnebaseError(`$${SECRET_KEY_ENV} is ${secret.length} characters; it needs at least ${MIN_SECRET}. Make one with: openssl rand -base64 32`);
  }
  return secret;
}

const keys = new Map<string, Promise<CryptoKey>>();

/** The AES key for a secret. The secret is random and long, so one hash is enough to derive it. */
export function aesKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(`onebase-secret-v1|${secret}`))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    keys.set(secret, key);
  }
  return key;
}

export const isEncrypted = (stored: string) => stored.startsWith(VALUE_PREFIX);

/** Encrypts a value for the database. `label` (the variable's name) is bound in, so a value can't be moved to another name. */
export async function encryptValue(secret: string, label: string, plain: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(label) }, await aesKey(secret), new TextEncoder().encode(plain));
  const out = new Uint8Array(12 + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), 12);
  return VALUE_PREFIX + Buffer.from(out).toString("base64");
}

/** The stored value as text: decrypted, or as it is when it was stored before encryption was on. */
export async function decryptValue(secret: string | null, label: string, stored: string): Promise<string> {
  if (!isEncrypted(stored)) return stored;
  if (!secret) {
    throw new OnebaseError(`${label} is stored encrypted, and this server has no $${SECRET_KEY_ENV}. Start it with the key the value was saved under.`);
  }
  const bytes = Buffer.from(stored.slice(VALUE_PREFIX.length), "base64");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(label) },
      await aesKey(secret),
      bytes.subarray(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new OnebaseError(`${label} can't be decrypted with this $${SECRET_KEY_ENV}: it was saved under a different key.`);
  }
}

// ---- Streams (backups) ----
//
// A file is a header (magic, then 8 random bytes naming the file) followed by chunks of up to
// 1 MiB, each sealed on its own with a nonce of file id + chunk number. The last chunk is sealed
// with a different marker, so a file cut short at a chunk boundary doesn't decrypt.

const MAGIC = new TextEncoder().encode("OBENC1\n");
const CHUNK = 1 << 20;
const TAG = 16;

function nonceFor(fileId: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  nonce.set(fileId);
  new DataView(nonce.buffer).setUint32(8, index);
  return nonce;
}

/** Collects bytes and hands them back in pieces of exactly `size`, keeping the remainder. */
class Chunker {
  private parts: Uint8Array[] = [];
  length = 0;
  push(bytes: Uint8Array) {
    this.parts.push(bytes);
    this.length += bytes.byteLength;
  }
  take(size: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = this.parts[0]!;
      const n = Math.min(head.byteLength, size - filled);
      out.set(head.subarray(0, n), filled);
      filled += n;
      if (n === head.byteLength) this.parts.shift();
      else this.parts[0] = head.subarray(n);
    }
    this.length -= size;
    return out;
  }
}

export function encryptStream(secret: string): TransformStream<Uint8Array, Uint8Array> {
  const fileId = crypto.getRandomValues(new Uint8Array(8));
  const buffer = new Chunker();
  let index = 0;
  const seal = async (plain: Uint8Array<ArrayBuffer>, last: boolean) =>
    new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceFor(fileId, index++), additionalData: new Uint8Array([last ? 1 : 0]) }, await aesKey(secret), plain));
  return new TransformStream({
    start(controller) {
      controller.enqueue(MAGIC);
      controller.enqueue(fileId);
    },
    async transform(bytes, controller) {
      buffer.push(bytes);
      // Strictly more than a chunk: the last one is only known when the input ends.
      while (buffer.length > CHUNK) controller.enqueue(await seal(buffer.take(CHUNK), false));
    },
    async flush(controller) {
      controller.enqueue(await seal(buffer.take(buffer.length), true));
    },
  });
}

export function decryptStream(secret: string): TransformStream<Uint8Array, Uint8Array> {
  const buffer = new Chunker();
  let fileId: Uint8Array | null = null;
  let index = 0;
  const open = async (sealed: Uint8Array<ArrayBuffer>, last: boolean) => {
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonceFor(fileId!, index++), additionalData: new Uint8Array([last ? 1 : 0]) }, await aesKey(secret), sealed));
    } catch {
      throw new OnebaseError(`This backup can't be decrypted: it was made under a different $${SECRET_KEY_ENV}, or it is damaged or cut short.`);
    }
  };
  const header = async () => {
    if (fileId || buffer.length < MAGIC.length + 8) return;
    const magic = buffer.take(MAGIC.length);
    if (!magic.every((b, i) => b === MAGIC[i])) throw new OnebaseError("This isn't an encrypted onebase backup.");
    fileId = buffer.take(8);
  };
  return new TransformStream({
    async transform(bytes, controller) {
      buffer.push(bytes);
      await header();
      if (!fileId) return;
      while (buffer.length > CHUNK + TAG) controller.enqueue(await open(buffer.take(CHUNK + TAG), false));
    },
    async flush(controller) {
      await header();
      if (!fileId || buffer.length < TAG) throw new OnebaseError("This encrypted backup is cut short.");
      controller.enqueue(await open(buffer.take(buffer.length), true));
    },
  });
}
