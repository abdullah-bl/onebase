import Foundation

/// A JSON value as onebase stores it: the shape of arguments, results and documents.
/// Build one from a literal (`"text"`, `42`, `["notes", 7]`, `["text": "hi"]`) or decode one
/// from your own `Codable` types.
public enum OnebaseValue: Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([OnebaseValue])
    case object([String: OnebaseValue])
}

// ---- Reading ----

extension OnebaseValue {
    public var bool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var int: Int64? {
        if case .int(let i) = self { return i }
        return nil
    }

    public var double: Double? {
        if case .double(let d) = self { return d }
        if case .int(let i) = self { return Double(i) }
        return nil
    }

    public var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var array: [OnebaseValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var object: [String: OnebaseValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// The value at a key path, e.g. `value["user", "name"]`.
    public subscript(fields: String...) -> OnebaseValue? {
        var current = self
        for field in fields {
            guard let next = current.object?[field] else { return nil }
            current = next
        }
        return current
    }

    /// A canonical JSON string (object keys sorted), so (path, args) pairs hash to one key.
    public var canonicalJSON: String {
        get throws {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            return String(data: try encoder.encode(self), encoding: .utf8) ?? "null"
        }
    }
}

// ---- Building from literals ----

extension OnebaseValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(nilLiteral _: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: OnebaseValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, OnebaseValue)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
}

// ---- Codable: plain JSON on the wire, ints before doubles when decoding ----

extension OnebaseValue: Encodable {
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .int(let i): try container.encode(i)
        case .double(let d): try container.encode(d)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }
}

extension OnebaseValue: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? container.decode(Int64.self) {
            self = .int(i)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([OnebaseValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: OnebaseValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not a JSON value onebase can represent")
        }
    }
}

extension OnebaseValue {
    /// Any `Codable` value (a struct, a dictionary, …) as a `OnebaseValue`.
    public init(_ value: some Encodable) throws {
        self = try JSONDecoder().decode(OnebaseValue.self, from: JSONEncoder().encode(value))
    }
}
