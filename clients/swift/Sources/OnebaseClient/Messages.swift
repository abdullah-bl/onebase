import Foundation

/// The messages of onebase's `/api/sync` WebSocket, as JSON (see docs/client-protocol.md).
enum Outgoing {
    static func json(_ object: [String: OnebaseValue]) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(OnebaseValue.object(object)), let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    static func auth(token: String?) -> String {
        token == nil ? json(["type": "auth", "token": .null]) : json(["type": "auth", "token": .string(token!)])
    }

    static func sub(id: Int64, path: String, args: [String: OnebaseValue]) -> String {
        json(["type": "sub", "id": .int(id), "path": .string(path), "args": .object(args)])
    }

    static func unsub(id: Int64) -> String {
        json(["type": "unsub", "id": .int(id)])
    }

    static func call(requestId: Int64, kind: String, path: String, args: [String: OnebaseValue]) -> String {
        json(["type": "call", "requestId": .int(requestId), "kind": .string(kind), "path": .string(path), "args": .object(args)])
    }
}

/// A live query's new result (`ok: false` carries `error` instead of `value`).
public struct OnebaseUpdate: @unchecked Sendable {
    public let id: Int64
    public let ok: Bool
    public let value: OnebaseValue?
    public let error: String?
}

/// The answer to a query, mutation or action call.
public struct OnebaseCallResult: @unchecked Sendable {
    public let requestId: Int64
    public let ok: Bool
    public let value: OnebaseValue?
    public let error: String?
}

enum Incoming {
    case auth(ok: Bool, ended: Bool, subject: String?, error: String?)
    case update(OnebaseUpdate)
    case callResult(OnebaseCallResult)
    case transition(updates: [OnebaseUpdate], results: [OnebaseCallResult])

    static func parse(_ text: String) -> Incoming? {
        guard let data = text.data(using: .utf8), let value = try? JSONDecoder().decode(OnebaseValue.self, from: data) else { return nil }
        let object = value.object ?? [:]
        let id = object["id"]?.int
        let requestId = object["requestId"]?.int
        let ok = object["ok"]?.bool ?? false
        let error = object["error"]?.string
        let result = { (id: Int64) -> OnebaseUpdate in
            OnebaseUpdate(id: id, ok: ok, value: ok ? object["value"] : nil, error: ok ? nil : error)
        }
        switch object["type"]?.string {
        case "auth":
            let identity = ok ? object["identity"] : nil
            let subject = identity?.object?["subject"]?.string
            return .auth(ok: ok, ended: object["ended"]?.bool ?? false, subject: subject, error: error)
        case "update":
            guard let id else { return nil }
            return .update(result(id))
        case "result":
            guard let requestId else { return nil }
            return .callResult(OnebaseCallResult(requestId: requestId, ok: ok, value: ok ? object["value"] : nil, error: ok ? nil : error))
        case "transition":
            let updates = (object["updates"]?.array ?? []).compactMap { entry -> OnebaseUpdate? in
                guard let entryId = entry.object?["id"]?.int else { return nil }
                let entryOk = entry.object?["ok"]?.bool ?? false
                return OnebaseUpdate(id: entryId, ok: entryOk, value: entryOk ? entry.object?["value"] : nil, error: entryOk ? nil : entry.object?["error"]?.string)
            }
            let results = (object["results"]?.array ?? []).compactMap { entry -> OnebaseCallResult? in
                guard let entryId = entry.object?["requestId"]?.int else { return nil }
                let entryOk = entry.object?["ok"]?.bool ?? false
                return OnebaseCallResult(requestId: entryId, ok: entryOk, value: entryOk ? entry.object?["value"] : nil, error: entryOk ? nil : entry.object?["error"]?.string)
            }
            return .transition(updates: updates, results: results)
        default:
            return nil
        }
    }
}
