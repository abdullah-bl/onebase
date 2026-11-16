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
  /** Set to false to skip checking who built the binary (--no-verify). */
  verify?: boolean;
  /** Checks who built the binary; throws if it can't tell (default: verifyProvenance). */
  provenance?: (binary: Provenance) => Promise<void>;
};

/** A downloaded release binary: its file name, SHA-256 (hex) and the release's tag. */
export type Provenance = { name: string; digest: string; tag: string; fetch: NonNullable<UpgradeOptions["fetch"]> };

/** The first release whose binaries were signed. Older ones can only be checked against SHA256SUMS. */
const FIRST_ATTESTED = "0.3.0";

/**
 * Checks that GitHub Actions built this exact binary from this repository's release workflow, at
 * the release's tag. SHA256SUMS can't say that: it sits in the same release, so whoever could
 * replace the binary could replace it too. The attestation is signed with a short-lived
 * certificate that Sigstore issued to that workflow run and recorded in a public log; the
 * signature, the certificate's chain, the log entry and the workflow it names are all checked.
 */
export async function verifyProvenance({ name, digest, tag, fetch: get }: Provenance): Promise<void> {
  const api = `https://api.github.com/repos/${REPO}/attestations/sha256:${digest}`;
  const res = await get(api, { headers: { Accept: "application/vnd.github+json", "User-Agent": "onebase-cli" } });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub answered ${res.status} for ${api}${res.status === 403 ? " (rate limited? try again in a while)" : ""}.`);
  const attestations = res.ok ? (((await res.json()) as { attestations?: { bundle: any }[] }).attestations ?? []) : [];
  if (!attestations.length) throw new Error(`GitHub has no build attestation for ${name} (sha256 ${digest}), so there's no telling who built it.`);

  const { verify } = await import("sigstore");
  let reason: unknown;
  for (const { bundle } of attestations) {
    try {
      await verify(bundle, {
        certificateIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentityURI: `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/${tag}`,
      });
      // The signature covers this statement, and the statement names the files it is about.
      const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString());
      if (bundle.dsseEnvelope.payloadType !== "application/vnd.in-toto+json" || statement.predicateType !== "https://slsa.dev/provenance/v1") {
        throw new Error("it isn't a build provenance statement");
      }
      if (!statement.subject?.some((s: any) => s?.name === name && s?.digest?.sha256 === digest)) throw new Error("it is about a different file");
      return;
    } catch (err) {
      reason = err;
    }
  }
  throw new Error(`The build attestation for ${name} doesn't hold: ${reason instanceof Error ? reason.message : String(reason)}.`);
}

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

  if (opts.verify === false) {
    log(`  Not checking who built it (--no-verify).`);
  } else if (compareVersions(target, FIRST_ATTESTED) < 0) {
    log(`  onebase ${target} is from before releases were signed, so only its checksum was checked.`);
  } else {
    try {
      await (opts.provenance ?? verifyProvenance)({ name, digest: actual, tag: release.tag_name, fetch: get });
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\nNothing was changed. If this machine can't reach Sigstore or GitHub's API, ` +
          `check the binary elsewhere with gh attestation verify ${name} --repo ${REPO}, then pass --no-verify.`,
      );
    }
    log(`  Built by this repository's release workflow at ${release.tag_name} (signed attestation checked).`);
  }

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
