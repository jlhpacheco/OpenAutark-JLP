// Tests ohne Bildschirm und ohne Bedienungshilfen-Recht: Draht-Format, Argumente, Tastentabellen, Rollen, Pfadlogik mit Fake-Eingabe
// und die Antwortzeilen der Schleife. Was Rechte und echte Eingaben braucht, prüft der Selbsttest (selftest/drive.py).

import XCTest
@testable import MacHelperCore

final class WireTests: XCTestCase {
    func testAsciiEscapesNonAscii() {
        XCTAssertEqual(Wire.ascii("Größe"), "Gr\\u00f6\\u00dfe")
        XCTAssertEqual(Wire.ascii("😀"), "\\ud83d\\ude00")
        XCTAssertEqual(Wire.ascii("plain/slash"), "plain/slash")
    }

    func testOkLineHasIdAndResult() {
        let line = Wire.ok(id: 7, result: ["a": 1])
        let object = Wire.parse(line)
        XCTAssertEqual(object?["id"] as? Int, 7)
        XCTAssertEqual(object?["ok"] as? Bool, true)
        XCTAssertEqual((object?["result"] as? JSON)?["a"] as? Int, 1)
    }

    func testFailureCarriesCodeAndApp() {
        let line = Wire.failure(id: 3, error: HelperError("app_window", "x", app: ["keyboard": true]))
        let error = (Wire.parse(line)?["error"] as? JSON)
        XCTAssertEqual(error?["code"] as? String, "app_window")
        XCTAssertEqual((error?["app"] as? JSON)?["keyboard"] as? Bool, true)
    }

    func testArgsBooleanAndNumbers() {
        let args = Args(Wire.parse("{\"a\":true,\"n\":4.6,\"s\":\"x\",\"z\":0}") ?? [:])
        XCTAssertTrue(args.bool("a"))
        XCTAssertFalse(args.bool("z"))
        XCTAssertEqual(args.int("n"), 5)
        XCTAssertNil(args.double("a")) // ein Bool ist keine Zahl
        XCTAssertNil(args.int("s"))
    }
}

final class KeysTests: XCTestCase {
    func testModifiersCarryFlags() throws {
        XCTAssertEqual(try Keys.spec(vk: 0x5B).flag, .maskCommand)
        XCTAssertEqual(try Keys.spec(vk: 0x10).flag, .maskShift)
    }

    func testFixedKeys() throws {
        XCTAssertEqual(try Keys.spec(vk: 0x0D).code, 0x24) // Enter
        XCTAssertEqual(try Keys.spec(vk: 0x1B).code, 0x35) // Esc
        XCTAssertEqual(try Keys.spec(vk: 0x25).code, 0x7B) // Pfeil links
    }

    func testLetterUsesLayoutThenAnsi() throws {
        XCTAssertEqual(try Keys.spec(vk: 0x5A, layout: [UInt16(UInt8(ascii: "z")): 0x10]).code, 0x10) // QWERTZ: Z liegt auf der Y-Taste
        XCTAssertEqual(try Keys.spec(vk: 0x41).code, 0x00) // ANSI-Rückfall: A
    }

    func testUnknownKeyIsBadRequest() {
        XCTAssertThrowsError(try Keys.spec(vk: 0xFF)) { error in
            XCTAssertEqual((error as? HelperError)?.code, "bad_request")
        }
    }
}

final class RoleTests: XCTestCase {
    func testMapping() {
        XCTAssertEqual(AX.mapRole("AXButton", nil), "button")
        XCTAssertEqual(AX.mapRole("AXTextField", nil), "edit")
        XCTAssertEqual(AX.mapRole("AXRadioButton", "AXTabButton"), "tabitem")
        XCTAssertEqual(AX.mapRole("AXRow", "AXOutlineRow"), "treeitem")
        XCTAssertEqual(AX.mapRole("AXSomethingNew", nil), "somethingnew")
    }
}

final class FakeIO: PathIO {
    var events: [String] = []
    var here: (x: Int, y: Int)? = (0, 0)
    var drift: (x: Int, y: Int)? // setzt den Zeiger nach dem ersten Schritt woandershin (ein Mensch greift ein)
    var refused = false

    func move(_ x: Int, _ y: Int) {
        events.append("move \(x),\(y)")
        here = drift ?? (x, y)
    }
    func press(_ x: Int, _ y: Int, button: Int, down: Bool, clickState: Int) { events.append("\(down ? "down" : "up") \(button) \(x),\(y) #\(clickState)") }
    func pointer() -> (x: Int, y: Int)? { here }
    func wheel(dx: Int, dy: Int) { events.append("wheel \(dx),\(dy)") }
    func guardPoints(_ points: [(Int, Int)]) throws {
        if refused { throw HelperError("app_window", "guarded") }
    }
    func pause(_ ms: Double) {}
}

final class PathTests: XCTestCase {
    func args(_ json: String) -> Args { Args(Wire.parse(json) ?? [:]) }

    func testClickPressesAtLastStep() throws {
        let io = FakeIO()
        let result = try PathMotion.run(args("{\"steps\":[10,10,0,50,40,0],\"end\":\"click\",\"from\":[0,0]}"), io)
        XCTAssertEqual(result["done"] as? Bool, true)
        XCTAssertEqual(io.events.suffix(2), ["down 0 50,40 #1", "up 0 50,40 #1"])
    }

    func testDoubleClickCountsUp() throws {
        let io = FakeIO()
        _ = try PathMotion.run(args("{\"steps\":[5,5,0],\"end\":\"click\",\"count\":2}"), io)
        XCTAssertEqual(io.events.filter { $0.hasPrefix("down") }, ["down 0 5,5 #1", "down 0 5,5 #2"])
    }

    func testHumanMovedBeforePathIsRefused() {
        let io = FakeIO()
        io.here = (300, 300)
        XCTAssertThrowsError(try PathMotion.run(args("{\"steps\":[5,5,0],\"end\":\"click\",\"from\":[0,0]}"), io)) { error in
            XCTAssertEqual((error as? HelperError)?.code, "human_active")
        }
        XCTAssertFalse(io.events.contains(where: { $0.hasPrefix("down") }))
    }

    func testHumanMovingDuringPathStopsBeforePress() {
        let io = FakeIO()
        io.drift = (400, 400)
        XCTAssertThrowsError(try PathMotion.run(args("{\"steps\":[5,5,0,9,9,1,20,20,2],\"end\":\"click\"}"), io)) { error in
            XCTAssertEqual((error as? HelperError)?.code, "human_active")
        }
        XCTAssertFalse(io.events.contains(where: { $0.hasPrefix("down") }))
    }

    func testGuardRunsBeforeAnyMove() {
        let io = FakeIO()
        io.refused = true
        XCTAssertThrowsError(try PathMotion.run(args("{\"steps\":[5,5,0],\"end\":\"click\"}"), io))
        XCTAssertTrue(io.events.isEmpty)
    }

    func testDragAlwaysReleases() throws {
        let io = FakeIO()
        _ = try PathMotion.run(args("{\"steps\":[1,1,0],\"drag\":[1,1,0,30,30,0],\"end\":\"drag\"}"), io)
        XCTAssertEqual(io.events.filter { $0.hasPrefix("down") }.count, 1)
        XCTAssertEqual(io.events.filter { $0.hasPrefix("up") }.count, 1)
    }

    func testBadStepsAreRejected() {
        XCTAssertThrowsError(try PathMotion.steps(args("{\"steps\":[1,2]}"), "steps"))
        XCTAssertThrowsError(try PathMotion.steps(args("{\"steps\":[1,2,10,3,4,5]}"), "steps")) // t fällt
    }
}

final class LoopTests: XCTestCase {
    func testReadyLine() {
        let object = Wire.parse(LoopRunner.ready())
        XCTAssertEqual(object?["ready"] as? Bool, true)
        XCTAssertEqual(object?["protocol"] as? Int, 4)
    }

    func testPingAndUnknownOp() {
        let service = HelperService()
        XCTAssertEqual(Wire.parse(LoopRunner.respond("{\"id\":1,\"op\":\"ping\",\"args\":{}}", service))?["ok"] as? Bool, true)
        let bad = Wire.parse(LoopRunner.respond("{\"id\":2,\"op\":\"nope\",\"args\":{}}", service))
        XCTAssertEqual(bad?["ok"] as? Bool, false)
        XCTAssertEqual((bad?["error"] as? JSON)?["code"] as? String, "bad_request")
        XCTAssertEqual(bad?["id"] as? Int, 2)
    }

    func testGarbageLine() {
        let line = LoopRunner.respond("not json", HelperService())
        XCTAssertEqual(((Wire.parse(line)?["error"]) as? JSON)?["code"] as? String, "bad_request")
    }

    func testConfigSetsGuard() throws {
        let service = HelperService()
        _ = try service.handle("config", Args(["appPids": [123], "apps": ["Notes"]]))
        XCTAssertEqual(service.rules.appPids, [123])
        XCTAssertEqual(service.rules.apps, ["notes"])
        _ = try service.handle("config", Args(["appPids": [Int]()]))
        XCTAssertNil(service.rules.apps)
    }

    func testScreenshotIsNotServed() {
        XCTAssertThrowsError(try HelperService().handle("screenshot", Args([:]))) { error in
            XCTAssertEqual((error as? HelperError)?.code, "unavailable")
        }
    }

    func testMissingPermissionIsProtocolError() throws {
        try XCTSkipIf(Permission.trusted || Permission.skipCheck, "Dieser Prozess hat das Recht – der Fehlerweg ist hier nicht prüfbar.")
        setenv("AUTARK_MAC_NO_PROMPT", "1", 1)
        XCTAssertThrowsError(try HelperService().handle("tree", Args([:]))) { error in
            XCTAssertEqual((error as? HelperError)?.code, "unavailable")
            XCTAssertTrue((error as? HelperError)?.message.contains("Accessibility") ?? false)
        }
    }
}
