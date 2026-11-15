// Encryption at rest with $ONEBASE_SECRET_KEY: stored environment variables, and the stream format backups use.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { decryptStream, decryptValue, encryptStream, encryptValue, secretKey } from "../src/engine/secrets";
import { quiet } from "./helpers";

const KEY = "a-long-random-secret-for-tests-0123456789";
const OTHER = "another-long-random-secret-9876543210-xyz";

describe("values", () => {
  test("round-trip, with the name bound in and a clear error for the wrong key", async () => {
    const sealed = await encryptValue(KEY, "STRIPE_KEY", "sk_live_ünïcode");
    expect(sealed).toStartWith("enc:v1:");
    expect(sealed).not.toContain("sk_live");
    expect(await encryptValue(KEY, "STRIPE_KEY", "sk_live_ünïcode")).not.toBe(sealed); // a fresh nonce each time
    expect(await decryptValue(KEY, "STRIPE_KEY", sealed)).toBe("sk_live_ünïcode");
    await expect(decryptValue(OTHER, "STRIPE_KEY", sealed)).rejects.toThrow("saved under a different key");
    await expect(decryptValue(KEY, "OTHER_NAME", sealed)).rejects.toThrow("saved under a different key");
    await expect(decryptValue(null, "STRIPE_KEY", sealed)).rejects.toThrow("no $ONEBASE_SECRET_KEY");
    // Stored before encryption was on: read as it is.
    expect(await decryptValue(null, "PLAIN", "hello")).toBe("hello");
    expect(await decryptValue(KEY, "PLAIN", "hello")).toBe("hello");
  });

  test("a short key is refused", () => {
    expect(secretKey({})).toBeNull();
    expect(secretKey({ ONEBASE_SECRET_KEY: KEY })).toBe(KEY);
    expect(() => secretKey({ ONEBASE_SECRET_KEY: "short" })).toThrow("needs at least 32");
  });
});

describe("streams", () => {
  const MB = 1 << 20;
  const bytes = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 255;
    return out;
  };
  /** Feeds `data` through `transform` in pieces of `piece` bytes. */
  const through = async (data: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>, piece = 70_001) => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < data.byteLength; at += piece) controller.enqueue(data.subarray(at, at + piece));
        controller.close();
      },
    });
    return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer());
  };

  test("any length round-trips, however the bytes arrive", async () => {
    for (const size of [0, 1, MB - 1, MB, MB + 1, 2 * MB, 2 * MB + 12345]) {
      const plain = bytes(size);
      const sealed = await through(plain, encryptStream(KEY));
      expect(sealed.byteLength).toBe(7 + 8 + size + 16 * Math.max(1, Math.ceil(size / MB)));
      for (const piece of [1 << 30, 4096 + 7]) {
        const opened = await through(sealed, decryptStream(KEY), piece);
        expect(Bun.hash(opened)).toBe(Bun.hash(plain));
        expect(opened.byteLength).toBe(size);
      }
    }
  });

  test("the wrong key, a changed byte, a missing tail and reordered chunks are all refused", async () => {
    const sealed = await through(bytes(2 * MB + 500), encryptStream(KEY));
    const open = (data: Uint8Array, key = KEY) => through(data, decryptStream(key));
    await expect(open(sealed, OTHER)).rejects.toThrow("can't be decrypted");

    const flipped = sealed.slice();
    flipped[MB]! ^= 1;
    await expect(open(flipped)).rejects.toThrow("can't be decrypted");

    // Cut exactly after the first two chunks: what's left is well-formed chunks, but not the whole file.
    const chunk = MB + 16;
    await expect(open(sealed.subarray(0, 15 + 2 * chunk))).rejects.toThrow("can't be decrypted");
    await expect(open(sealed.subarray(0, 15 + chunk))).rejects.toThrow("can't be decrypted");
    await expect(open(sealed.subarray(0, 10))).rejects.toThrow("cut short");

    const swapped = sealed.slice();
    swapped.set(sealed.subarray(15 + chunk, 15 + 2 * chunk), 15);
    swapped.set(sealed.subarray(15, 15 + chunk), 15 + chunk);
    await expect(open(swapped)).rejects.toThrow("can't be decrypted");

    await expect(open(new TextEncoder().encode("not a backup at all, just some text"))).rejects.toThrow("isn't an encrypted onebase backup");
  });
});

describe("stored environment variables", () => {
  const dir = mkdtempSync(join(tmpdir(), "onebase-secrets-"));
  afterEach(() => {
    delete process.env.ONEBASE_SECRET_KEY;
    for (const k of Object.keys(process.env)) if (k.startsWith("OBSEC_")) delete process.env[k];
  });
  const open = async (name: string) => {
    const driver = new SqliteDriver(join(dir, `${name}.sqlite`));
    const runtime = new Runtime({ driver, log: quiet, schema: null, modules: {} });
    await runtime.init();
    return { driver, runtime, raw: () => driver.read((tx) => tx.all("SELECT name, value FROM _env ORDER BY name")), close: async () => (runtime.stop(), await driver.close()) };
  };

  test("are encrypted in the database once a key is set, including ones saved before", async () => {
    const plain = await open("a");
    await plain.runtime.setEnvVars({ OBSEC_OLD: "saved in the clear" });
    expect(await plain.raw()).toEqual([{ name: "OBSEC_OLD", value: "saved in the clear" }]);
    await plain.close();
    delete process.env.OBSEC_OLD;

    process.env.ONEBASE_SECRET_KEY = KEY;
    const sealed = await open("a");
    await sealed.runtime.setEnvVars({ OBSEC_NEW: "saved sealed" });
    const rows = await sealed.raw();
    expect(rows.map((r) => r.name)).toEqual(["OBSEC_NEW", "OBSEC_OLD"]);
    for (const r of rows) expect(r.value as string).toStartWith("enc:v1:");
    expect(JSON.stringify(rows)).not.toContain("saved");
    // The server itself still sees them.
    expect([process.env.OBSEC_OLD, process.env.OBSEC_NEW]).toEqual(["saved in the clear", "saved sealed"]);
    expect((await sealed.runtime.listEnvVars()).map((e) => [e.name, e.value])).toEqual([
      ["OBSEC_NEW", "saved sealed"],
      ["OBSEC_OLD", "saved in the clear"],
    ]);
    // Saving the same value again changes nothing.
    expect((await sealed.runtime.setEnvVars({ OBSEC_NEW: "saved sealed" })).changed).toEqual([]);
    await sealed.close();

    // Without the key, or with another one, the server says what is wrong instead of starting half-configured.
    delete process.env.ONEBASE_SECRET_KEY;
    await expect(open("a")).rejects.toThrow("stored encrypted, and this server has no $ONEBASE_SECRET_KEY");
    process.env.ONEBASE_SECRET_KEY = OTHER;
    await expect(open("a")).rejects.toThrow("saved under a different key");
  });
});
