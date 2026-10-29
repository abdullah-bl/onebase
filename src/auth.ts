// Built-in sign-in methods for auth.config.ts (imported as "onebase/auth").
// These only describe a method; the engine (src/engine/auth.ts) runs the flows.

import type { FunctionLike } from "./api";

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
export type SendCode = (message: { email: string; code: string; purpose: "verify" | "reset" }, ctx: SendCodeCtx) => Promise<void> | void;

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

export type OAuthMethod = {
  kind: "oauth";
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Extra query parameters for the authorization URL. */
  authorizationParams?: Record<string, string>;
  endpoints(): Promise<OAuthEndpoints>;
  profile(tokens: OAuthTokens): Promise<OAuthProfile>;
};

export type AuthMethod = PasswordMethod | OAuthMethod;

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

/**
 * Any OAuth 2.0 provider: give its endpoints and how to read the user's profile.
 * The callback URL to register with the provider is `<your --url>/api/auth/callback/<id>`.
 */
export function oauth(config: {
  id: string;
  name?: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes?: string[];
  authorizationParams?: Record<string, string>;
  /** Reads the profile, usually from a user info endpoint, with the access token. */
  profile: (tokens: OAuthTokens) => Promise<OAuthProfile>;
}): OAuthMethod {
  if (!/^[a-z0-9_-]+$/.test(config.id)) throw new Error(`OAuth method id "${config.id}" must be lowercase letters, digits, - or _.`);
  if (config.id === "password") throw new Error(`"password" is reserved for the password() method.`);
  return {
    kind: "oauth",
    id: config.id,
    name: config.name ?? config.id,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: config.scopes ?? [],
    authorizationParams: config.authorizationParams,
    endpoints: async () => ({ authorizationUrl: config.authorizationUrl, tokenUrl: config.tokenUrl }),
    profile: config.profile,
  };
}

/** Any OpenID Connect provider, configured from its discovery document. */
export function oidc(config: { id: string; name?: string; issuer: string; clientId: string; clientSecret: string; scopes?: string[] }): OAuthMethod {
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
  const method = oauth({
    id: config.id,
    name: config.name,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
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
