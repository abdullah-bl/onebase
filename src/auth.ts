// Built-in sign-in methods for auth.config.ts (imported as "onebase/auth").
// These only describe a method; the engine (src/engine/auth.ts) runs the flows.

import type { FunctionLike } from "./api";
import { decodeJwt, JwtVerifier } from "./engine/jwt";

/** What an OAuth provider tells us about the person signing in. */
export type OAuthProfile = {
  /** The provider's stable id for the account. */
  id: string;
  email?: string;
  /** Only verified emails are used to link a sign-in to an existing user. */
  emailVerified?: boolean;
  name?: string;
  image?: string;
};

export type OAuthEndpoints = { authorizationUrl: string; tokenUrl: string };
/** The token endpoint's response: access_token, id_token, refresh_token, … */
export type OAuthTokens = Record<string, unknown> & { access_token: string };

/** What sendCode can use to reach your functions, e.g. an internal action that sends email. */
export type SendCodeCtx = {
  runQuery(fn: FunctionLike, args?: Record<string, unknown>): Promise<any>;
  runMutation(fn: FunctionLike, args?: Record<string, unknown>): Promise<any>;
  runAction(fn: FunctionLike, args?: Record<string, unknown>): Promise<any>;
};

/**
 * Sends a one-time code to an email address: `purpose` is "verify" (confirm the address) or
 * "reset" (choose a new password). Throw if it can't be sent.
 */
export type SendCode<Purpose extends string = "verify" | "reset"> = (message: { email: string; code: string; purpose: Purpose }, ctx: SendCodeCtx) => Promise<void> | void;

export type PasswordMethod = {
  kind: "password";
  id: "password";
  minLength: number;
  /** Fields for a new user's document in the users table. */
  profile?: (params: Record<string, unknown>) => Record<string, unknown>;
  /** Emails codes for password reset and email verification. */
  sendCode?: SendCode;
  /** New accounts must confirm their email with a code before they can sign in. */
  verifyEmail: boolean;
};

/** What the provider sent back to the callback besides the code, e.g. Apple's `user` on first sign-in. */
export type OAuthCallback = { params: Record<string, string> };

/** A client secret, or a function that makes one per token request (Apple signs a short-lived JWT). */
export type ClientSecret = string | (() => string | Promise<string>);

export type OAuthMethod = {
  kind: "oauth";
  id: string;
  name: string;
  clientId: string;
  clientSecret: ClientSecret;
  scopes: string[];
  /** Joins scopes in the authorization URL; a space unless the provider wants something else. */
  scopeSeparator?: string;
  /** Extra query parameters for the authorization URL. */
  authorizationParams?: Record<string, string>;
  /** How the token request authenticates: client_secret in the body ("post", the default) or HTTP Basic ("basic"). */
  tokenAuth?: "post" | "basic";
  /** Send a PKCE challenge to the provider (default true). Turn off for providers that reject it. */
  pkce?: boolean;
  endpoints(): Promise<OAuthEndpoints>;
  profile(tokens: OAuthTokens, callback: OAuthCallback): Promise<OAuthProfile>;
};

/** What an ID-token or email-code sign-in tells `profile` about a new user. */
export type NewUserInfo = {
  provider: string;
  /** The account's id at the provider: Apple's `sub`, the email address for email codes. */
  accountId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  /** The params the client sent with the sign-in. */
  params: Record<string, unknown>;
};

/** Fields for the new user's document in the users table, beyond name and email. */
export type NewUserProfile = (info: NewUserInfo) => Record<string, unknown>;

/** A profile read from a verified ID token, plus what stops the same token being used twice. */
export type IdTokenResult = OAuthProfile & {
  /** Unique to this token. The token works once: a second sign-in with the same key is refused until `until`. */
  once: { key: string; until: number };
};

/** Sign-in with a token the app's own SDK got from the provider (Sign in with Apple on iPhone). */
export type IdTokenMethod = {
  kind: "idToken";
  id: string;
  name: string;
  profile?: NewUserProfile;
  /** Checks the client's params and returns who is signing in; throws if the token isn't good. */
  verify(params: Record<string, unknown>): Promise<IdTokenResult>;
  /** The same provider as a browser redirect, used when the client sends no idToken. Shares the method's id, so accounts are the same. */
  web?: OAuthMethod;
};

/** Passwordless sign-in: a one-time code emailed to the address. */
export type EmailCodeMethod = {
  kind: "emailCode";
  id: "email";
  codeLength: 6 | 8;
  sendCode: SendCode<"signin">;
  profile?: NewUserProfile;
};

export type AuthMethod = PasswordMethod | OAuthMethod | IdTokenMethod | EmailCodeMethod;

/**
 * Email and password. Sign up with `signIn("password", { flow: "signUp", email, password })`,
 * sign in with `flow: "signIn"`. Passwords are hashed with argon2id.
 *
 * With `sendCode`, people can reset a forgotten password (`flow: "reset"`, then
 * `"reset-verification"`), and `verifyEmail: true` makes new accounts confirm their address
 * (`flow: "email-verification"` with the code and the password they signed up with) before they
 * can sign in.
 */
export function password(
  options: { minLength?: number; profile?: PasswordMethod["profile"]; sendCode?: SendCode; verifyEmail?: boolean } = {},
): PasswordMethod {
  if (options.verifyEmail && typeof options.sendCode !== "function") {
    throw new Error("password({ verifyEmail: true }) needs a sendCode function to email the codes.");
  }
  return {
    kind: "password",
    id: "password",
    minLength: options.minLength ?? 8,
    profile: options.profile,
    sendCode: options.sendCode,
    verifyEmail: options.verifyEmail ?? false,
  };
}

type Credentials = { clientId?: string; clientSecret?: string };

function credentials(id: string, envPrefix: string, given: Credentials) {
  const clientId = given.clientId ?? process.env[`${envPrefix}_ID`];
  const clientSecret = given.clientSecret ?? process.env[`${envPrefix}_SECRET`];
  if (!clientId || !clientSecret) {
    throw new Error(`Sign-in method "${id}" needs a client id and secret: pass { clientId, clientSecret } or set ${envPrefix}_ID and ${envPrefix}_SECRET.`);
  }
  return { clientId, clientSecret };
}

async function getJson(url: string, accessToken: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const RESERVED_IDS = new Set(["password", "email"]);

type OAuthOptions = {
  id: string;
  name?: string;
  clientId: string;
  clientSecret: ClientSecret;
  scopes?: string[];
  /** Joins scopes in the authorization URL (default a space). */
  scopeSeparator?: string;
  authorizationParams?: Record<string, string>;
  /** "basic" sends the client id and secret as HTTP Basic auth instead of in the body (X needs this). */
  tokenAuth?: "post" | "basic";
  /** Send a PKCE challenge (default true). */
  pkce?: boolean;
};

/**
 * Any OAuth 2.0 provider: give its endpoints and how to read the user's profile.
 * The callback URL to register with the provider is `<your --url>/api/auth/callback/<id>`.
 */
export function oauth(
  config: OAuthOptions & {
    authorizationUrl: string;
    tokenUrl: string;
    /** Reads the profile, usually from a user info endpoint, with the access token. */
    profile: (tokens: OAuthTokens, callback: OAuthCallback) => Promise<OAuthProfile>;
  },
): OAuthMethod {
  if (!/^[a-z0-9_-]+$/.test(config.id)) throw new Error(`OAuth method id "${config.id}" must be lowercase letters, digits, - or _.`);
  if (RESERVED_IDS.has(config.id)) throw new Error(`"${config.id}" is reserved for the built-in ${config.id === "email" ? "emailCode()" : "password()"} method.`);
  if (!config.clientId) throw new Error(`Sign-in method "${config.id}" needs a clientId.`);
  if (config.tokenAuth !== undefined && config.tokenAuth !== "post" && config.tokenAuth !== "basic") {
    throw new Error(`Sign-in method "${config.id}": tokenAuth must be "post" or "basic".`);
  }
  return {
    kind: "oauth",
    id: config.id,
    name: config.name ?? config.id,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: config.scopes ?? [],
    scopeSeparator: config.scopeSeparator,
    authorizationParams: config.authorizationParams,
    tokenAuth: config.tokenAuth,
    pkce: config.pkce,
    endpoints: async () => ({ authorizationUrl: config.authorizationUrl, tokenUrl: config.tokenUrl }),
    profile: config.profile,
  };
}

/** Any OpenID Connect provider, configured from its discovery document. */
export function oidc(config: OAuthOptions & { issuer: string }): OAuthMethod {
  const issuer = config.issuer.replace(/\/+$/, "");
  let discovery: Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }> | null = null;
  const discover = () =>
    (discovery ??= fetch(`${issuer}/.well-known/openid-configuration`).then(async (res) => {
      if (!res.ok) {
        discovery = null;
        throw new Error(`OIDC discovery for ${issuer} returned ${res.status}.`);
      }
      return res.json() as any;
    }));
  const { issuer: _issuer, ...options } = config;
  const method = oauth({
    ...options,
    authorizationUrl: "",
    tokenUrl: "",
    scopes: config.scopes ?? ["openid", "email", "profile"],
    profile: async (tokens) => {
      const info = await getJson((await discover()).userinfo_endpoint, tokens.access_token);
      return { id: String(info.sub), email: info.email, emailVerified: info.email_verified === true, name: info.name, image: info.picture };
    },
  });
  method.endpoints = async () => {
    const d = await discover();
    return { authorizationUrl: d.authorization_endpoint, tokenUrl: d.token_endpoint };
  };
  return method;
}

/** Sign in with GitHub. Credentials default to $AUTH_GITHUB_ID and $AUTH_GITHUB_SECRET. */
export function github(options: Credentials = {}): OAuthMethod {
  const api = (path: string, token: string) => getJson(`https://api.github.com${path}`, token, { "User-Agent": "onebase", Accept: "application/vnd.github+json" });
  return oauth({
    id: "github",
    name: "GitHub",
    ...credentials("github", "AUTH_GITHUB", options),
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["read:user", "user:email"],
    profile: async ({ access_token }) => {
      const user = await api("/user", access_token);
      // The profile email may be missing or unverified; the emails API says which one is verified.
      const emails = ((await api("/user/emails", access_token).catch(() => [])) as { email: string; primary: boolean; verified: boolean }[]) ?? [];
      const primary = emails.find((e) => e.primary) ?? emails.find((e) => e.verified);
      return {
        id: String(user.id),
        email: primary?.email ?? user.email ?? undefined,
        emailVerified: primary?.verified ?? false,
        name: user.name ?? user.login,
        image: user.avatar_url,
      };
    },
  });
}

/** Sign in with Google. Credentials default to $AUTH_GOOGLE_ID and $AUTH_GOOGLE_SECRET. */
export function google(options: Credentials = {}): OAuthMethod {
  return oauth({
    id: "google",
    name: "Google",
    ...credentials("google", "AUTH_GOOGLE", options),
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "profile"],
    authorizationParams: { prompt: "select_account" },
    profile: async ({ access_token }) => {
      const info = await getJson("https://openidconnect.googleapis.com/v1/userinfo", access_token);
      return { id: String(info.sub), email: info.email, emailVerified: info.email_verified === true, name: info.name, image: info.picture };
    },
  });
}

/**
 * Sign in with Microsoft (personal, work and school accounts). Credentials default to
 * $AUTH_MICROSOFT_ID and $AUTH_MICROSOFT_SECRET; `tenant` to $AUTH_MICROSOFT_TENANT or "common"
 * (use your tenant id to allow only your organization). Microsoft doesn't say whether an email is
 * verified, so these sign-ins never join an existing account by email.
 */
export function microsoft(options: Credentials & { tenant?: string } = {}): OAuthMethod {
  const tenant = options.tenant ?? process.env.AUTH_MICROSOFT_TENANT ?? "common";
  if (!/^[A-Za-z0-9.-]+$/.test(tenant)) throw new Error(`microsoft({ tenant }) must be a tenant id, domain, "common", "organizations" or "consumers".`);
  return oauth({
    id: "microsoft",
    name: "Microsoft",
    ...credentials("microsoft", "AUTH_MICROSOFT", options),
    authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: ["openid", "email", "profile", "User.Read"],
    authorizationParams: { prompt: "select_account" },
    profile: async ({ access_token }) => {
      const info = await getJson("https://graph.microsoft.com/oidc/userinfo", access_token);
      return { id: String(info.sub), email: info.email, emailVerified: false, name: info.name };
    },
  });
}

/** Sign in with Discord. Credentials default to $AUTH_DISCORD_ID and $AUTH_DISCORD_SECRET. */
export function discord(options: Credentials = {}): OAuthMethod {
  return oauth({
    id: "discord",
    name: "Discord",
    ...credentials("discord", "AUTH_DISCORD", options),
    authorizationUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scopes: ["identify", "email"],
    profile: async ({ access_token }) => {
      const user = await getJson("https://discord.com/api/users/@me", access_token);
      return {
        id: String(user.id),
        email: user.email ?? undefined,
        emailVerified: user.verified === true,
        name: user.global_name ?? user.username,
        image: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : undefined,
      };
    },
  });
}

/**
 * Sign in with Facebook. Credentials default to $AUTH_FACEBOOK_ID and $AUTH_FACEBOOK_SECRET.
 * Facebook doesn't say whether the email is verified, so these sign-ins never join an existing account by email.
 */
export function facebook(options: Credentials = {}): OAuthMethod {
  return oauth({
    id: "facebook",
    name: "Facebook",
    ...credentials("facebook", "AUTH_FACEBOOK", options),
    authorizationUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scopes: ["email", "public_profile"],
    scopeSeparator: ",",
    profile: async ({ access_token }) => {
      const user = await getJson("https://graph.facebook.com/v21.0/me?fields=id,name,email,picture.type(large)", access_token);
      return { id: String(user.id), email: user.email ?? undefined, emailVerified: false, name: user.name, image: user.picture?.data?.url };
    },
  });
}

/** Sign in with X (Twitter). Credentials default to $AUTH_TWITTER_ID and $AUTH_TWITTER_SECRET. X doesn't share the email. */
export function twitter(options: Credentials = {}): OAuthMethod {
  return oauth({
    id: "twitter",
    name: "X",
    ...credentials("twitter", "AUTH_TWITTER", options),
    authorizationUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["users.read", "tweet.read"],
    tokenAuth: "basic",
    profile: async ({ access_token }) => {
      const { data } = await getJson("https://api.x.com/2/users/me?user.fields=profile_image_url", access_token);
      return { id: String(data.id), name: data.name ?? data.username, image: data.profile_image_url };
    },
  });
}

/** Sign in with GitLab, gitlab.com or your own (`issuer`, or $AUTH_GITLAB_ISSUER). Credentials default to $AUTH_GITLAB_ID and $AUTH_GITLAB_SECRET. */
export function gitlab(options: Credentials & { issuer?: string } = {}): OAuthMethod {
  return oidc({ id: "gitlab", name: "GitLab", issuer: options.issuer ?? process.env.AUTH_GITLAB_ISSUER ?? "https://gitlab.com", ...credentials("gitlab", "AUTH_GITLAB", options) });
}

/** Sign in with LinkedIn. Credentials default to $AUTH_LINKEDIN_ID and $AUTH_LINKEDIN_SECRET. */
export function linkedin(options: Credentials = {}): OAuthMethod {
  return oidc({ id: "linkedin", name: "LinkedIn", issuer: "https://www.linkedin.com/oauth", pkce: false, ...credentials("linkedin", "AUTH_LINKEDIN", options) });
}

/** Sign in with Slack. Credentials default to $AUTH_SLACK_ID and $AUTH_SLACK_SECRET. */
export function slack(options: Credentials = {}): OAuthMethod {
  return oidc({ id: "slack", name: "Slack", issuer: "https://slack.com", pkce: false, ...credentials("slack", "AUTH_SLACK", options) });
}

const APPLE_ISSUER = "https://appleid.apple.com";
const sha256Hex = async (text: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");
const b64url = (data: string | Uint8Array | ArrayBuffer) =>
  (typeof data === "string" ? Buffer.from(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)).toString("base64url");

type AppleWeb = {
  /** The Services ID you registered for the website, e.g. com.example.web. */
  servicesId?: string;
  teamId?: string;
  /** The id of the Sign in with Apple key (.p8) in your developer account. */
  keyId?: string;
  /** The .p8 key's contents (PEM). "\n" written as two characters is accepted, as env files often hold it. */
  privateKey?: string;
};

/** Apple's client secret is a JWT signed with your key, good for up to six months; we make a fresh one every hour. */
function appleClientSecret(web: Required<AppleWeb>, audience: string): () => Promise<string> {
  let key: Promise<CryptoKey> | null = null;
  let cached: { value: string; until: number } | null = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.until > now) return cached.value;
    key ??= (async () => {
      const pem = web.privateKey.replace(/\\n/g, "\n");
      const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
      return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    })().catch((err) => {
      key = null;
      throw new Error(`apple(): the private key isn't a valid .p8 (PKCS#8 P-256) key: ${err instanceof Error ? err.message : err}`);
    });
    const iat = Math.floor(now / 1000);
    const input = `${b64url(JSON.stringify({ alg: "ES256", kid: web.keyId }))}.${b64url(JSON.stringify({ iss: web.teamId, iat, exp: iat + 3600, aud: audience, sub: web.servicesId }))}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await key, new TextEncoder().encode(input));
    cached = { value: `${input}.${b64url(signature)}`, until: now + 50 * 60_000 };
    return cached.value;
  };
}

/**
 * Sign in with Apple.
 *
 * On iPhone, iPad and Mac the app uses Apple's sign-in sheet and sends the `identityToken` it got
 * and the random `nonce` it started with:
 *
 *     signIn("apple", { idToken, nonce, name })
 *
 * Start the request with `nonce: sha256(rawNonce)` (hex) so the token is tied to this sign-in, and
 * send `rawNonce`. onebase checks Apple's signature, that the token was issued for one of
 * `clientId` (your app's bundle id), that it hasn't expired, that it matches the nonce, and that
 * it hasn't been used before. `name` is only used for a new account: Apple sends the name to the
 * app once, never in the token. `clientId` defaults to $AUTH_APPLE_ID (comma-separated for several apps).
 *
 * On the web, `signIn("apple")` with no idToken redirects to Apple, like GitHub or Google. It needs
 * `web: { servicesId, teamId, keyId, privateKey }`, or $AUTH_APPLE_SERVICES_ID, $AUTH_APPLE_TEAM_ID,
 * $AUTH_APPLE_KEY_ID and $AUTH_APPLE_PRIVATE_KEY. Register `<your --url>/api/auth/callback/apple`
 * as the Services ID's return URL; Apple only allows https URLs on a real domain. Both ways sign in
 * to the same account.
 */
export function apple(
  options: {
    clientId?: string | string[];
    web?: AppleWeb;
    profile?: NewUserProfile;
    /** Where Apple's public keys are, and who signs the tokens. Only for tests or a proxy. */
    jwksUrl?: string;
    issuer?: string;
  } = {},
): IdTokenMethod {
  const given = options.clientId ?? process.env.AUTH_APPLE_ID;
  const bundleIds = (Array.isArray(given) ? given : (given ?? "").split(",")).map((a) => a.trim()).filter(Boolean);
  const web = {
    servicesId: options.web?.servicesId ?? process.env.AUTH_APPLE_SERVICES_ID,
    teamId: options.web?.teamId ?? process.env.AUTH_APPLE_TEAM_ID,
    keyId: options.web?.keyId ?? process.env.AUTH_APPLE_KEY_ID,
    privateKey: options.web?.privateKey ?? process.env.AUTH_APPLE_PRIVATE_KEY,
  };
  const webOn = Boolean(options.web || web.servicesId);
  if (webOn && (!web.servicesId || !web.teamId || !web.keyId || !web.privateKey)) {
    const missing = (["servicesId", "teamId", "keyId", "privateKey"] as const).filter((k) => !web[k]);
    throw new Error(`Sign in with Apple on the web needs ${missing.join(", ")}: pass apple({ web: { ... } }) or set the AUTH_APPLE_* variables.`);
  }
  // Tokens from Apple's web sign-in (and its JS popup) are issued for the Services ID.
  const audiences = [...bundleIds, ...(webOn ? [web.servicesId!] : [])];
  if (!audiences.length) {
    throw new Error('Sign-in method "apple" needs your app\'s bundle id: pass { clientId } or set AUTH_APPLE_ID (or set up web sign-in).');
  }
  const issuer = options.issuer ?? APPLE_ISSUER;
  const verifier = new JwtVerifier([{ type: "customJwt", issuer, jwks: options.jwksUrl ?? `${APPLE_ISSUER}/auth/keys`, algorithm: "RS256" }]);

  /** Checks an Apple ID token and reads who it's for. */
  const readToken = async (idToken: string, allowed: string[]) => {
    await verifier.verify(idToken); // signature, issuer and expiry
    const { claims } = decodeJwt(idToken);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => typeof a === "string" && allowed.includes(a))) throw new Error("This Apple sign-in was issued for a different app.");
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("Apple didn't send an account id.");
    return {
      claims,
      profile: {
        id: claims.sub,
        email: typeof claims.email === "string" ? claims.email : undefined,
        emailVerified: claims.email_verified === true || claims.email_verified === "true",
      },
    };
  };
  const cleanName = (name: unknown) => (typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : undefined);

  const method: IdTokenMethod = {
    kind: "idToken",
    id: "apple",
    name: "Apple",
    profile: options.profile,
    async verify(params) {
      const idToken = params.idToken;
      const nonce = params.nonce;
      if (typeof idToken !== "string" || !idToken) throw new Error("Apple sign-in needs the identityToken from Apple as idToken.");
      if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 256) {
        throw new Error("Apple sign-in needs the random nonce it started with (at least 16 characters).");
      }
      const { claims, profile } = await readToken(idToken, audiences);
      // Apple echoes the nonce the app gave it: normally sha256(rawNonce) in hex, or the raw nonce itself.
      const echoed = typeof claims.nonce === "string" ? claims.nonce : "";
      if (!echoed || (echoed !== (await sha256Hex(nonce)) && echoed !== nonce)) throw new Error("This Apple sign-in doesn't match the one that was started.");
      const exp = typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 10 * 60_000;
      return { ...profile, name: cleanName(params.name), once: { key: `apple|${claims.sub}|${echoed}|${exp}`, until: exp + 5 * 60_000 } };
    },
  };
  if (webOn) {
    method.web = oauth({
      id: "apple",
      name: "Apple",
      clientId: web.servicesId!,
      clientSecret: appleClientSecret(web as Required<AppleWeb>, APPLE_ISSUER),
      authorizationUrl: `${issuer}/auth/authorize`,
      tokenUrl: `${issuer}/auth/token`,
      scopes: ["name", "email"],
      // Apple posts the result back when the name or email is asked for, and doesn't take PKCE (state still ties the callback to the sign-in).
      authorizationParams: { response_mode: "form_post" },
      pkce: false,
      profile: async (tokens, { params }) => {
        if (typeof tokens.id_token !== "string") throw new Error("Apple didn't send an id_token.");
        const { profile } = await readToken(tokens.id_token, [web.servicesId!]);
        // The name comes once, on the first sign-in, as a `user` field next to the code.
        let name: string | undefined;
        try {
          const user = params.user ? JSON.parse(params.user) : null;
          name = cleanName([user?.name?.firstName, user?.name?.lastName].filter((p) => typeof p === "string").join(" "));
        } catch {}
        return { ...profile, name };
      },
    });
  }
  return method;
}

/**
 * Passwordless email sign-in: `signIn("email", { flow: "start", email })` emails a one-time code,
 * then `signIn("email", { flow: "verify", email, code, name })` signs in, creating the account the
 * first time. The address counts as verified, so it also signs the person into an existing
 * account that has the same verified email. Codes are 8 digits (or 6 with `codeLength: 6`), last
 * 15 minutes and work once; wrong guesses and requests are rate limited.
 */
export function emailCode(options: { sendCode: SendCode<"signin">; codeLength?: 6 | 8; profile?: NewUserProfile }): EmailCodeMethod {
  if (typeof options.sendCode !== "function") throw new Error("emailCode() needs a sendCode function to email the codes.");
  const codeLength = options.codeLength ?? 8;
  if (codeLength !== 6 && codeLength !== 8) throw new Error("emailCode({ codeLength }) must be 6 or 8.");
  return { kind: "emailCode", id: "email", codeLength, sendCode: options.sendCode, profile: options.profile };
}
