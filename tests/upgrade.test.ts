// Upgrades: the storage stamp (migrations forward, refusing a newer database), version warnings
// on deploys, and `onebase upgrade` replacing a binary only after checking it.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDriver } from "../src/engine/driver";
import { versionWarning } from "../src/engine/runtime";
import { checkStorage, STORAGE_VERSION, type Migration } from "../src/engine/storage";
import { assetName, upgrade } from "../src/upgrade";
import { compareVersions, compatibleVersions } from "../src/version";
import { openRuntime, quiet } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "onebase-upgrade-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDriver = async () => {
  const driver = new SqliteDriver(join(root, `db${n++}.sqlite`));
  await driver.init();
  return driver;
};
const stamp = async (driver: SqliteDriver) =>
  JSON.parse((await driver.read((tx) => tx.get(`SELECT value FROM _meta WHERE "key" = 'storage'`)))!.value as string);

describe("versions", () => {
  test("compare and compatibility", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compatibleVersions("0.2.0", "0.2.5")).toBe(true);
    expect(compatibleVersions("0.2.0", "0.3.0")).toBe(false);
    expect(compatibleVersions("1.2.0", "1.9.0")).toBe(true);
    expect(compatibleVersions("1.2.0", "2.0.0")).toBe(false);
    expect(versionWarning("0.1.0", "0.2.0")).toContain("built with onebase 0.1.0");
    expect(versionWarning("0.2.1", "0.2.0")).toBeNull();
    expect(versionWarning(null, "0.2.0")).toBeNull();
  });
});

describe("storage stamp", () => {
  test("a new database is stamped with this format and version", async () => {
    const driver = await freshDriver();
    expect(await checkStorage(driver, { version: "0.2.0" })).toEqual({ previous: null, migrated: [] });
    expect(await stamp(driver)).toMatchObject({ version: STORAGE_VERSION, onebase: "0.2.0" });
    // A newer onebase records itself; an older one of the same format leaves the stamp alone.
    expect((await checkStorage(driver, { version: "0.3.0" })).previous).toBe("0.2.0");
    await checkStorage(driver, { version: "0.2.5" });
    expect((await stamp(driver)).onebase).toBe("0.3.0");
    driver.close();
  });

  test("migrations run once, in order, and an older onebase then refuses the database", async () => {
    const driver = await freshDriver();
    await checkStorage(driver, { version: "0.2.0" });
    const ran: number[] = [];
    const migrations: Migration[] = [2, 3].map((version) => ({
      version,
      description: `step ${version}`,
      run: async (tx) => {
        ran.push(version);
        await tx.run(`INSERT INTO _meta ("key", value) VALUES (?, 'x')`, [`m${version}`]);
      },
    }));
    const r = await checkStorage(driver, { version: "0.3.0", migrations });
    expect(r.migrated.map((m) => m.version)).toEqual([2, 3]);
    expect(await stamp(driver)).toMatchObject({ version: 3, onebase: "0.3.0" });
    await checkStorage(driver, { version: "0.3.0", migrations });
    expect(ran).toEqual([2, 3]);

    await expect(checkStorage(driver, { version: "0.2.0" })).rejects.toThrow(/storage format 3, written by onebase 0\.3\.0.*reads up to format 1/);
    expect(await stamp(driver)).toMatchObject({ version: 3 }); // unchanged
    driver.close();
  });

  test("a failed migration changes nothing", async () => {
    const driver = await freshDriver();
    const migrations: Migration[] = [
      {
        version: 2,
        description: "breaks",
        run: async (tx) => {
          await tx.run(`INSERT INTO _meta ("key", value) VALUES ('half', 'x')`);
          throw new Error("boom");
        },
      },
    ];
    await expect(checkStorage(driver, { version: "0.3.0", migrations })).rejects.toThrow("boom");
    expect(await driver.read((tx) => tx.get(`SELECT * FROM _meta WHERE "key" = 'half'`))).toBeNull();
    expect(await driver.read((tx) => tx.get(`SELECT * FROM _meta WHERE "key" = 'storage'`))).toBeNull();
    driver.close();
  });

  test("the runtime refuses to start on a database from a newer format", async () => {
    const path = join(root, "newer.sqlite");
    const seed = new SqliteDriver(path);
    await seed.init();
    await seed.write((tx) => tx.run(`INSERT INTO _meta ("key", value) VALUES ('storage', ?)`, [JSON.stringify({ version: 99, onebase: "9.0.0", updated: 0 })]));
    seed.close();
    await expect(openRuntime(() => new SqliteDriver(path), { schema: null, modules: {}, log: quiet })).rejects.toThrow("storage format 99");
  });
});

describe("onebase upgrade", () => {
  const ASSET = "onebase-linux-x64";
  /** A fake release: the binary is a shell script printing its version. */
  function release(version: string, opts: { badSum?: boolean; prints?: string } = {}) {
    const binary = new TextEncoder().encode(`#!/bin/sh\necho ${opts.prints ?? version}\n`);
    const sum = opts.badSum ? "0".repeat(64) : new Bun.CryptoHasher("sha256").update(binary).digest("hex");
    const files: Record<string, Uint8Array<ArrayBuffer> | string> = {
      [`https://dl/${ASSET}`]: binary,
      "https://dl/SHA256SUMS": `${"1".repeat(64)}  onebase-darwin-arm64\n${sum}  ${ASSET}\n`,
    };
    const json = { tag_name: `v${version}`, assets: [ASSET, "SHA256SUMS"].map((name) => ({ name, browser_download_url: `https://dl/${name}` })) };
    return async (url: string) => {
      if (url.includes("api.github.com")) return url.endsWith("/latest") || url.endsWith(`/v${version}`) ? Response.json(json) : new Response("", { status: 404 });
      const body = files[url];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body as BodyInit);
    };
  }
  const installed = (name: string) => {
    const path = join(root, name);
    writeFileSync(path, "#!/bin/sh\necho 0.2.0\n");
    chmodSync(path, 0o755);
    return path;
  };
  const base = { compiled: true, current: "0.2.0", platform: "linux", arch: "x64", log: () => {} };

  test("names assets as the release workflow does", () => {
    expect(assetName("darwin", "arm64")).toBe("onebase-darwin-arm64");
    expect(assetName("win32", "x64")).toBe("onebase-windows-x64.exe");
    expect(() => assetName("freebsd", "x64")).toThrow("no prebuilt");
  });

  test("checks, then replaces the binary and keeps the old one", async () => {
    const exec = installed("ok");
    expect(await upgrade({ ...base, execPath: exec, check: true, fetch: release("0.3.0") })).toMatchObject({ status: "available", release: "0.3.0" });
    expect(readFileSync(exec, "utf8")).toContain("0.2.0");
    expect(await upgrade({ ...base, execPath: exec, fetch: release("0.3.0") })).toMatchObject({ status: "upgraded" });
    expect(readFileSync(exec, "utf8")).toContain("0.3.0");
    expect(readFileSync(`${exec}.old`, "utf8")).toContain("0.2.0");
    expect(existsSync(`${exec}.new`)).toBe(false);
  });

  test("is up to date when the latest isn't newer", async () => {
    expect(await upgrade({ ...base, execPath: installed("same"), fetch: release("0.2.0") })).toMatchObject({ status: "up-to-date" });
    expect(await upgrade({ ...base, execPath: installed("older"), fetch: release("0.1.0") })).toMatchObject({ status: "up-to-date" });
  });

  test("refuses a binary that fails its checksum or doesn't run, changing nothing", async () => {
    const exec = installed("bad");
    await expect(upgrade({ ...base, execPath: exec, fetch: release("0.3.0", { badSum: true }) })).rejects.toThrow("doesn't match its SHA-256");
    await expect(upgrade({ ...base, execPath: exec, fetch: release("0.3.0", { prints: "garbage" }) })).rejects.toThrow("didn't run");
    expect(readFileSync(exec, "utf8")).toContain("0.2.0");
    expect(existsSync(`${exec}.old`) || existsSync(`${exec}.new`)).toBe(false);
  });

  test("a named version that doesn't exist, and running from source", async () => {
    await expect(upgrade({ ...base, execPath: installed("missing"), version: "0.9.0", fetch: release("0.3.0") })).rejects.toThrow("no onebase release v0.9.0");
    expect(await upgrade({ ...base, compiled: false, fetch: release("0.3.0") })).toMatchObject({ status: "not-a-binary" });
  });
});

describe("deploys across versions", () => {
  test("warns when the CLI's onebase doesn't match the server's, or didn't say", async () => {
    const { startApp } = await import("../src/app");
    const { adminCall, bundleProject } = await import("../src/deploy");
    const dataDir = join(root, "server");
    const app = await startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
    Object.assign(app.runtime, { log: quiet });
    try {
      const url = `http://127.0.0.1:${app.server.port}`;
      const key = readFileSync(join(dataDir, "admin.key"), "utf8").trim();
      const dir = join(root, "proj", "onebase");
      (await import("node:fs")).mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "a.ts"), `import { query } from "onebase/server";\nexport const q = query({ args: {}, handler: async () => 1 });\n`);
      const { code } = await bundleProject(dir);
      expect(code).toContain(`onebaseVersion: "${(await import("../src/version")).VERSION}"`);

      const same = await adminCall(url, key, "deploy", { code, onebaseVersion: "0.2.0" });
      expect(same.warnings).toEqual([]);
      const old = await adminCall(url, key, "deploy", { code: code.replace(/onebaseVersion: "[^"]+"/, 'onebaseVersion: "0.1.0"'), onebaseVersion: "0.1.0" });
      expect(old.warnings[0]).toContain("built with onebase 0.1.0");
      const unknown = await adminCall(url, key, "deploy", { code });
      expect(unknown.warnings[0]).toContain("didn't send its version");
      const dry = await adminCall(url, key, "deploy", { code, dryRun: true, schema: "", functions: 1, onebaseVersion: "0.1.0" });
      expect(dry.warnings[0]).toContain("built with onebase 0.1.0");
    } finally {
      await app.close();
    }
  });
});
