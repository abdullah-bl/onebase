---
title: Auth
description: Verify users with Clerk, Auth0, WorkOS, any OIDC provider, or your own tokens.
---

# Auth

onebase doesn't store passwords or run a login flow. Your auth provider signs users in and issues a token. onebase verifies the token and gives your functions the user's identity.

## Configure providers

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

## Send the token

```ts
client.setAuth(async () => await clerk.session?.getToken({ template: "onebase" }));
```

Queries, mutations and subscriptions started while the token is being fetched wait for it, so they never run as a signed-out user by accident.

Over HTTP, send `Authorization: Bearer <token>`.

## Use the identity

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

For API keys, session tokens from your own system, or anything else, add an `authenticate` function. It's used for every token that doesn't come from a configured provider:

```ts
export default {
  providers: [{ domain: "https://your-app.clerk.accounts.dev" }],
  authenticate: async (token: string) => {
    const key = await lookUpApiKey(token); // your code
    return key ? { subject: key.ownerId, tokenIdentifier: `apikey|${key.id}` } : null;
  },
};
```

Return `null` to treat the caller as signed out.
