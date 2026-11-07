// `onebase upgrade`: replaces this binary with a release from GitHub, after checking its SHA-256
// against the release's SHA256SUMS and that it runs. The old binary is kept next to it as
// <name>.old, so going back is one `mv`. A running server keeps the old code until it restarts.

import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { compareVersions, parseVersion, VERSION } from "./version";

export const REPO = "abdullah-bl/onebase";

export type UpgradeOptions = {
  /** The release to install, e.g. 0.3.0 (default: the latest). */
  version?: string;
  /** Only say whether a newer release exists. */
  check?: boolean;
  /** Whether this is a compiled binary (otherwise there's nothing to replace). */
  compiled: boolean;
  /** The binary to replace (default: this process's). */
  execPath?: string;
  platform?: string;
  arch?: string;
  /** The running version (default: this onebase's). */
  current?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
};

export type UpgradeResult = { status: "up-to-date" | "available" | "upgraded" | "not-a-binary"; current: string; release?: string };

type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] };

/** The release asset for this machine, as the release workflow names them. */
export function assetName(platform: string, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  if (!["linux", "darwin", "windows"].includes(os) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`There's no prebuilt onebase for ${platform}-${arch}. Build one from source with bun run build:binary.`);
  }
  return `onebase-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

export async function upgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const log = opts.log ?? ((line) => console.log(line));
  const get = opts.fetch ?? fetch;
  const current = opts.current ?? VERSION;
  if (!opts.compiled && !opts.check) {
    log(
      existsSync("/.dockerenv")
        ? "This onebase runs from source inside a container. Pull a newer image (or rebuild yours) and recreate the container instead."
        : "This onebase runs from source, so there's no binary to replace. Update the checkout (git pull && bun install), or switch to a release binary.",
    );
    return { status: "not-a-binary", current };
  }

  const wanted = opts.version ? `v${opts.version.replace(/^v/, "")}` : null;
  if (wanted && !parseVersion(wanted)) throw new Error(`"${opts.version}" isn't a version. Pass one like 0.3.0.`);
  const api = `https://api.github.com/repos/${REPO}/releases/${wanted ? `tags/${wanted}` : "latest"}`;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "onebase-cli" };
  const res = await get(api, { headers });
  if (res.status === 404) throw new Error(wanted ? `There's no onebase release ${wanted}. See https://github.com/${REPO}/releases.` : "No onebase release found.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${api}${res.status === 403 ? " (rate limited? try again in a while)" : ""}.`);
  const release = (await res.json()) as Release;
  const target = release.tag_name.replace(/^v/, "");

  const order = compareVersions(target, current);
  if (!wanted && order <= 0) {
    log(`onebase ${current} is up to date${order < 0 ? ` (the latest release is ${target})` : ""}.`);
    return { status: "up-to-date", current, release: target };
  }
  if (wanted && order === 0) {
    log(`onebase ${current} is already installed.`);
    return { status: "up-to-date", current, release: target };
  }
  if (opts.check) {
    log(`onebase ${target} is available (this is ${current}). Run onebase upgrade to install it. Release notes: https://github.com/${REPO}/releases/tag/${release.tag_name}`);
    return { status: "available", current, release: target };
  }

  const name = assetName(opts.platform ?? process.platform, opts.arch ?? process.arch);
  const asset = release.assets.find((a) => a.name === name);
  const sums = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!asset) throw new Error(`Release ${release.tag_name} has no ${name}.`);
  if (!sums) throw new Error(`Release ${release.tag_name} has no SHA256SUMS, so its binary can't be checked. Download it by hand if you trust it.`);

  log(`Downloading onebase ${target} (${name})…`);
  const [binary, sumsText] = await Promise.all([download(get, asset.browser_download_url), download(get, sums.browser_download_url).then((b) => new TextDecoder().decode(b))]);
  const expected = sumsText
    .split("\n")
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`SHA256SUMS in ${release.tag_name} doesn't list ${name}.`);
  const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  if (actual !== expected.toLowerCase()) throw new Error(`${name} doesn't match its SHA-256 in SHA256SUMS (got ${actual}). Nothing was changed.`);

  const exec = opts.execPath ?? process.execPath;
  const fresh = `${exec}.new`;
  const old = `${exec}.old`;
  try {
    writeFileSync(fresh, binary);
    chmodSync(fresh, 0o755);
  } catch (err) {
    rmSync(fresh, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "EACCES" || code === "EPERM"
        ? `Can't write next to ${exec}. Run it as the user that owns it (for example with sudo).`
        : `Couldn't write ${fresh}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // It has to run here (right architecture, not truncated) before it replaces anything.
  const probe = Bun.spawnSync([fresh, "version"], { stdout: "pipe", stderr: "pipe" });
  const reported = probe.stdout.toString().trim();
  if (probe.exitCode !== 0 || compareVersions(reported, target) !== 0 || !parseVersion(reported)) {
    rmSync(fresh, { force: true });
    throw new Error(`The downloaded binary didn't run (${probe.stderr.toString().trim() || `printed "${reported}"`}). Nothing was changed.`);
  }

  renameSync(exec, old);
  try {
    renameSync(fresh, exec);
  } catch (err) {
    renameSync(old, exec);
    throw err;
  }
  log(`\x1b[32m✓\x1b[0m Installed onebase ${target} at ${exec}; ${current} is kept as ${basename(old)}.`);
  log(`  Back up the database (onebase backup, or a copy of onebase_data with the server stopped), then restart the server to run it.`);
  log(`  To go back: mv ${old} ${exec}, and restart. If ${target} migrated the database, ${current} refuses it: restore the backup.`);
  return { status: "upgraded", current, release: target };
}

async function download(get: NonNullable<UpgradeOptions["fetch"]>, url: string): Promise<Uint8Array> {
  const res = await get(url, { headers: { "User-Agent": "onebase-cli" } });
  if (!res.ok) throw new Error(`Downloading ${url} failed: HTTP ${res.status}.`);
  return new Uint8Array(await res.arrayBuffer());
}
