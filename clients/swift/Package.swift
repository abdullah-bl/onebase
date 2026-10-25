// swift-tools-version:5.9
// The onebase client for Swift: live queries, mutations, auth, optimistic updates and
// offline support (a cached query store and a queued mutation outbox) over /api/sync.

import PackageDescription

let package = Package(
    name: "OnebaseClient",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "OnebaseClient", targets: ["OnebaseClient"]),
    ],
    targets: [
        .target(name: "OnebaseClient"),
        .testTarget(name: "OnebaseClientTests", dependencies: ["OnebaseClient"]),
    ],
    swiftLanguageVersions: [.v5]
)
