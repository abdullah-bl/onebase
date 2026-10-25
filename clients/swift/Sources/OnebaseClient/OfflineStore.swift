import Foundation

/// A mutation made while disconnected, persisted until the server answers it.
public struct QueuedMutation: Codable, Equatable {
    /// A UUID string identifying this entry in the store.
    public let id: String
    public let path: String
    public let args: OnebaseValue
}

/// The persisted half of offline support: the newest query results (so a cold start can show
/// them while disconnected) and mutations queued while disconnected (sent in order once the
/// connection returns). All methods are thread-safe; files live in `directory`.
public final class OfflineStore {
    struct CachedResult: Codable {
        let value: OnebaseValue
        let at: Double
    }

    struct CacheFile: Codable {
        var subject: String?
        var entries: [String: CachedResult] = [:]
    }

    private let directory: URL
    private let maxCached: Int
    private let queue = DispatchQueue(label: "onebase.offline-store")
    private var cache = CacheFile(subject: nil, entries: [:])
    private var outbox: [QueuedMutation] = []
    private var flushScheduled = false

    /// Loads (creating if needed) the store in `directory`. Pass the same directory to keep
    /// state across runs. `maxCachedQueries` bounds the cache (default 100).
    public init(directory: URL, maxCachedQueries: Int = 100) {
        self.directory = directory
        self.maxCached = maxCachedQueries
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        queue.sync {
            if let data = try? Data(contentsOf: Self.cacheURL(directory)),
               let file = try? JSONDecoder().decode(CacheFile.self, from: data) {
                cache = file
            }
            if let data = try? Data(contentsOf: Self.outboxURL(directory)),
               let entries = try? JSONDecoder().decode([QueuedMutation].self, from: data) {
                outbox = entries
            }
        }
    }

    private static func cacheURL(_ directory: URL) -> URL { directory.appendingPathComponent("query-cache.json") }
    private static func outboxURL(_ directory: URL) -> URL { directory.appendingPathComponent("mutation-outbox.json") }

    // ---- Query cache ----

    /// The newest cached result for a subscription key, if any.
    public func cachedValue(_ key: String) -> OnebaseValue? {
        queue.sync { cache.entries[key]?.value }
    }

    /// The subject (auth identity) the cached results belong to, if known.
    public var cacheSubject: String? {
        queue.sync { cache.subject }
    }

    /// Records a result; written to disk (debounced) with only the newest `maxCachedQueries` kept.
    public func storeResult(_ key: String, _ value: OnebaseValue) {
        queue.async {
            self.cache.entries[key] = CachedResult(value: value, at: Date().timeIntervalSince1970)
            self.scheduleFlushLocked()
        }
    }

    /// Cached results belong to whoever is signed in; a different subject starts empty.
    public func setSubject(_ subject: String?) {
        queue.async {
            guard self.cache.subject != subject else { return }
            self.cache.subject = subject
            self.cache.entries = [:]
            self.flushLocked()
        }
    }

    /// Writes any unsaved state now (also called by the client on close).
    public func flush() {
        queue.async { self.flushLocked() }
    }

    private func scheduleFlushLocked() {
        guard !flushScheduled else { return }
        flushScheduled = true
        queue.asyncAfter(deadline: .now() + 0.3) {
            self.flushScheduled = false
            self.flushLocked()
        }
    }

    private func flushLocked() {
        let newest = cache.entries.sorted { $0.value.at > $1.value.at }.prefix(maxCached)
        cache.entries = Dictionary(uniqueKeysWithValues: newest.map { ($0.key, $0.value) })
        writeLocked(Self.cacheURL(directory), cache)
        writeLocked(Self.outboxURL(directory), outbox)
    }

    private func writeLocked(_ url: URL, _ value: some Encodable) {
        if let data = try? JSONEncoder().encode(value) {
            try? data.write(to: url, options: .atomic)
        }
    }

    // ---- Mutation outbox ----

    /// Queues a mutation (persisted immediately) and returns its id.
    public func enqueueMutation(_ path: String, _ args: [String: OnebaseValue]) -> String {
        let entry = QueuedMutation(id: UUID().uuidString, path: path, args: .object(args))
        queue.sync {
            outbox.append(entry)
            writeLocked(Self.outboxURL(directory), outbox)
        }
        return entry.id
    }

    /// The queued mutations, oldest first.
    public func queuedMutations() -> [QueuedMutation] {
        queue.sync { outbox }
    }

    public var queuedCount: Int {
        queue.sync { outbox.count }
    }

    /// Removes a queued mutation (the server answered it, or it was lost with the connection).
    public func removeQueuedMutation(_ id: String) {
        queue.async {
            outbox.removeAll { $0.id == id }
            writeLocked(Self.outboxURL(directory), outbox)
        }
    }

    /// Drops every queued mutation.
    public func clearQueuedMutations() {
        queue.async {
            outbox.removeAll()
            writeLocked(Self.outboxURL(directory), outbox)
        }
    }
}
