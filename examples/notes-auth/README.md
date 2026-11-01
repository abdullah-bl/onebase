# notes-auth — private notes with built-in sign-in

A small notes app where every note belongs to the person who wrote it. Sign in with an email and password — onebase stores the accounts in its own database, no external service or env vars needed.

## Run it

```bash
cd examples/notes-auth
bun ../../src/cli.ts dev
```

Open the printed URL (http://localhost:8090), sign up with any email and a password, and write notes. Sign up with a different email in a private window to see that notes never leak across users.

## What it shows

- **`onebase/auth.config.ts`** — enabling built-in sign-in with `password()` from `onebase/auth`.
- **`authTables`** — the `users` table sign-in needs, spread into the schema.
- **`getAuthUserId(ctx)`** — the signed-in user's id (or `null`) inside queries and mutations; the `requireUserId` helper in `onebase/notes.ts` turns it into "sign in first".
- **Per-user data** — an index on `owner` keeps every read scoped to one user; mutations check `note.owner` before editing.
- **User-scoped full-text search** — a `searchIndex` with `filterFields: ["owner"]`, so `q.search("body", text).eq("owner", userId)` searches only your notes.
- **Pagination** — `paginate(paginationOpts)` with `paginationOptsValidator`; the frontend grows `numItems` for "Load more", so the page stays live.
- **The client auth surface** — `client.signIn("password", { flow, email, password })`, `client.onAuthChange`, `client.signOut()` in plain JavaScript, with the session kept in `localStorage` across reloads.

## Files

```
onebase/
  schema.ts        users (from authTables) + notes with by_owner index and search index
  auth.config.ts   the password() sign-in method
  notes.ts         me, page, search, add, edit, remove
public/index.html  sign-in form + notes UI, no build step
```
