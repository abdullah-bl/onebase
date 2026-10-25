import Foundation

/// A mutation made while disconnected, persisted until the server answers it.
public struct QueuedMutation: Codable, Equatable {
    /// A UUID string identifying this entry in the store.
    public let id: String
    public let path: String
    public let args: OnebaseValue
    /// Who made it (the server-confirmed auth subject; nil means anonymous), once known.
    public var subject: String?
    /// False while unknown: made before the server confirmed who is asking. The next confirmed
    /// user then owns it. Entries written by older versions decode as unknown.
    public var subjectKnown: Bool

    init(id: String, path: String, args: OnebaseValue, subject: String?, subjectKnown: Bool) {
        self.id = id
        self.path = path
        self.args = args
        self.subject = subject
        self.subjectKnown = subjectKnown
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        path = try container.decode(String.self, forKey: .path)
        args = try container.decode(OnebaseValue.self, forKey: .args)
        subject = try container.decodeIfPresent(String.self, forKey: .subject)
        subjectKnown = try container.decodeIfPresent(Bool.self, forKey: .subjectKnown) ?? false
    }
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
        queue.sync {
            guard self.cache.subject != subject else { return }
            self.cache.subject = subject
            self.cache.entries = [:]
            self.flushLocked()
        }
    }

    /// Writes any unsaved state now (also called by the client on close).
    public func flush() {
        queue.sync { self.flushLocked() }
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

    /// Queues a mutation (persisted immediately) and returns its id. `subject` is who made it, when
    /// the server has confirmed that (`subjectKnown`); otherwise the next confirmed user owns it.
    public func enqueueMutation(_ path: String, _ args: [String: OnebaseValue], subject: String? = nil, subjectKnown: Bool = false) -> String {
        let entry = QueuedMutation(id: UUID().uuidString, path: path, args: .object(args), subject: subject, subjectKnown: subjectKnown)
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

    /// Records who owns a queued mutation that was made before that was known.
    public func setMutationSubject(_ id: String, _ subject: String?) {
        queue.sync {
            guard let at = self.outbox.firstIndex(where: { $0.id == id }) else { return }
            self.outbox[at].subject = subject
            self.outbox[at].subjectKnown = true
            self.writeLocked(Self.outboxURL(self.directory), self.outbox)
        }
    }

    /// Removes a queued mutation (the server answered it, or it was lost with the connection).
    public func removeQueuedMutation(_ id: String) {
        queue.sync {
            self.outbox.removeAll { $0.id == id }
            self.writeLocked(Self.outboxURL(self.directory), self.outbox)
        }
    }

    /// Drops every queued mutation.
    public func clearQueuedMutations() {
        queue.sync {
            self.outbox.removeAll()
            self.writeLocked(Self.outboxURL(self.directory), self.outbox)
        }
    }
}
