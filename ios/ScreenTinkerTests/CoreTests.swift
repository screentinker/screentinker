import XCTest
@testable import ScreenTinker

final class PlayerURLTests: XCTestCase {
    func testTypedAddressesBecomeAnOrigin() throws {
        XCTAssertEqual(try PlayerURL.origin(from: "signs.example.com").get().absoluteString, "https://signs.example.com")
        XCTAssertEqual(try PlayerURL.origin(from: "  HTTPS://Signs.Example.com/app#/login?x=1 ").get().absoluteString,
                       "https://signs.example.com")
        XCTAssertEqual(try PlayerURL.origin(from: "http://10.0.0.5:3001/player").get().absoluteString, "http://10.0.0.5:3001")
        XCTAssertEqual(try PlayerURL.origin(from: "https://user:pw@signs.example.com").get().absoluteString,
                       "https://signs.example.com", "credentials in the address are dropped")
    }

    func testRefusals() {
        XCTAssertEqual(PlayerURL.origin(from: "   "), .failure(.empty))
        XCTAssertEqual(PlayerURL.origin(from: "ftp://signs.example.com"), .failure(.notHTTP))
        XCTAssertEqual(PlayerURL.origin(from: "javascript://alert(1)"), .failure(.notHTTP))
        XCTAssertEqual(PlayerURL.origin(from: "https://"), .failure(.noHost))
    }

    func testThePlayerURLCarriesTheHostTag() throws {
        let origin = try PlayerURL.origin(from: "https://signs.example.com").get()
        XCTAssertEqual(PlayerURL.player(for: origin).absoluteString, "https://signs.example.com/player?host=ios")
    }

    func testSameOrigin() throws {
        let origin = try PlayerURL.origin(from: "https://signs.example.com").get()
        XCTAssertTrue(PlayerURL.isSameOrigin(URL(string: "https://signs.example.com:443/player?x")!, as: origin))
        XCTAssertFalse(PlayerURL.isSameOrigin(URL(string: "http://signs.example.com/player")!, as: origin))
        XCTAssertFalse(PlayerURL.isSameOrigin(URL(string: "https://evil.example.com/player")!, as: origin))
    }

    func testAnotherServersPlayerIsNotAMoveUnlessTheShellLoadedIt() throws {
        let origin = try PlayerURL.origin(from: "https://signs.example.com").get()
        let evil = URL(string: "https://evil.example/player?k=abc&host=ios")!
        // A frame navigating the top window (a web overlay) cannot move the sign, tagged or not.
        XCTAssertEqual(PlayerURL.decide(evil, current: origin, shellLoadInFlight: false), .cancel)
        XCTAssertEqual(PlayerURL.decide(URL(string: "https://evil.example/player?k=abc")!, current: origin, shellLoadInFlight: false), .cancel)
        XCTAssertEqual(PlayerURL.decide(URL(string: "https://evil.example/")!, current: origin, shellLoadInFlight: true), .cancel)
        // A server redirect of the shell's own load (http -> https, a renamed host) is followed and adopted.
        XCTAssertEqual(PlayerURL.decide(evil, current: origin, shellLoadInFlight: true),
                       .adopt(URL(string: "https://evil.example")!))
        XCTAssertEqual(PlayerURL.decide(URL(string: "https://evil.example/player")!, current: origin, shellLoadInFlight: true),
                       .retag(URL(string: "https://evil.example/player?host=ios")!))
    }

    func testOnTheSameServer() throws {
        let origin = try PlayerURL.origin(from: "https://signs.example.com").get()
        XCTAssertEqual(PlayerURL.decide(URL(string: "https://signs.example.com/player?host=ios")!, current: origin, shellLoadInFlight: false), .allow)
        XCTAssertEqual(PlayerURL.decide(URL(string: "https://signs.example.com/player?reset=1")!, current: origin, shellLoadInFlight: false),
                       .retag(URL(string: "https://signs.example.com/player?reset=1&host=ios")!))
        XCTAssertEqual(PlayerURL.decide(URL(string: "https://signs.example.com/api/x")!, current: origin, shellLoadInFlight: false), .allow)
        XCTAssertEqual(PlayerURL.decide(URL(string: "about:blank")!, current: origin, shellLoadInFlight: false), .allow)
    }

    func testMoveTarget() {
        XCTAssertEqual(PlayerURL.moveTarget(from: "https://new.example.com/player?k=K1&host=ios")?.absoluteString,
                       "https://new.example.com/player?k=K1&host=ios")
        XCTAssertEqual(PlayerURL.moveTarget(from: "http://10.0.0.5:3001/player?k=K1")?.absoluteString,
                       "http://10.0.0.5:3001/player?k=K1&host=ios")
        XCTAssertNil(PlayerURL.moveTarget(from: "https://new.example.com/app"), "only a player page")
        XCTAssertNil(PlayerURL.moveTarget(from: "javascript:alert(1)//player"))
        XCTAssertNil(PlayerURL.moveTarget(from: "file:///player"))
    }

    func testThePairingGoesOnlyToTheServerThatIssuedIt() throws {
        let origin = try PlayerURL.origin(from: "https://signs.example.com").get()
        let page = PlayerURL.origin(scheme: "https", host: "signs.example.com", port: 0)
        XCTAssertEqual(page, origin)
        XCTAssertTrue(PlayerURL.releasesIdentity(boundTo: "https://signs.example.com", page: page, shell: origin))
        XCTAssertFalse(PlayerURL.releasesIdentity(boundTo: "https://old.example.com", page: page, shell: origin), "moved since")
        XCTAssertFalse(PlayerURL.releasesIdentity(boundTo: nil, page: page, shell: origin), "unbound")
        XCTAssertFalse(PlayerURL.releasesIdentity(boundTo: "https://signs.example.com", page: nil, shell: origin))
        let evil = PlayerURL.origin(scheme: "https", host: "evil.example", port: 0)
        XCTAssertFalse(PlayerURL.releasesIdentity(boundTo: "https://signs.example.com", page: evil, shell: origin))
        XCTAssertEqual(PlayerURL.origin(scheme: "HTTP", host: "10.0.0.5", port: 3001)?.absoluteString, "http://10.0.0.5:3001")
    }
}

final class HostProtocolTests: XCTestCase {
    func testParsesThePagesMessages() {
        XCTAssertEqual(HostProtocol.parse(#"{"source":"screentinker-player","type":"host:hello"}"#), .hello)
        XCTAssertEqual(HostProtocol.parse(["source": "screentinker-player", "type": "host:command", "action": "restart"]), .restart)
        XCTAssertEqual(HostProtocol.parse(#"{"source":"screentinker-player","type":"host:command","action":"set-identity","payload":{"deviceId":"d1","deviceToken":"t1"}}"#),
                       .setIdentity(deviceId: "d1", deviceToken: "t1"))
        XCTAssertEqual(HostProtocol.parse(#"{"source":"screentinker-player","type":"host:command","action":"clear-identity"}"#), .clearIdentity)
        XCTAssertEqual(HostProtocol.parse(#"{"source":"screentinker-player","type":"host:command","action":"move-server","payload":{"url":"https://n.example/player?k=1"}}"#),
                       .moveServer(url: "https://n.example/player?k=1"))
        XCTAssertEqual(HostProtocol.parse(#"{"source":"screentinker-player","type":"host:command","action":"move-server"}"#), .unknown("move-server"))
    }

    func testIgnoresAnythingElse() {
        XCTAssertNil(HostProtocol.parse(#"{"source":"somebody-else","type":"host:hello"}"#), "not from the player")
        XCTAssertNil(HostProtocol.parse("not json"))
        XCTAssertNil(HostProtocol.parse(42))
        // An id without its token is never stored: that is the duplicate-row bug.
        XCTAssertEqual(HostProtocol.parse(#"{"source":"screentinker-player","type":"host:command","action":"set-identity","payload":{"deviceId":"d1"}}"#),
                       .unknown("set-identity"))
        XCTAssertEqual(HostProtocol.parse(#"{"source":"screentinker-player","type":"host:command","action":"reboot"}"#), .unknown("reboot"))
    }

    func testReadyAnnouncesNoCapabilitiesAndBothHalvesOfThePairingOrNeither() {
        let full = HostProtocol.ready(.init(version: "2.4.3", model: "iPad (iPad13,1)", os: "iPadOS 17.5", deviceId: "d1", deviceToken: "t1"))
        XCTAssertEqual(full["type"] as? String, "host:ready")
        XCTAssertEqual(full["source"] as? String, "screentinker-host")
        XCTAssertEqual((full["capabilities"] as? [String])?.count, 0)
        let info = full["info"] as? [String: Any]
        XCTAssertEqual(info?["deviceId"] as? String, "d1")
        XCTAssertEqual(info?["deviceToken"] as? String, "t1")
        let half = HostProtocol.ready(.init(version: "2.4.3", model: "iPad", os: "iPadOS", deviceId: "d1", deviceToken: nil))
        XCTAssertNil((half["info"] as? [String: Any])?["deviceId"])
    }

    func testDeliveryScriptCannotBeBrokenOutOf() throws {
        let hostile: [String: Any] = ["source": "screentinker-host", "type": "host:result", "action": "x'); alert(1); ('", "ok": false]
        let js = try XCTUnwrap(HostProtocol.deliveryScript(hostile))
        XCTAssertTrue(js.hasPrefix("window.postMessage(\""))
        XCTAssertTrue(js.hasSuffix("\", '*');"))
        // The payload is ONE JS string literal: decoding the argument gives back the JSON we sent.
        let inner = String(js.dropFirst("window.postMessage(".count).dropLast(", '*');".count))
        let decoded = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data("[\(inner)]".utf8)) as? [String])
        let round = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(decoded[0].utf8)) as? [String: Any])
        XCTAssertEqual(round["action"] as? String, "x'); alert(1); ('")
    }
}
