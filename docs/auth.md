---
title: Auth
description: Built-in sign-in with passwords and OAuth, sessions, external providers like Clerk and Auth0, and your own tokens.
---

# Auth

There are three ways to know who's calling, and you can combine them:

- **Built-in sign-in:** email and password, plus OAuth (GitHub, Google, any OpenID Connect or OAuth 2.0 provider). onebase stores the users and runs the sessions.
- **External providers:** Clerk, Auth0, WorkOS or any OIDC issuer signs people in; onebase verifies their tokens.
- **Your own tokens:** API keys or anything else, checked by an `authenticate(token, ctx)` function that can read the database.

## Built-in sign-in

### Set up

Add the users table to your schema. `authTables` has the fields sign-in uses:

```ts
// onebase/schema.ts
import { authTables, defineSchema, defineTable } from "onebase/server";

export default defineSchema({
  ...authTables,
  notes: defineTable({ owner: v.id("users"), text: v.string() }).index("by_owner", ["owner"]),
});
```

Then list the sign-in methods:

```ts
// onebase/auth.config.ts
import { github, google, password } from "onebase/auth";

export default {
  methods: [password(), github(), google()],
};
```

`github()` reads its credentials from `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET`, and `google()` from `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`. You can also pass `{ clientId, clientSecret }`.

### Sign in from the client

```tsx
import { useState } from "react";
import { Authenticated, Unauthenticated, useAuthActions } from "onebase/react";

function SignIn() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        signIn("password", { flow, email: form.get("email"), password: form.get("password") }).catch((err) => setError(err.message));
      }}
    >
      <input name="email" type="email" placeholder="Email" />
      <input name="password" type="password" placeholder="Password" />
      <button type="submit">{flow === "signIn" ? "Sign in" : "Sign up"}</button>
      <button type="button" onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}>
        {flow === "signIn" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>
      <button type="button" onClick={() => void signIn("github")}>Sign in with GitHub</button>
      {error && <p>{error}</p>}
    </form>
  );
}

function App() {
  return (
    <>
      <Authenticated><Notes /></Authenticated>
      <Unauthenticated><SignIn /></Unauthenticated>
    </>
  );
}
```

| | |
|---|---|
| `signIn("password", { flow: "signUp", email, password, name? })` | creates the account and signs in |
| `signIn("password", { flow: "signIn", email, password })` | signs in; rejects with "Invalid email or password." |
| `signIn("github")` | goes to GitHub and back to this page (or `{ redirectTo }`), then finishes signing in |
| `signIn("password", { flow: "reset", email })` | emails a code to choose a new password (see [below](#password-reset-and-email-verification)) |
| `signOut()` | ends the session |
| `useOnebaseAuth()` | `{ isLoading, isAuthenticated, error }` (also exported as `useConvexAuth`) |
| `<Authenticated>`, `<Unauthenticated>`, `<AuthLoading>` | render their children only in that state |

Without React, the same methods are on the client: `client.signIn(...)`, `client.signOut()`, `client.authState` and `client.onAuthChange(listener)`.

The session token is kept in `localStorage`, so a reload stays signed in. To keep it somewhere else, pass `new OnebaseClient(url, { authStorage })` with any object that has `getItem`, `setItem` and `removeItem`, or `null` to keep it in memory.

`signIn` resolves `{ signingIn: true }` once signed in, and `{ signingIn: false }` when the next step happens elsewhere: an emailed code to enter, or an OAuth provider's page.

### Password reset and email verification

Give `password()` a `sendCode` function that emails a one-time code, using any email API:

```ts
// onebase/auth.config.ts
import { password } from "onebase/auth";

export default {
  methods: [
    password({
      verifyEmail: true, // optional: new accounts confirm their email before they can sign in
      sendCode: async ({ email, code, purpose }) => {
        const subject = purpose === "reset" ? "Reset your password" : "Confirm your email";
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "My App <no-reply@example.com>", to: email, subject, text: `Your code is ${code}. It expires in 15 minutes.` }),
        });
        if (!res.ok) throw new Error(`Resend returned ${res.status}`);
      },
    }),
  ],
};
```

`sendCode` runs on the server. Its second argument has `runQuery`, `runMutation` and `runAction`, so it can also call an internal action that sends the email: `sendCode: (message, ctx) => ctx.runAction(internal.emails.sendCode, message)`.

**Resetting a password** takes two calls:

```ts
await signIn("password", { flow: "reset", email }); // emails a code
await signIn("password", { flow: "reset-verification", email, code, newPassword }); // signs in
```

A reset ends every other session of that user, and marks the email as verified (they read the code in that inbox).

**With `verifyEmail: true`,** signing up (and signing in to an account that hasn't confirmed yet) emails a code and resolves `{ signingIn: false }`. The user is signed in once they enter it:

```ts
const { signingIn } = await signIn("password", { flow: "signUp", email, password });
if (!signingIn) showCodeInput(); // then:
await signIn("password", { flow: "email-verification", email, code });
```

Confirmed emails are stored in `users.emailVerificationTime`, which also lets an OAuth sign-in with the same verified email join that user.

| | |
|---|---|
| Codes | 8 digits, valid for 15 minutes, work once; a new code replaces the previous one |
| Wrong codes | 10 per email per hour, then that email is blocked for the rest of the hour |
| Codes sent | 5 per email per hour, so nobody can flood an inbox |
| Unknown emails | a reset request answers `{ codeSent: true }` either way, so it doesn't reveal which emails have accounts |

### Use the user in functions

```ts
import { getAuthUserId } from "onebase/server";

export const myNotes = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx); // Id<"users"> | null
    if (!userId) return [];
    return await ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("owner", userId)).collect();
  },
});
```

`ctx.auth.getUserIdentity()` works too. Its `subject` is the user's id, and it has `email`, `name` and `pictureUrl` from the user document.

Users are ordinary documents, so you can read them, add fields and show them in the dashboard. To add your own fields, define `users` yourself instead of spreading `authTables`. Keep `name`, `email`, `image` and `emailVerificationTime`, and make new fields optional or fill them at sign-up with `password({ profile: (params) => ({ email: params.email, plan: "free" }) })`. The server checks at startup that the users table accepts new users.

### OAuth

1. Register an OAuth app with the provider. Its callback URL is `<your public URL>/api/auth/callback/<method>`, e.g. `https://api.example.com/api/auth/callback/github`.
2. Start the server with that public URL: `--url https://api.example.com` (or `$ONEBASE_URL`).
3. If your frontend runs on another origin, allow it as a place to return to: list it in `--cors` or in `redirects`:

```ts
export default {
  methods: [password(), github()],
  redirects: ["https://app.example.com"], // origins, or URL prefixes like "https://example.com/app/"
};
```

In dev mode, `localhost` is always allowed. Other providers:

```ts
import { oauth, oidc } from "onebase/auth";

oidc({ id: "okta", issuer: "https://dev-123.okta.com", clientId, clientSecret }),
oauth({
  id: "discord",
  clientId,
  clientSecret,
  authorizationUrl: "https://discord.com/oauth2/authorize",
  tokenUrl: "https://discord.com/api/oauth2/token",
  scopes: ["identify", "email"],
  profile: async ({ access_token }) => {
    const me = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${access_token}` } }).then((r) => r.json());
    return { id: me.id, email: me.email, emailVerified: me.verified, name: me.global_name, image: undefined };
  },
}),
```

**Linking accounts:** an OAuth sign-in with a new account joins an existing user only when both the provider and that user have verified the email address. Otherwise it creates a new user. This stops someone from signing up with another person's email and later sharing their account.

### Sessions and security

- **Sessions** last 30 days from their last use (`sessionDays` in `auth.config.ts`). Signing out ends the session at once, including for open WebSocket connections on every server instance. `POST /api/auth/signout` with `{ "everywhere": true }` ends all of a user's sessions.
- **Passwords** are hashed with argon2id and must be at least 8 characters (`password({ minLength })`). After 10 failed attempts for an email in an hour, sign-in for that email is blocked for the rest of the hour. `--rate-limit` also applies to sign-in requests.
- **Tokens and codes** are stored only as SHA-256 hashes. OAuth uses PKCE, and the one-time code the provider's redirect brings back only works with a verifier kept by the browser that started the sign-in.
- **Stored separately:** password hashes, OAuth links, sessions and email codes are in system tables that functions and the dashboard can't read.

### HTTP API

For clients other than the JS one:

| Endpoint | |
|---|---|
| `POST /api/auth/signin` `{ provider: "password", params: { flow, email, password } }` | `{ token, userId }`, or `{ codeSent: true }` when a code was emailed |
| `POST /api/auth/signin` `{ provider: "password", params: { flow: "reset", email } }` | `{ codeSent: true }`; then `flow: "reset-verification"` with `email, code, newPassword` |
| `POST /api/auth/signin` `{ provider: "github", redirectTo, challenge }` | `{ redirect }`: send the browser there. `challenge` is the SHA-256 (base64url) of a random verifier you keep |
| `POST /api/auth/signin` `{ code, verifier }` | `{ token, userId }`, for the `onebase_code` the browser comes back with |
| `POST /api/auth/signout` with `Authorization: Bearer <token>` | `{ ok: true }` |
| `GET /api/auth/methods` | the enabled methods, for building a sign-in page |

Then send `Authorization: Bearer <token>` with requests, or `{ type: "auth", token }` over the WebSocket.

## External providers

Create `onebase/auth.config.ts`. The provider format is the same as Convex:

```ts
export default {
  providers: [
    // Clerk, Auth0, WorkOS, Google… any OIDC issuer
    { domain: "https://your-app.clerk.accounts.dev", applicationID: "onebase" },

    // An issuer without OIDC discovery: point at its JWKS
    { type: "customJwt", issuer: "https://auth.example.com", jwks: "https://auth.example.com/.well-known/jwks.json", algorithm: "RS256" },
  ],
};
```

- **`domain`** is the token's issuer (`iss`). Keys are fetched from `<domain>/.well-known/openid-configuration`, cached, and refetched when the provider rotates them.
- **`applicationID`**, if set, must appear in the token's audience (`aud`). In Clerk, create a JWT template with that name. In Auth0, set it as the API audience.
- **Algorithms:** RS256/384/512, PS256, ES256/384 and EdDSA are supported, all verified with WebCrypto.

### Send the token

```ts
client.setAuth(async () => await clerk.session?.getToken({ template: "onebase" }));
```

Queries, mutations and subscriptions started while the token is being fetched wait for it, so they never run as a signed-out user by accident.

Over HTTP, send `Authorization: Bearer <token>`.

### Use the identity

```ts
export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null; // not signed in
    return await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
  },
});
```

The identity has:
- `subject`: the user id at the provider.
- `issuer`.
- `tokenIdentifier`: `issuer|subject`, unique across providers.
- The standard claims, in camelCase: `email`, `name`, `givenName`, `pictureUrl`, `emailVerified`, …
- Any custom claims, unchanged.

Tokens are checked for expiry (with 60 seconds of leeway) and audience. When a token is rejected, the reason is clear, e.g. *"Auth token expired at …"* or *"audience … doesn't include applicationID"*.

## Custom tokens

For API keys, tokens from your own system, or anything else, add an `authenticate` function. It's used for every token that isn't a built-in session or from a configured provider. Its `ctx.db` reads the database:

```ts
export default {
  methods: [password()],
  authenticate: async (token, ctx) => {
    const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex"); // store keys hashed
    const key = await ctx.db.query("apiKeys").withIndex("by_hash", (q) => q.eq("hash", hash)).unique();
    return key ? { subject: key.owner, tokenIdentifier: `apikey|${key._id}` } : null;
  },
};
```

Return `null` to treat the caller as signed out. Each `ctx.db` read runs on its own snapshot, so nothing is held open while `authenticate` waits on other work.
