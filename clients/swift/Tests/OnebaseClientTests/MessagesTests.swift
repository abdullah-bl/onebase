import XCTest
@testable import OnebaseClient

final class MessagesTests: XCTestCase {
    func testOutgoing() {
        // Outgoing JSON is canonical (sorted keys), so encodings are stable to assert on.
        XCTAssertEqual(Outgoing.auth(token: nil), #"{"token":null,"type":"auth"}"#)
        XCTAssertEqual(Outgoing.auth(token: "ob_s_1"), #"{"token":"ob_s_1","type":"auth"}"#)
        XCTAssertEqual(Outgoing.unsub(id: 4), #"{"id":4,"type":"unsub"}"#)
        let call = Outgoing.call(requestId: 2, kind: "mutation", path: "notes:add", args: ["text": "hi"])
        let value = try! JSONDecoder().decode(OnebaseValue.self, from: Data(call.utf8))
        XCTAssertEqual(value["type"]?.string, "call")
        XCTAssertEqual(value["kind"]?.string, "mutation")
        XCTAssertEqual(value["args", "text"]?.string, "hi")
    }

    func testIncoming() throws {
        guard case .auth(let ok, let ended, let subject, _) = Incoming.parse(#"{"type":"auth","ok":true,"identity":null}"#) else {
            return XCTFail("not an auth message")
        }
        XCTAssertTrue(ok)
        XCTAssertFalse(ended)
        XCTAssertNil(subject)

        guard case .update(let update) = Incoming.parse(#"{"type":"update","id":7,"ok":true,"value":[1,2]}"#) else {
            return XCTFail("not an update")
        }
        XCTAssertEqual(update.id, 7)
        XCTAssertEqual(update.value?.array?.count, 2)

        guard case .callResult(let result) = Incoming.parse(#"{"type":"result","requestId":9,"ok":false,"error":"nope"}"#) else {
            return XCTFail("not a result")
        }
        XCTAssertEqual(result.requestId, 9)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "nope")

        guard case .transition(let updates, let results) = Incoming.parse(
            #"{"type":"transition","updates":[{"id":1,"ok":true,"value":5}],"results":[{"requestId":3,"ok":true,"value":null}]}"#
        ) else {
            return XCTFail("not a transition")
        }
        XCTAssertEqual(updates.count, 1)
        XCTAssertEqual(updates.first?.value?.int, 5)
        XCTAssertEqual(results.first?.requestId, 3)
    }

    func testGarbageIsIgnored() {
        XCTAssertNil(Incoming.parse("not json"))
        XCTAssertNil(Incoming.parse(#"{"type":"mystery"}"#))
    }
}
