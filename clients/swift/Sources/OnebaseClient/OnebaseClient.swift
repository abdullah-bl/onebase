import Foundation

/// An error from the server (its message is safe to show), or from the connection.
public struct OnebaseError: Error, CustomStringConvertible {
    public let message: String
    public let data: OnebaseValue?
    public var description: String { message }

    init(_ message: String, data: OnebaseValue? = nil) {
        self.message = message
        self.data = data
    }
}

/// A running live-query subscription; call `cancel()` to stop it.
public final class OnebaseSubscription {
    fileprivate let listenerId: UUID
    private weak var client: OnebaseClient?

    fileprivate init(listenerId: UUID, client: OnebaseClient) {
        self.listenerId = listenerId
        self.client = client
    }

    public func cancel() {
        client?.removeListener(listenerId)
        client = nil
    }
}

/// Reads and overrides the results of subscribed queries while a mutation runs (its "optimistic"
/// view of the data). Setting a query to nil shows it as loading until the mutation finishes.
public struct OptimisticLocalStore {
    let read: (String) -> OnebaseValue?
    let write: (String, OnebaseValue?) -> Void

    /// The current result of a subscribed query (with optimistic updates applied), or nil.
    public func get(_ path: String, _ args: [String: OnebaseValue] = [:]) -> OnebaseValue? {
        read(key(path, args))
    }

    /// Replaces a subscribed query's result until the mutation finishes.
    public func set(_ path: String, _ args: [String: OnebaseValue] = [:], _ value: OnebaseValue?) {
        write(key(path, args), value)
    }
}

/// The key a (path, args) pair is filed under, as canonical JSON with sorted keys.
func key(_ path: String, _ args: [String: OnebaseValue]) -> String {
    let value = OnebaseValue.object(["path": .string(path), "args": .object(args)])
    return (try? value.canonicalJSON) ?? "{\"path\":\(path)}"
}

/// The onebase client: one WebSocket carries live queries, calls and the auth token.
/// Offline support (pass `offlineDirectory`) caches the newest results and queues mutations
/// made while disconnected, sending them in order once the connection returns.
public final class OnebaseClient {
    final class PendingCall {
        let id: Int64
        let message: String
        var sent = false
        var continuation: CheckedContinuation<OnebaseValue, Error>?
        /// Present while this call is persisted as a queued mutation.
        var queuedId: String?
        var layer: Layer?

        init(id: Int64, message: String) {
            self.id = id
            self.message = message
        }
    }

    final class Listener {
        let id = UUID()
        let onUpdate: (OnebaseValue?) -> Void
        let onError: (String) -> Void

        init(onUpdate: @escaping (OnebaseValue?) -> Void, onError: @escaping (String) -> Void) {
            self.onUpdate = onUpdate
            self.onError = onError
        }
    }

    final class Subscription {
        let id: Int64
        let key: String
        let path: String
        let args: [String: OnebaseValue]
        var sent = false
        /// The server's newest value (nil until the first answer, or when it errored).
        var value: OnebaseValue?
        var error: String?
        /// Offline cache held until the server confirms who is asking.
        var heldCache: OnebaseValue?
        var heldSubject: String?
        var listeners: [Listener] = []
        /// The visible value last delivered, as canonical JSON (dedupes re-renders).
        var deliveredJSON: String?

        init(id: Int64, key: String, path: String, args: [String: OnebaseValue]) {
            self.id = id
            self.key = key
            self.path = path
            self.args = args
        }
    }

    final class Layer {
        let update: (OptimisticLocalStore) -> Void

        init(update: @escaping (OptimisticLocalStore) -> Void) {
            self.update = update
        }
    }

    public enum ConnectionState: String { case connecting, open, closed }

    private let state = DispatchQueue(label: "onebase.client")
    private let wsURL: URL
    private let httpBase: String
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var nextId: Int64 = 0
    private var closed = false
    private var ready = false
    private var reconnectDelay: TimeInterval = 0.5
    private var token: String?
    private var authAcked = false
    private var subscriptions: [Int64: Subscription] = [:]
    private var subscriptionsByKey: [String: Subscription] = [:]
    private var pendingCalls: [Int64: PendingCall] = [:]
    private var orderedPending: [Int64] = []
    private var layers: [Layer] = []
    private var overrides: [String: OnebaseValue?] = [:]
    private var keepAlive: Task<Void, Never>?

    public let tokenStore: OnebaseTokenStore?
    public let offlineStore: OfflineStore?

    /// Called on the main queue whenever the connection state changes.
    public var onConnectionChange: ((ConnectionState) -> Void)?
    /// Called on the main queue with `false` when the token stops checking out (signed out,
    /// expired, rejected), and with `true` once the server accepts a token.
    public var onAuthChange: ((Bool) -> Void)?
    /// Called on the main queue when a queued mutation (made in an earlier run) fails on the
    /// server. Mutations made by this run's `mutation()` calls throw to their caller instead.
    public var onQueuedMutationFailure: ((String, String) -> Void)?

    /// True once the server has accepted the current token; set on the main queue.
    public private(set) var isAuthenticated = false

    /// - Parameters:
    ///   - url: the server, e.g. `https://api.example.com`.
    ///   - tokenStore: keeps the session token between runs (the Keychain by default on Apple platforms).
    ///   - offlineDirectory: a folder for the offline cache and the queued-mutation outbox.
    public init(url: String, tokenStore: OnebaseTokenStore? = nil, offlineDirectory: URL? = nil) {
        let trimmed = url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let base = URL(string: trimmed.isEmpty ? "http://localhost:8090" : trimmed)!
        let ws = base.appendingPathComponent("api/sync")
        wsURL = URL(string: ws.absoluteString.replacingOccurrences(of: "^http", with: "ws", options: .regularExpression))!
        httpBase = base.absoluteString
        session = URLSession(configuration: .default)
        if let offlineDirectory {
            offlineStore = OfflineStore(directory: offlineDirectory)
        } else {
            offlineStore = nil
        }
        #if canImport(Security)
        self.tokenStore = tokenStore ?? KeychainTokenStore()
        #else
        self.tokenStore = tokenStore
        #endif
        token = self.tokenStore?.loadToken()
        // Mutations queued by an earlier run, still unanswered: send them first.
        if let offline = offlineStore {
            for queued in offline.queuedMutations() {
                nextId += 1
                let pending = PendingCall(id: nextId, message: Outgoing.call(requestId: nextId, kind: "mutation", path: queued.path, args: argsOf(queued.args)))
                pending.queuedId = queued.id
                pendingCalls[nextId] = pending
                orderedPending.append(nextId)
            }
        }
        connect()
        keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard let self else { return }
                self.state.sync {
                    guard !self.closed else { return }
                    self.task?.sendPing { _ in }
                }
            }
        }
    }

    deinit {
        keepAlive?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
    }

    private func argsOf(_ value: OnebaseValue) -> [String: OnebaseValue] {
        value.object ?? [:]
    }

    // ---- Connection ----

    private func connect() {
        state.async {
            guard !self.closed, self.task == nil else { return }
            let task = self.session.webSocketTask(with: self.wsURL)
            self.task = task
            self.ready = false
            self.setConnectionMain(.connecting)
            task.resume()
            // WebSocket tasks buffer sends until the handshake completes, and preserve order,
            // so the auth token, subscriptions and queued calls can go out right away.
            self.authAcked = false
            if self.token != nil { self.sendLocked(Outgoing.auth(token: self.token)) }
            for subscription in self.subscriptions.values where !subscription.sent {
                self.sendLocked(Outgoing.sub(id: subscription.id, path: subscription.path, args: subscription.args))
                subscription.sent = true
            }
            for id in self.orderedPending {
                guard let pending = self.pendingCalls[id], !pending.sent else { continue }
                task.send(.string(pending.message)) { [weak self] _ in
                    self?.state.async { self?.pendingCalls[id]?.sent = true }
                }
            }
            self.ready = true
            self.reconnectDelay = 0.5
            self.setConnectionMain(.open)
            self.receiveLoop(task)
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                self.state.async {
                    switch message {
                    case .string(let text): self.handle(text)
                    case .data(let data): if let text = String(data: data, encoding: .utf8) { self.handle(text) }
                    @unknown default: break
                    }
                }
                self.receiveLoop(task)
            case .failure:
                self.dropConnection(task)
            }
        }
    }

    private func dropConnection(_ dead: URLSessionWebSocketTask) {
        state.async {
            guard self.task === dead else { return }
            self.task = nil
            self.ready = false
            self.authAcked = false
            self.setConnectionMain(.connecting)
            // A call that was sent may or may not have run; like the JS client, it is not
            // silently retried. Its caller hears about it; the queued copy is dropped.
            for id in self.orderedPending {
                guard let pending = self.pendingCalls[id], pending.sent else { continue }
                self.pendingCalls[id] = nil
                if let queuedId = pending.queuedId { self.offlineStore?.removeQueuedMutation(queuedId) }
                pending.continuation?.resume(throwing: OnebaseError("Connection lost before the server replied; the call may or may not have run."))
            }
            self.orderedPending.removeAll { self.pendingCalls[$0] == nil }
            for subscription in self.subscriptions.values { subscription.sent = false }
            guard !self.closed else { return }
            let delay = self.reconnectDelay
            self.reconnectDelay = min(self.reconnectDelay * 2, 10)
            self.state.asyncAfter(deadline: .now() + delay) { self.connect() }
        }
    }

    /// Must run on `state`.
    private func sendLocked(_ text: String) {
        task?.send(.string(text)) { _ in }
    }

    // ---- Auth ----

    /// Sets the token sent with every call (or nil to sign out), and remembers it in the token store.
    public func setToken(_ newToken: String?) {
        tokenStore?.saveToken(newToken)
        state.async {
            self.token = newToken
            self.authAcked = false
            self.sendLocked(Outgoing.auth(token: newToken))
        }
        if newToken == nil {
            isAuthenticated = false
            onAuthChangeMain(false)
        }
    }

    // ---- Live queries ----

    /// Subscribes to a query; `onUpdate` runs with every new result (on the main queue).
    /// Offline: the newest cached result arrives first while disconnected, then live data.
    @discardableResult
    public func subscribe(
        _ path: String,
        _ args: [String: OnebaseValue] = [:],
        onUpdate: @escaping (OnebaseValue?) -> Void,
        onError: @escaping (String) -> Void = { _ in }
    ) -> OnebaseSubscription {
        let subKey = key(path, args)
        let listener = Listener(onUpdate: onUpdate, onError: onError)
        var immediate: OnebaseValue?
        state.sync {
            let subscription: Subscription
            if let existing = subscriptionsByKey[subKey] {
                subscription = existing
                immediate = subscription.value // a new listener sees the current result at once
            } else {
                nextId += 1
                subscription = Subscription(id: nextId, key: subKey, path: path, args: args)
                subscriptions[subscription.id] = subscription
                subscriptionsByKey[subKey] = subscription
                if let cached = offlineStore?.cachedValue(subKey) {
                    if token == nil && tokenStore == nil {
                        subscription.value = cached // no token anywhere: show it right away
                        immediate = cached
                    } else {
                        // Held until the server confirms the same user is asking.
                        subscription.heldCache = cached
                        subscription.heldSubject = offlineStore?.cacheSubject
                    }
                }
                if ready {
                    sendLocked(Outgoing.sub(id: subscription.id, path: path, args: args))
                    subscription.sent = true
                }
            }
            subscription.listeners.append(listener)
        }
        if let immediate {
            deliverOnMain(immediate, listener.onUpdate)
        }
        return OnebaseSubscription(listenerId: listener.id, client: self)
    }

    fileprivate func removeListener(_ listenerId: UUID) {
        state.async {
            for subscription in self.subscriptions.values {
                subscription.listeners.removeAll { $0.id == listenerId }
            }
            for (id, subscription) in self.subscriptions where subscription.listeners.isEmpty {
                self.subscriptions[id] = nil
                self.subscriptionsByKey[subscription.key] = nil
                if subscription.sent { self.sendLocked(Outgoing.unsub(id: subscription.id)) }
            }
        }
    }

    // ---- Calls ----

    /// Runs a query once.
    public func query(_ path: String, _ args: [String: OnebaseValue] = [:]) async throws -> OnebaseValue {
        try await call("query", path, args)
    }

    /// Runs a mutation. With `optimistic`, subscribed queries show its expected effect
    /// immediately; real results replace it when the mutation finishes. Offline: the mutation
    /// is queued (persisted) and sent in order once the connection returns.
    public func mutation(
        _ path: String,
        _ args: [String: OnebaseValue] = [:],
        optimistic: ((OptimisticLocalStore) -> Void)? = nil
    ) async throws -> OnebaseValue {
        var layer: Layer?
        if let optimistic {
            let newLayer = Layer(update: optimistic)
            layer = newLayer
            state.async {
                self.layers.append(newLayer)
                self.recomputeOverlaysLocked()
            }
        }
        do {
            let value = try await call("mutation", path, args, layer: layer)
            return value
        } catch {
            if let layer {
                state.async {
                    self.layers.removeAll { $0 === layer }
                    self.recomputeOverlaysLocked()
                }
            }
            throw error
        }
    }

    /// Runs an action.
    public func action(_ path: String, _ args: [String: OnebaseValue] = [:]) async throws -> OnebaseValue {
        try await call("action", path, args)
    }

    private func call(_ kind: String, _ path: String, _ args: [String: OnebaseValue], layer: Layer? = nil) async throws -> OnebaseValue {
        try await withCheckedThrowingContinuation { continuation in
            state.async {
                self.nextId += 1
                let id = self.nextId
                let pending = PendingCall(id: id, message: Outgoing.call(requestId: id, kind: kind, path: path, args: args))
                pending.continuation = continuation
                pending.layer = layer
                if kind == "mutation", let offline = self.offlineStore {
                    pending.queuedId = offline.enqueueMutation(path, args)
                }
                self.pendingCalls[id] = pending
                self.orderedPending.append(id)
                if self.ready, let task = self.task {
                    task.send(.string(pending.message)) { [weak self] _ in
                        self?.state.async { self?.pendingCalls[id]?.sent = true }
                    }
                }
            }
        }
    }

    // ---- Queued mutations (offline) ----

    /// Mutations still queued: made while disconnected, not yet answered by the server.
    public var queuedMutationCount: Int {
        offlineStore?.queuedCount ?? 0
    }

    /// Drops every queued mutation. Calls still waiting for a connection throw.
    public func clearQueuedMutations() {
        let ids = Set(offlineStore?.queuedMutations().map(\.id) ?? [])
        state.async {
            for id in self.orderedPending {
                guard let pending = self.pendingCalls[id], let queuedId = pending.queuedId, ids.contains(queuedId) else { continue }
                pending.queuedId = nil
                pending.continuation?.resume(throwing: OnebaseError("Dropped: cleared while queued."))
                pending.continuation = nil
            }
        }
        offlineStore?.clearQueuedMutations()
    }

    // ---- Built-in auth over HTTP ----

    /// Signs in with the built-in password method (POST /api/auth/signin). On success the token
    /// is stored and set; returns nil when a code was emailed instead (`verifyEmail` flows).
    public func signInPassword(email: String, password: String, flow: String = "signIn", name: String? = nil) async throws -> String? {
        var params: [String: OnebaseValue] = ["email": .string(email), "password": .string(password), "flow": .string(flow)]
        if let name { params["name"] = .string(name) }
        let reply = try await authRequest(["provider": .string("password"), "params": .object(params)])
        guard let body = reply.object else { return nil }
        if let tokenValue = body["token"]?.string {
            setToken(tokenValue)
            return tokenValue
        }
        return nil
    }

    /// Ends the built-in session on the server and forgets the token.
    public func signOut() async throws {
        if let token {
            _ = try? await authRequest(["everywhere": .bool(false)], path: "signout", token: token)
        }
        setToken(nil)
    }

    private func authRequest(_ body: [String: OnebaseValue], path: String = "signin", token: String? = nil) async throws -> OnebaseValue {
        var request = URLRequest(url: URL(string: "\(httpBase)/api/auth/\(path)")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONEncoder().encode(OnebaseValue.object(body))
        let (data, response) = try await session.data(for: request)
        let value = try? JSONDecoder().decode(OnebaseValue.self, from: data)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw OnebaseError(value?.object?["error"]?.string ?? "Sign-in failed (HTTP \(http.statusCode)).")
        }
        return value ?? .null
    }

    // ---- Close ----

    public func close() {
        state.async {
            guard !self.closed else { return }
            self.closed = true
            self.keepAlive?.cancel()
            self.offlineStore?.flush()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.ready = false
            self.setConnectionMain(.closed)
        }
    }

    // ---- Internals: incoming messages and delivery ----

    /// Must run on `state`.
    private func handle(_ text: String) {
        guard let message = Incoming.parse(text) else { return }
        switch message {
        case .auth(let ok, let ended, let subject, let error):
            authAcked = true
            if ok {
                releaseHeldCachesLocked(subject: subject)
                offlineStore?.setSubject(subject)
                let authenticated = subject != nil
                isAuthenticated = authenticated
                onAuthChangeMain(authenticated)
            } else if ended {
                token = nil
                tokenStore?.saveToken(nil)
                for subscription in subscriptions.values { subscription.heldCache = nil }
                isAuthenticated = false
                onAuthChangeMain(false)
            } else {
                // Transient (the server couldn't check the token): keep it and retry on reconnect.
                _ = error
            }
        case .update(let update):
            applyUpdateLocked(update)
        case .callResult(let result):
            settleLocked(result)
        case .transition(let updates, let results):
            for update in updates { applyUpdateLocked(update) }
            for result in results { settleLocked(result) }
        }
    }

    private func applyUpdateLocked(_ update: OnebaseUpdate) {
        guard let subscription = subscriptions[update.id] else { return }
        if update.ok {
            subscription.value = update.value
            subscription.error = nil
            if let value = update.value { offlineStore?.storeResult(subscription.key, value) }
        } else {
            subscription.error = update.error
        }
        deliverVisibleLocked(subscription)
    }

    private func settleLocked(_ result: OnebaseCallResult) {
        guard let pending = pendingCalls[result.requestId] else { return }
        pendingCalls[result.requestId] = nil
        orderedPending.removeAll { $0 == result.requestId }
        if let queuedId = pending.queuedId { offlineStore?.removeQueuedMutation(queuedId) }
        if let layer = pending.layer {
            layers.removeAll { $0 === layer }
            recomputeOverlaysLocked()
        }
        if result.ok {
            pending.continuation?.resume(returning: result.value ?? .null)
        } else {
            let error = OnebaseError(result.error ?? "The call failed.")
            if let continuation = pending.continuation {
                continuation.resume(throwing: error)
            } else {
                // A mutation queued by an earlier run, with no caller waiting.
                DispatchQueue.main.async { [weak self] in
                    self?.onQueuedMutationFailure?(String(result.requestId), error.message)
                }
            }
        }
    }

    /// Cached results held for the auth answer: shown if it's the same user, dropped otherwise.
    private func releaseHeldCachesLocked(subject: String?) {
        for subscription in subscriptions.values {
            guard let held = subscription.heldCache else { continue }
            subscription.heldCache = nil
            if subscription.heldSubject == subject {
                subscription.value = held
                deliverVisibleLocked(subscription)
            }
        }
    }

    /// Recomputes every optimistic override (each layer sees the previous ones' effect) and
    /// delivers what changed. Must run on `state`.
    private func recomputeOverlaysLocked() {
        overrides = [:]
        let store = OptimisticLocalStore(
            read: { [weak self] subKey in
                guard let self else { return nil }
                if let override = self.overrides[subKey] { return override }
                return self.subscriptionsByKey[subKey]?.value
            },
            write: { subKey, value in
                self.overrides[subKey] = value
            }
        )
        for layer in layers { layer.update(store) }
        for subscription in subscriptions.values { deliverVisibleLocked(subscription) }
    }

    private func deliverVisibleLocked(_ subscription: Subscription) {
        let visible: OnebaseValue?
        if let override = overrides[subscription.key] {
            visible = override
        } else {
            visible = subscription.value
        }
        let json = (try? OnebaseValue.object(["v": visible ?? .null]).canonicalJSON) ?? nil
        if let error = subscription.error, overrides[subscription.key] == nil {
            if subscription.deliveredJSON == "e:\(error)" { return }
            subscription.deliveredJSON = "e:\(error)"
            for listener in subscription.listeners { deliverErrorOnMain(error, listener.onError) }
            return
        }
        if json == subscription.deliveredJSON { return }
        subscription.deliveredJSON = json
        for listener in subscription.listeners { deliverOnMain(visible, listener.onUpdate) }
    }

    private func deliverOnMain(_ value: OnebaseValue?, _ onUpdate: @escaping (OnebaseValue?) -> Void) {
        DispatchQueue.main.async { onUpdate(value) }
    }

    private func deliverErrorOnMain(_ error: String, _ onError: @escaping (String) -> Void) {
        DispatchQueue.main.async { onError(error) }
    }

    private func setConnectionMain(_ newState: ConnectionState) {
        DispatchQueue.main.async { [weak self] in self?.onConnectionChange?(newState) }
    }

    private func onAuthChangeMain(_ authenticated: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.isAuthenticated = authenticated
            self?.onAuthChange?(authenticated)
        }
    }
}
