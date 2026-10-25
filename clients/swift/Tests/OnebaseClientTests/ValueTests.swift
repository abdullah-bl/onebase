import XCTest
@testable import OnebaseClient

final class ValueTests: XCTestCase {
    func testLiterals() {
        let nilValue: OnebaseValue = nil
        let value: OnebaseValue = ["text": "hi", "count": 3, "ratio": 1.5, "ok": true, "tags": ["a", "b"], "missing": nilValue]
        XCTAssertEqual(value["text"]?.string, "hi")
        XCTAssertEqual(value["count"]?.int, 3)
        XCTAssertEqual(value["ratio"]?.double, 1.5)
        XCTAssertEqual(value["ok"]?.bool, true)
        XCTAssertEqual(value["tags"]?.array?.count, 2)
        XCTAssertEqual(value["missing"], .null)
        XCTAssertNil(value["nope"])
    }

    func testRoundTrip() throws {
        let original: OnebaseValue = ["list": [1, 2.5, "three", true, nil], "nested": ["deep": ["x": 9]]]
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(OnebaseValue.self, from: data)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded["list"]?.array?[0]?.int, 1)
        XCTAssertEqual(decoded["list"]?.array?[1]?.double, 2.5)
    }

    func testWholeNumbersDecodeAsInts() throws {
        let decoded = try JSONDecoder().decode(OnebaseValue.self, from: Data(#"{"n": 7}"#.utf8))
        XCTAssertEqual(decoded["n"]?.int, 7)
    }

    func testCanonicalJSONSortsKeys() throws {
        let value: OnebaseValue = ["b": 1, "a": 2]
        XCTAssertTrue(try value.canonicalJSON.hasPrefix(#"{"a":2,"b":1}"#))
    }

    func testFromCodable() throws {
        struct Note: Codable { let text: String; let size: Int }
        let value = try OnebaseValue(Note(text: "hello", size: 4))
        XCTAssertEqual(value["text"]?.string, "hello")
        XCTAssertEqual(value["size"]?.int, 4)
    }
}
