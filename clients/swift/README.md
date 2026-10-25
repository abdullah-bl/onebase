# onebase for Swift

The Swift client for [onebase](https://github.com/abdullah-bl/onebase): live queries, mutations
and actions, built-in auth, optimistic updates, and offline support — one WebSocket, no
dependencies beyond the system frameworks. iOS 15+ / macOS 12+.

```swift
let package = Package(
    dependencies: [
        .package(url: "https://github.com/abdullah-bl/onebase-swift.git", from: "0.1.0"),
    ],
    targets: [
        .target(name: "MyApp", dependencies: [
            .product(name: "OnebaseClient", package: "onebase-swift"),
        ]),
    ]
)
```

This folder is developed in the [onebase](https://github.com/abdullah-bl/onebase) repository and
published to `onebase-swift` on every release (SwiftPM needs a package at the root of a
repository). From a clone of onebase, or before the first release, depend on the folder instead:
`.package(path: "../onebase/clients/swift")`, with `package: "swift"` in the product.

## Use

```swift
import OnebaseClient

// Where offline data (cached results, queued mutations) lives; omit to stay in memory only.
let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
let client = OnebaseClient(url: "https://api.example.com", offlineDirectory: documents)
client.onConnectionChange = { state in /* .connecting / .open / .closed */ }

// Live queries: the closure runs with every new result (on the main queue).
var notes: OnebaseSubscription!
notes = client.subscribe("notes:list", [:]) { value in
    // value is a OnebaseValue: read it with value?.array, ["key"], .string, .int, …
}
// notes.cancel() when the screen goes away.

// Mutations, with an optimistic update for the subscribed queries:
let note = try await client.mutation("notes:add", ["text": "hello"]) { store in
    let current = store.get("notes:list")?.array ?? []
    store.set("notes:list", [:], .array(current + [["text": "hello"]]))
}

// One-shot calls:
let best = try await client.query("notes:best", [:])
try await client.action("emails:sendWelcome", ["to": "someone@example.com"])

// Built-in auth (token kept in the Keychain):
client.onAuthChange = { signedIn in /* update the UI */ }
let token = try await client.signInPassword(email: "someone@example.com", password: "correct horse")
try await client.signOut()
// Or bring your own token: client.setToken("…") — also sent on every reconnect.
```

## Offline

With an `offlineDirectory`:

- the newest 100 query results (configurable) are cached on disk, and a fresh run shows them
  while disconnected — live data replaces them when it arrives;
- mutations made while disconnected are queued on disk and sent, in the order they were made,
  once the connection returns — across app restarts too;
- `queuedMutationCount` and `clearQueuedMutations()` manage the queue; failures of mutations
  queued by an earlier run surface through `onQueuedMutationFailure`.

Each queued mutation is sent at most once per run: one lost with the connection is dropped
(never silently re-sent), like any other sent-but-unanswered call.

Cached results belong to the signed-in user: they're held back until the server confirms the
same user is asking, and cleared when the user changes.

## Tests

`swift test` runs unit tests plus integration tests against a WebSocket server that speaks the
real `/api/sync` protocol. See `docs/client-protocol.md` in the repository for the wire
contract, and `docs/swift.md` for the full guide.
