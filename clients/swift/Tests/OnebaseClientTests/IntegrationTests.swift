import XCTest
#if canImport(Network)
import Network
@testable import OnebaseClient

/// A minimal onebase /api/sync server over Network.framework's WebSocket, so the client is
/// tested against the real protocol.
final class FakeSyncServer {
    private let queue = DispatchQueue(label: "fake-sync-server")
    private var listener: NWListener?
    private var connection: NWConnection?
    private(set) var port: UInt16 = 0
    private let ready = DispatchSemaphore(value: 0)

    /// Called for each call message: (requestId, kind, path, args, reply). `reply(ok, value,
    /// error)` sends the result; call it later to delay the answer.
    var onCall: ((Int64, String, String, [String: OnebaseValue], @escaping (Bool, OnebaseValue?, String?) -> Void) -> Void)?
    /// Called for each subscription: (id, path, reply). `reply(value)` sends the first update.
    var onSub: ((Int64, String, @escaping (OnebaseValue) -> Void) -> Void)?

    private static func encode(_ object: [String: OnebaseValue]) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(data: (try? encoder.encode(OnebaseValue.object(object))) ?? Data(), encoding: .utf8) ?? "{}"
    }

    func start(onPort fixed: UInt16? = nil) throws {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        let listener = try NWListener(using: params, on: fixed.map { NWEndpoint.Port(rawValue: $0)! } ?? .any)
        self.listener = listener
        let semaphore = ready
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.port = listener.port?.rawValue ?? 0
                semaphore.signal()
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.queue.async {
                self?.connection = connection
                connection.start(queue: self?.queue ?? .main)
                self?.receive(connection)
            }
        }
        listener.start(queue: queue)
        XCTAssertEqual(semaphore.wait(timeout: .now() + 5), .success, "the fake server never became ready")
    }

    func stop() {
        listener?.cancel()
        connection?.cancel()
    }

    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, let text = String(data: data, encoding: .utf8) { self.handle(text) }
            if error == nil { self.receive(connection) }
        }
    }

    private func handle(_ text: String) {
        guard let value = try? JSONDecoder().decode(OnebaseValue.self, from: Data(text.utf8)),
              let object = value.object else { return }
        switch object["type"]?.string {
        case "auth":
            send(Self.encode(["type": .string("auth"), "ok": .bool(true), "identity": .null]))
        case "sub":
            guard let id = object["id"]?.int, let path = object["path"]?.string else { return }
            let reply: (OnebaseValue) -> Void = { [weak self] value in
                self?.send(Self.encode(["type": .string("update"), "id": .int(id), "ok": .bool(true), "value": value]))
            }
            if let onSub {
                onSub(id, path, reply)
            } else {
                reply(.object(["subscribed": .string(path)]))
            }
        case "call":
            guard let requestId = object["requestId"]?.int else { return }
            let kind = object["kind"]?.string ?? ""
            let path = object["path"]?.string ?? ""
            let args = object["args"]?.object ?? [:]
            let reply: (Bool, OnebaseValue?, String?) -> Void = { [weak self] ok, value, error in
                var message: [String: OnebaseValue] = ["type": .string("result"), "requestId": .int(requestId), "ok": .bool(ok)]
                if ok { message["value"] = value ?? .null } else { message["error"] = .string(error ?? "failed") }
                self?.send(Self.encode(message))
            }
            if let onCall {
                onCall(requestId, kind, path, args, reply)
            } else {
                reply(true, .null, nil)
            }
        default:
            break
        }
    }

    private func send(_ text: String) {
        queue.async { [weak self] in
            guard let connection = self?.connection else { return }
            let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
            let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
            connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
        }
    }
}

final class IntegrationTests: XCTestCase {
    private func tempDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("onebase-tests-\(UUID().uuidString)")
    }

    private func tokenStore(_ directory: URL) -> FileTokenStore {
        FileTokenStore(fileURL: directory.appendingPathComponent("token"))
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 5, _ condition: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    func testSubscribeAndMutateOverTheProtocol() async throws {
        let server = FakeSyncServer()
        try server.start()
        defer { server.stop() }
        let directory = tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let client = OnebaseClient(url: "http://127.0.0.1:\(server.port)", tokenStore: tokenStore(directory), offlineDirectory: directory)
        defer { client.close() }

        let firstResult = expectation(description: "the subscription's first result")
        var received: OnebaseValue?
        client.subscribe("notes:list", [:]) { value in
            received = value
            firstResult.fulfill()
        }
        await fulfillment(of: [firstResult], timeout: 5)
        XCTAssertEqual(received?.object?["subscribed"]?.string, "notes:list")

        server.onCall = { _, kind, path, _, reply in
            XCTAssertEqual(kind, "mutation")
            reply(true, .object(["added": .string(path)]), nil)
        }
        let value = try await client.mutation("notes:add", ["text": "hello"])
        XCTAssertEqual(value["added"]?.string, "notes:add")
    }

    func testOptimisticUpdateShowsImmediatelyAndRevertsToServerData() async throws {
        let server = FakeSyncServer()
        try server.start()
        defer { server.stop() }
        let directory = tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let client = OnebaseClient(url: "http://127.0.0.1:\(server.port)", tokenStore: tokenStore(directory), offlineDirectory: directory)
        defer { client.close() }

        server.onSub = { _, _, reply in reply(.int(1)) } // the server's counter starts at 1
        server.onCall = { _, _, _, _, reply in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { reply(true, .null, nil) }
        }

        let seen: NSMutableArray = [] // appended on the main queue by client callbacks
        let first = expectation(description: "server value 1")
        client.subscribe("counter", [:]) { value in
            seen.add(value?.int ?? -1)
            if value?.int == 1 { first.fulfill() }
        }
        await fulfillment(of: [first], timeout: 5)

        _ = try await client.mutation("counter:increment", [:]) { store in
            store.set("counter", [:], .int(2)) // what the increment should look like
        }

        // The optimistic 2 showed before the mutation finished, then the server's 1 returned.
        try await waitUntil("the optimistic round-trip [1, 2, 1]") {
            let values = (seen as? [Int64]) ?? []
            return values.count >= 3 && Array(values.suffix(3)) == [1, 2, 1]
        }
    }

    func testQueuedMutationsDrainInOrderOnceTheServerAppears() async throws {
        // A port nothing listens on yet: bind one, note it, let it go.
        let blocker = FakeSyncServer()
        try blocker.start()
        let port = blocker.port
        blocker.stop()

        let directory = tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let offline = OnebaseClient(url: "http://127.0.0.1:\(port)", tokenStore: tokenStore(directory), offlineDirectory: directory)
        try await Task.sleep(nanoseconds: 300_000_000) // clearly in its retry loop, not connected
        Task {
            _ = try? await offline.mutation("notes:add", ["text": "queued-1"])
            _ = try? await offline.mutation("notes:add", ["text": "queued-2"])
        }
        try await waitUntil("two mutations queued") { offline.queuedMutationCount == 2 }
        offline.close() // the app goes away; the queue lives in the offline store

        // The server appears on that port; a fresh client with the same offline store drains it.
        let server = FakeSyncServer()
        try server.start(onPort: port)
        defer { server.stop() }
        let calls: NSMutableArray = [] // appended on the server queue
        server.onCall = { _, _, path, args, reply in
            calls.add("\(path)|\(args["text"]?.string ?? "")")
            reply(true, .null, nil)
        }

        let reloaded = OnebaseClient(url: "http://127.0.0.1:\(port)", tokenStore: tokenStore(directory), offlineDirectory: directory)
        defer { reloaded.close() }
        try await waitUntil("the queue drained and both calls arrived") {
            reloaded.queuedMutationCount == 0 && calls.count == 2
        }
        XCTAssertEqual(calls as? [String], ["notes:add|queued-1", "notes:add|queued-2"])
    }

    func testCachedResultHydratesTheNextClientBeforeTheServerAnswers() async throws {
        let server = FakeSyncServer()
        try server.start()
        defer { server.stop() }
        let directory = tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        server.onSub = { _, _, reply in reply(.object(["greeting": .string("cached hello")])) }
        let first = OnebaseClient(url: "http://127.0.0.1:\(server.port)", tokenStore: tokenStore(directory), offlineDirectory: directory)
        let gotIt = expectation(description: "got a server value")
        first.subscribe("greeting", [:]) { value in
            if value?.object?["greeting"]?.string != nil { gotIt.fulfill() }
        }
        await fulfillment(of: [gotIt], timeout: 5)
        first.close() // flushes the cache to disk

        // The next client sees the cached result first; the server's answer takes a moment.
        server.onSub = { _, _, reply in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { reply(.object(["greeting": .string("fresh hello")])) }
        }
        let second = OnebaseClient(url: "http://127.0.0.1:\(server.port)", tokenStore: tokenStore(directory), offlineDirectory: directory)
        defer { second.close() }
        var deliveries: [String] = []
        let cached = expectation(description: "the cached value arrived first")
        let fresh = expectation(description: "then the fresh value")
        second.subscribe("greeting", [:]) { value in
            if let greeting = value?.object?["greeting"]?.string {
                deliveries.append(greeting)
                if greeting == "cached hello" { cached.fulfill() }
                if greeting == "fresh hello" { fresh.fulfill() }
            }
        }
        await fulfillment(of: [cached], timeout: 2) // well before the delayed server answer
        await fulfillment(of: [fresh], timeout: 5)
        XCTAssertEqual(deliveries.first, "cached hello")
    }
}

#endif
