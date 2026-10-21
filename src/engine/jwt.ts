// JWT verification for auth.config.ts providers (Clerk, Auth0, WorkOS, any OIDC issuer, or custom JWKS).
// Uses WebCrypto only; no dependencies.

import type { UserIdentity } from "../server";
import { OnebaseError } from "./database";

/** Same shape as Convex: `{ domain, applicationID }` for OIDC issuers. */
export type OidcProvider = { type?: "oidc"; domain: string; applicationID?: string };
/** For issuers without OIDC discovery: point at the JWKS directly. */
export type CustomJwtProvider = {
  type: "customJwt";
  issuer: string;
  jwks: string;
  applicationID?: string;
  algorithm?: string;
};
export type AuthProvider = OidcProvider | CustomJwtProvider;

type Jwk = Record<string, any> & { kid?: string; alg?: string };
type AlgParams = { name: string; [key: string]: unknown };
type Header = { alg: string; kid?: string; typ?: string };
type Claims = Record<string, unknown> & { iss?: string; sub?: string; aud?: string | string[]; exp?: number; nbf?: number };

const ALGORITHMS: Record<string, { import: AlgParams; verify: AlgParams }> = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS384: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS512: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  PS256: { import: { name: "RSA-PSS", hash: "SHA-256" }, verify: { name: "RSA-PSS", saltLength: 32 } },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { import: { name: "ECDSA", namedCurve: "P-384" }, verify: { name: "ECDSA", hash: "SHA-384" } },
  EdDSA: { import: { name: "Ed25519" }, verify: { name: "Ed25519" } },
};

/** Clock skew tolerated for exp/nbf. */
const LEEWAY_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60_000;
const MIN_REFETCH_MS = 30_000;

const decoder = new TextDecoder();

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function b64urlJson<T>(s: string, what: string): T {
  try {
    return JSON.parse(decoder.decode(b64urlBytes(s)));
  } catch {
    throw new OnebaseError(`Invalid auth token: the ${what} isn't valid base64url JSON.`);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** Reads a token's claims without verifying it (used to pick a provider). */
export function decodeJwt(token: string): { header: Header; claims: Claims; signed: string; signature: Uint8Array<ArrayBuffer> } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OnebaseError("Invalid auth token: expected a JWT (three dot-separated parts).");
  const [h, p, s] = parts as [string, string, string];
  return { header: b64urlJson<Header>(h, "header"), claims: b64urlJson<Claims>(p, "payload"), signed: `${h}.${p}`, signature: b64urlBytes(s) };
}

export class JwtVerifier {
  private jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
  private jwksUriCache = new Map<string, string>();

  constructor(
    private readonly providers: AuthProvider[],
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    for (const p of providers) {
      if (p.type === "customJwt") {
        if (!p.issuer || !p.jwks) throw new Error(`auth.config.ts: customJwt providers need "issuer" and "jwks" URLs.`);
      } else if (!p.domain) {
        throw new Error(`auth.config.ts: providers need a "domain" (the token issuer URL), e.g. { domain: "https://your-app.clerk.accounts.dev", applicationID: "onebase" }.`);
      }
    }
  }

  private issuerOf(p: AuthProvider) {
    return trimSlash(p.type === "customJwt" ? p.issuer : p.domain);
  }

  /** Whether some provider is configured for this token's issuer. */
  handles(token: string): boolean {
    try {
      const { claims } = decodeJwt(token);
      return typeof claims.iss === "string" && this.providers.some((p) => this.issuerOf(p) === trimSlash(claims.iss!));
    } catch {
      return false;
    }
  }

  private async jwksUri(p: AuthProvider): Promise<string> {
    if (p.type === "customJwt") return p.jwks;
    const issuer = this.issuerOf(p);
    const cached = this.jwksUriCache.get(issuer);
    if (cached) return cached;
    const res = await this.fetchFn(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new OnebaseError(`Couldn't load OIDC configuration from ${issuer} (HTTP ${res.status}).`);
    const config = (await res.json()) as { jwks_uri?: string };
    if (!config.jwks_uri) throw new OnebaseError(`OIDC configuration at ${issuer} has no jwks_uri.`);
    this.jwksUriCache.set(issuer, config.jwks_uri);
    return config.jwks_uri;
  }

  private async keys(p: AuthProvider, forceRefresh: boolean): Promise<Jwk[]> {
    const uri = await this.jwksUri(p);
    const cached = this.jwksCache.get(uri);
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && age < JWKS_TTL_MS && !(forceRefresh && age > MIN_REFETCH_MS)) return cached.keys;
    const res = await this.fetchFn(uri);
    if (!res.ok) throw new OnebaseError(`Couldn't load JWKS from ${uri} (HTTP ${res.status}).`);
    const { keys } = (await res.json()) as { keys?: Jwk[] };
    if (!Array.isArray(keys)) throw new OnebaseError(`JWKS at ${uri} has no "keys" array.`);
    this.jwksCache.set(uri, { keys, fetchedAt: Date.now() });
    return keys;
  }

  async verify(token: string): Promise<UserIdentity> {
    const { header, claims, signed, signature } = decodeJwt(token);
    const iss = typeof claims.iss === "string" ? trimSlash(claims.iss) : null;
    const provider = this.providers.find((p) => this.issuerOf(p) === iss);
    if (!provider) {
      const known = this.providers.map((p) => this.issuerOf(p)).join(", ");
      throw new OnebaseError(`Auth token issuer "${claims.iss}" isn't configured in auth.config.ts (configured: ${known}).`);
    }
    const alg = ALGORITHMS[header.alg];
    if (!alg) throw new OnebaseError(`Auth token uses unsupported algorithm "${header.alg}". Supported: ${Object.keys(ALGORITHMS).join(", ")}.`);
    if (provider.type === "customJwt" && provider.algorithm && provider.algorithm !== header.alg) {
      throw new OnebaseError(`Auth token algorithm ${header.alg} doesn't match the configured ${provider.algorithm}.`);
    }

    const pick = (keys: Jwk[]) =>
      keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg));
    let jwk = pick(await this.keys(provider, false));
    if (!jwk) jwk = pick(await this.keys(provider, true)); // keys may have rotated
    if (!jwk) throw new OnebaseError(`No signing key${header.kid ? ` with kid "${header.kid}"` : ""} found for ${iss}.`);

    const key = await crypto.subtle.importKey("jwk", jwk as any, alg.import as any, false, ["verify"]);
    const ok = await crypto.subtle.verify(alg.verify as any, key, signature, new TextEncoder().encode(signed));
    if (!ok) throw new OnebaseError("Auth token signature is invalid.");

    const now = Date.now() / 1000;
    if (typeof claims.exp === "number" && now > claims.exp + LEEWAY_SECONDS) {
      throw new OnebaseError(`Auth token expired at ${new Date(claims.exp * 1000).toISOString()}. Fetch a fresh token on the client.`);
    }
    if (typeof claims.nbf === "number" && now < claims.nbf - LEEWAY_SECONDS) {
      throw new OnebaseError("Auth token is not valid yet (nbf is in the future).");
    }
    if (provider.applicationID) {
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(provider.applicationID)) {
        throw new OnebaseError(
          `Auth token audience ${JSON.stringify(claims.aud)} doesn't include applicationID "${provider.applicationID}". ` +
            `Check the JWT template / audience on your auth provider.`,
        );
      }
    }
    if (typeof claims.sub !== "string") throw new OnebaseError("Auth token has no subject (sub claim).");
    return identityFromClaims(claims as Claims & { sub: string });
  }
}

/** Maps standard OIDC claims to the identity shape Convex uses. */
export function identityFromClaims(claims: Claims & { sub: string }): UserIdentity {
  const { iss, sub, aud, exp, nbf, iat, jti, ...rest } = claims;
  const camel: Record<string, string> = {
    given_name: "givenName",
    family_name: "familyName",
    preferred_username: "preferredUsername",
    email_verified: "emailVerified",
    phone_number: "phoneNumber",
    phone_number_verified: "phoneNumberVerified",
    picture: "pictureUrl",
    updated_at: "updatedAt",
  };
  const identity: UserIdentity = { subject: sub, issuer: iss, tokenIdentifier: `${iss}|${sub}` };
  for (const [k, v] of Object.entries(rest)) identity[camel[k] ?? k] = v;
  return identity;
}

export type AuthConfig = {
  providers?: AuthProvider[];
  /** Custom verification for anything else (API keys, sessions...). Return null for anonymous. */
  authenticate?: (token: string) => Promise<UserIdentity | null> | UserIdentity | null;
};

/** Turns auth.config.ts into one authenticate(token) function. */
export function createAuthenticate(config: AuthConfig) {
  const verifier = config?.providers?.length ? new JwtVerifier(config.providers) : null;
  const custom = typeof config?.authenticate === "function" ? config.authenticate : null;
  if (!verifier && !custom) {
    throw new Error(
      "auth.config.ts must export default { providers: [{ domain, applicationID }] } and/or { authenticate: async (token) => identity | null }.",
    );
  }
  return async (token: string): Promise<UserIdentity | null> => {
    if (verifier && (verifier.handles(token) || !custom)) return verifier.verify(token);
    return (await custom!(token)) ?? null;
  };
}
