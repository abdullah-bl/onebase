---
title: Swift client
description: Use onebase from iOS and macOS apps, with offline support and optimistic updates.
---

# Swift client

`OnebaseClient` is the onebase SDK for Swift apps (iOS 15+ / macOS 12+, no package
dependencies): one WebSocket carries live queries, calls and the auth token. It lives in
[`clients/swift`](https://github.com/abdullah-bl/onebase/tree/main/clients/swift) in the
repository.

```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/abdullah-bl/onebase.git", branch: "main"),
]
// target: .product(name: "OnebaseClient", package: "onebase")
```

## Connect and use

```swift
import OnebaseClient

let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
let client = OnebaseClient(url: "https://api.example.com", offlineDirectory: documents)

client.onConnectionChange = { state in } // .connecting / .open / .closed

// Live queries: onUpdate runs with every new result, on the main queue.
var subscription: OnebaseSubscription?
subscription = client.subscribe("notes:list", [:]) { value in
    let notes = value?.array ?? []
    // render them
}
subscription?.cancel() // when the view goes away

let id = try await client.mutation("notes:add", ["text": "Hello"])
let best = try await client.query("notes:best", [:])
try await client.action("emails:sendWelcome", ["to": "someone@example.com"])
```

Values are [`OnebaseValue`](#onebasevalue): a JSON value. Build arguments from literals
(`["text": "Hello", "count": 3]`) or from your own `Codable` types (`try OnebaseValue(note)`);
read results with `value?.array`, `value?["user", "name"]?.string`, `value?.int`, and so on.

## Optimistic updates

```swift
try await client.mutation("notes:add", ["text": "Hello"]) { store in
    let current = store.get("notes:list")?.array ?? []
    store.set("notes:list", [:], .array(current + [["text": "Hello"]]))
}
```

The closure sees the subscribed queries' current results and overrides them until the mutation
finishes; the server's real results then take over (the server sends a mutation's result and
its query updates together, so there's no flicker). Setting a query to `nil` shows it as
loading. Keep it a pure function of `store` — it may run again on top of results that arrive
while the mutation is in flight.

## Auth

Built-in password sign-in goes over HTTP; the token is kept in the Keychain and sent on every
(re)connect:

```swift
client.onAuthChange = { signedIn in } // false when the token stops checking out
let token = try await client.signInPassword(email: "someone@example.com", password: "correct horse")
let codeFlowToken = try await client.signInPassword(email: "…", password: "…", flow: "signUp") // nil: a code was emailed
try await client.signOut()
```

Any other token (an external provider's) works with `client.setToken("…")`. Pass your own
`OnebaseTokenStore` to store it somewhere else.

## Offline

With an `offlineDirectory` (recommended), the client keeps working through drops in
connectivity and cold starts while offline:

- the newest 100 query results (`OfflineStore(directory:maxCachedQueries:)`) are cached on
  disk and shown while disconnected, then replaced by live data;
- mutations made while disconnected are queued on disk and sent, in order, once the connection
  returns — across app restarts;
- `client.queuedMutationCount` and `client.clearQueuedMutations()` manage the queue;
  failures of mutations queued by an earlier run surface through `onQueuedMutationFailure`;
- each queued mutation is sent at most once per run — one lost with the connection is dropped,
  never silently re-sent;
- cached results are held back until the server confirms the same user is asking, and cleared
  when the user changes.

See [Offline](./client.md#offline) for the behavior all clients share, and
[Client protocol](./client-protocol.md) for the wire contract.

## OnebaseValue

```swift
public enum OnebaseValue {
    case null, bool(Bool), int(Int64), double(Double), string(String)
    case array([OnebaseValue]), object([String: OnebaseValue])
}
```

Read it with `value?.string`, `.int`, `.double`, `.bool`, `.array`, `.object` and
`value?["user", "name"]`; whole numbers arrive as `.int`, and it's `Codable`, `Equatable` and
literal-expressible (`let v: OnebaseValue = ["count": 3]`).
