import XCTest
@testable import OnebaseClient

final class OfflineStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("onebase-tests-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testCacheKeepsOnlyTheNewestResults() throws {
        let store = OfflineStore(directory: directory, maxCachedQueries: 3)
        for n in 1...5 {
            store.storeResult("k\(n)", .int(Int64(n)))
        }
        store.flush()
        let reloaded = OfflineStore(directory: directory, maxCachedQueries: 3)
        XCTAssertNil(reloaded.cachedValue("k1"))
        XCTAssertNil(reloaded.cachedValue("k2"))
        XCTAssertEqual(reloaded.cachedValue("k3")?.int, 3)
        XCTAssertEqual(reloaded.cachedValue("k5")?.int, 5)
    }

    func testCacheIsClearedWhenTheSubjectChanges() throws {
        let store = OfflineStore(directory: directory)
        store.setSubject("alice")
        store.storeResult("k", .string("alice's data"))
        store.flush()
        XCTAssertEqual(OfflineStore(directory: directory).cachedValue("k")?.string, "alice's data")

        let nextUser = OfflineStore(directory: directory)
        nextUser.setSubject("bob")
        nextUser.flush()
        XCTAssertNil(OfflineStore(directory: directory).cachedValue("k"))
        XCTAssertEqual(OfflineStore(directory: directory).cacheSubject, "bob")
    }

    func testOutboxPersistsInOrderUntilAnswered() throws {
        let store = OfflineStore(directory: directory)
        let first = store.enqueueMutation("notes:add", ["text": "one"])
        let second = store.enqueueMutation("notes:add", ["text": "two"])
        XCTAssertEqual(store.queuedCount, 2)

        let reloaded = OfflineStore(directory: directory)
        let queued = reloaded.queuedMutations()
        XCTAssertEqual(queued.map(\.path), ["notes:add", "notes:add"])
        XCTAssertEqual(queued.map { $0.args.object?["text"]?.string }, ["one", "two"])

        reloaded.removeQueuedMutation(first)
        XCTAssertEqual(reloaded.queuedCount, 1)
        reloaded.flush()
        XCTAssertEqual(OfflineStore(directory: directory).queuedMutations().first?.id, second)

        reloaded.clearQueuedMutations()
        reloaded.flush()
        XCTAssertEqual(OfflineStore(directory: directory).queuedCount, 0)
    }
}
