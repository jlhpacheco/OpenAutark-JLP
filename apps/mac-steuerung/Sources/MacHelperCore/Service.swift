// Der Helfer als Ganzes: ordnet jede Protokoll-Operation (protocol.ts, HelperOp) einer Antwort zu – wie linux-helper.py,
// nur über AX (Semantik) und CGEvent (Eingabe). Besitzt: die Operationen, die Rechte-Vorprüfung, die Antwortformen.
// Nie: etwas anderes als Protokollzeilen auf stdout schreiben (LoopRunner.swift), Eingaben wiederholen oder Schutzregeln umgehen.

import ApplicationServices
import AppKit
import Foundation

final class HelperIO: PathIO {
    let input: Input
    let rules: Guard
    let cleared: Bool

    init(input: Input, rules: Guard, cleared: Bool) {
        self.input = input
        self.rules = rules
        self.cleared = cleared
    }

    func move(_ x: Int, _ y: Int) { input.move(x, y) }
    func press(_ x: Int, _ y: Int, button: Int, down: Bool, clickState: Int) { input.press(x, y, button: button, down: down, clickState: clickState) }
    func pointer() -> (x: Int, y: Int)? { input.pointer() }
    func pause(_ ms: Double) { input.pause(ms) }

    func wheel(dx: Int, dy: Int) {
        for _ in 0..<abs(dy) { input.scroll(dx: 0, dy: dy < 0 ? -1 : 1); input.pause(10) }
        for _ in 0..<abs(dx) { input.scroll(dx: dx < 0 ? -1 : 1, dy: 0); input.pause(10) }
    }

    func guardPoints(_ points: [(Int, Int)]) throws {
        for point in points { try rules.checkPoint(x: point.0, y: point.1, cleared: cleared) }
    }
}

public final class HelperService {
    public static let protocolVersion = 4

    let table = WindowTable()
    let rules = Guard()
    public let input = Input()

    public init() {}

    static let needsTrust: Set<String> = ["windows", "focus_window", "tree", "find", "focused", "act", "click", "move", "path", "scroll", "type", "key"]

    public func handle(_ op: String, _ a: Args) throws -> Any {
        if HelperService.needsTrust.contains(op) { try Permission.require() }
        switch op {
        case "ping":
            return JSON()
        case "config":
            let pids = (a.list("appPids") ?? []).compactMap { Args.number($0) }.map { pid_t($0) }
            rules.appPids = Set(pids)
            table.appPids = rules.appPids
            if let apps = a.list("apps") {
                rules.apps = Set(apps.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty })
            } else {
                rules.apps = nil
            }
            return JSON()
        case "presence":
            return input.presence()
        case "screens":
            return Screen.screens()
        case "windows":
            return table.list()
        case "focus_window":
            let ref = try table.lookup(a.int("hwnd") ?? 0)
            try rules.listed(pid: ref.pid)
            return ["focused": table.focus(ref)] as JSON
        case "tree":
            return try tree(a, search: false)
        case "find":
            return try tree(a, search: true)
        case "focused":
            return try focused()
        case "act":
            return try act(a)
        case "click":
            guard let x = a.int("x"), let y = a.int("y") else { throw HelperError("bad_request", "x and y are required.") }
            guard let button = Input.buttonNumber(a.string("button")) else { throw HelperError("bad_request", "button must be left, right or middle.") }
            try onScreen(x, y)
            try rules.checkPoint(x: x, y: y, cleared: a.bool("app"))
            input.click(x, y, button: button, count: max(1, min(3, a.int("count", 1))))
            return pointResult(x, y)
        case "move":
            guard let x = a.int("x"), let y = a.int("y") else { throw HelperError("bad_request", "x and y are required.") }
            try onScreen(x, y)
            input.move(x, y)
            return JSON()
        case "path":
            let result = try PathMotion.run(a, HelperIO(input: input, rules: rules, cleared: a.bool("app")))
            if a.string("end") == "click" || a.string("end") == "drag", let at = result["at"] as? [Int], at.count == 2 {
                return pointResult(at[0], at[1], base: result)
            }
            return result
        case "scroll":
            let dx = max(-50, min(50, a.int("dx", 0)))
            let dy = max(-50, min(50, a.int("dy", 0)))
            if a.has("x") && a.has("y") {
                guard let x = a.int("x"), let y = a.int("y") else { throw HelperError("bad_request", "x and y must be numbers.") }
                try onScreen(x, y)
                input.move(x, y)
                input.pause(10)
            }
            input.scroll(dx: dx, dy: dy)
            return JSON()
        case "type":
            let text = a.string("text") ?? ""
            guard !text.isEmpty, text.utf16.count <= 5000 else { throw HelperError("bad_request", "text must have 1 to 5000 characters.") }
            try rules.checkKeyboard(cleared: a.bool("app"))
            input.type(text)
            return JSON()
        case "key":
            let vks = (a.list("vks") ?? []).compactMap { Args.number($0) }.map { Int($0) }
            guard !vks.isEmpty else { throw HelperError("bad_request", "Name a key, e.g. \"enter\" or \"cmd+s\".") }
            try rules.checkKeyboard(cleared: a.bool("app"))
            try input.chord(vks, repeat: max(1, min(50, a.int("repeat", 1))))
            return JSON()
        case "release":
            return ["released": input.release()] as JSON
        case "cursor":
            return cursor()
        case "screenshot", "ocr":
            throw HelperError("unavailable", "Not available from the macOS helper; the desktop app captures the screen.")
        default:
            throw HelperError("bad_request", "Unknown op \(op).")
        }
    }

    // MARK: Punkte und Zeiger

    func onScreen(_ x: Int, _ y: Int) throws {
        let bounds = Screen.virtualBounds()
        let point = CGPoint(x: Screen.pt(x), y: Screen.pt(y))
        if !bounds.contains(point) {
            throw HelperError("bad_request", "The point (\(x), \(y)) is outside the screen (\(Screen.px(bounds.minX)),\(Screen.px(bounds.minY)) \(Screen.px(bounds.width))x\(Screen.px(bounds.height))).")
        }
    }

    /// Antwort eines Zeigerschritts: wo, und das Fenster darunter (die Laufzeit merkt es sich für die Leihe).
    func pointResult(_ x: Int, _ y: Int, base: JSON = [:]) -> JSON {
        var out = base
        out["x"] = x
        out["y"] = y
        if let hit = table.windowAt(CGPoint(x: Screen.pt(x), y: Screen.pt(y))) {
            out["window"] = hit.id
            if !hit.title.isEmpty { out["title"] = hit.title }
        }
        return out
    }

    func cursor() -> JSON {
        guard let at = input.pointer() else { return ["idleUnknown": true] }
        var out = input.presence()
        out["x"] = at.x
        out["y"] = at.y
        let idle = out["idleMs"] as? Int
        let ours = out["injectedAgoMs"] as? Int
        // Der Zeiger des Menschen (pointer-input.ts): seine Eingabe ist neuer als unsere; dann das Fenster darunter nennen.
        if let idle = idle, idle < 300_000, ours == nil || idle + 150 < (ours ?? 0), let title = titleUnder(at) {
            out["window"] = clip(title, 120)
        }
        return out
    }

    func titleUnder(_ at: (x: Int, y: Int)) -> String? {
        guard AXIsProcessTrusted() else { return nil }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, AX.timeout)
        var found: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(Screen.pt(at.x)), Float(Screen.pt(at.y)), &found) == .success, let hit = found else { return nil }
        let window = AX.element(hit, "AXWindow") ?? hit
        guard let title = AX.string(window, "AXTitle"), !title.isEmpty else { return nil }
        return title
    }

    // MARK: Baum und Suche

    func frontOrNamed(_ a: Args) throws -> WindowRef {
        if let hwnd = a.int("hwnd"), hwnd != 0 { return try table.lookup(hwnd) }
        guard let front = table.foreground() else { throw HelperError("not_found", "No window is in front. Name one (window).") }
        return front
    }

    func tree(_ a: Args, search: Bool) throws -> JSON {
        let ref = try frontOrNamed(a)
        let title = clip(AX.string(ref.element, "AXTitle") ?? "", 200)
        if search {
            let name = (a.string("name") ?? "").lowercased()
            let identifier = a.string("aid") ?? ""
            let role = a.string("role") ?? ""
            let result = AX.walk(ref.element, maxDepth: AX.maxDepth, maxNodes: 4000) { element in
                if !name.isEmpty {
                    let raw = AX.string(element, "AXRole") ?? "AXUnknown"
                    if !AX.name(element, rawRole: raw).lowercased().contains(name) { return false }
                }
                if !role.isEmpty && AX.role(of: element) != role { return false }
                if !identifier.isEmpty && (AX.string(element, "AXIdentifier") ?? "") != identifier { return false }
                return true
            }
            let limit = max(1, min(100, a.int("max", 20)))
            return ["hwnd": ref.hwnd, "nodes": Array(result.nodes.prefix(limit)), "truncated": result.truncated || result.nodes.count > limit] as JSON
        }
        let depth = max(1, min(AX.maxDepth, a.int("depth", 12)))
        let maxNodes = max(20, min(AX.maxNodes, a.int("maxNodes", 400)))
        let result = AX.walk(ref.element, maxDepth: depth, maxNodes: maxNodes)
        return ["hwnd": ref.hwnd, "title": title, "nodes": result.nodes, "truncated": result.truncated] as JSON
    }

    /// Das Element mit dem Tastaturfokus (B-080) als ein Knoten, aufrufbar mit act() über seinen Indexpfad im Fenster.
    func focused() throws -> JSON {
        guard let front = table.foreground() else { return ["hwnd": 0, "nodes": [JSON]()] as JSON }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, AX.timeout)
        var nodes: [JSON] = []
        if let appElement = AX.element(system, "AXFocusedApplication"), let focus = AX.element(appElement, "AXFocusedUIElement"),
           let path = AX.path(of: focus, in: front.element) {
            nodes.append(AX.node(focus, depth: 0, parent: -1, rid: path, bounds: Screen.virtualBounds()))
        }
        return ["hwnd": front.hwnd, "nodes": nodes] as JSON
    }

    // MARK: Elementaktionen

    func centre(of element: AXUIElement) throws -> (Int, Int) {
        guard let frame = AX.rect(element), frame.width > 0, frame.height > 0 else {
            throw HelperError("unavailable", "This element has no position on the screen. Scroll it into view first.")
        }
        return (Screen.px(frame.midX), Screen.px(frame.midY))
    }

    func press(_ element: AXUIElement) throws {
        let names = AX.actions(element)
        for name in ["AXPress", "AXPick", "AXConfirm"] where names.contains(name) {
            if AX.perform(element, name) { return }
        }
        throw HelperError("unavailable", "This element offers no action. Try click.")
    }

    func select(_ element: AXUIElement) throws {
        if AX.settable(element, "AXSelected") && AX.set(element, "AXSelected", kCFBooleanTrue) { return }
        if let parent = AX.element(element, "AXParent"), AX.settable(parent, "AXSelectedRows"),
           AX.set(parent, "AXSelectedRows", [element] as NSArray) { return }
        try press(element)
    }

    func setOpen(_ element: AXUIElement, open wanted: Bool) throws {
        let attribute = AX.bool(element, "AXDisclosing") != nil ? "AXDisclosing" : (AX.bool(element, "AXExpanded") != nil ? "AXExpanded" : nil)
        if let attribute = attribute {
            if AX.bool(element, attribute) == wanted { return }
            if AX.settable(element, attribute), AX.set(element, attribute, wanted ? kCFBooleanTrue : kCFBooleanFalse) { return }
        }
        if AX.actions(element).contains("AXPress"), AX.perform(element, "AXPress") { return }
        throw HelperError("unavailable", "This element cannot be \(wanted ? "expanded" : "collapsed").")
    }

    func windowButton(_ window: AXUIElement, _ attribute: String, _ what: String) throws {
        guard let button = AX.element(window, attribute), AX.perform(button, "AXPress") else {
            throw HelperError("unavailable", "This window cannot be \(what).")
        }
    }

    func act(_ a: Args) throws -> JSON {
        let action = a.string("action") ?? ""
        let cleared = a.bool("app")
        let ref = try frontOrNamed(a)
        let windowStep = action.hasPrefix("window_")
        var element = ref.element
        var rid = ""
        if windowStep {
            rid = ""
        } else if let given = a.string("rid") {
            rid = given
            element = try AX.resolve(ref.element, rid: given)
        } else {
            let wantName = a.string("name") ?? ""
            let wantId = a.string("aid") ?? ""
            let wantRole = a.string("role") ?? ""
            let hits = AX.walk(ref.element, maxDepth: AX.maxDepth, maxNodes: 400) { candidate in
                if !wantName.isEmpty && AX.name(candidate, rawRole: AX.string(candidate, "AXRole") ?? "AXUnknown") != wantName { return false }
                if !wantRole.isEmpty && AX.role(of: candidate) != wantRole { return false }
                if !wantId.isEmpty && (AX.string(candidate, "AXIdentifier") ?? "") != wantId { return false }
                return true
            }.nodes
            guard hits.count == 1 else {
                throw HelperError(hits.isEmpty ? "not_found" : "conflict", hits.isEmpty ? "No element matches." : "\(hits.count) elements match. Use a ref.")
            }
            rid = (hits[0]["rid"] as? String) ?? ""
            element = try AX.resolve(ref.element, rid: rid)
        }
        let rawRole = AX.string(element, "AXRole") ?? "AXUnknown"
        if let expectedName = a.string("expectName") {
            let current = AX.name(element, rawRole: rawRole)
            if current != expectedName {
                throw HelperError("conflict", "The element changed: expected \"\(clip(expectedName, 80))\" but found \"\(clip(current, 80))\". Observe again before acting.")
            }
        }
        if let expectedRole = a.string("expectRole") {
            let current = AX.role(of: element)
            if current != expectedRole {
                throw HelperError("conflict", "The element changed: expected a \(expectedRole) but found a \(current). Observe again before acting.")
            }
        }
        if action != "scroll" && action != "scroll_into_view" {
            try rules.checkElement(pid: ref.pid, rect: AX.rect(element), cleared: cleared)
        }

        var clicked: [Int]?
        let value = a.string("value")
        switch action {
        case "invoke":
            try press(element)
        case "select":
            try select(element)
        case "toggle":
            let on = (AX.number(element, "AXValue") ?? 0) != 0
            if value != "on" && value != "off" || (value == "on") != on { try press(element) }
        case "expand", "collapse":
            try setOpen(element, open: action == "expand")
        case "set_value":
            guard AX.settable(element, "AXValue") else { throw HelperError("unavailable", "This element has no editable value.") }
            let text = value ?? ""
            let role = AX.role(of: element)
            let done: Bool
            if ["slider", "spinner", "progressbar"].contains(role), let number = Double(text) {
                done = AX.set(element, "AXValue", NSNumber(value: number))
            } else {
                done = AX.set(element, "AXValue", text as CFString)
            }
            if !done { throw HelperError("unavailable", "The element refused the value.") }
        case "focus":
            if !AX.set(element, "AXFocused", kCFBooleanTrue) { throw HelperError("unavailable", "This element cannot take the focus.") }
        case "scroll_into_view":
            if !AX.perform(element, "AXScrollToVisible") { throw HelperError("unavailable", "This element cannot be scrolled into view.") }
        case "scroll":
            let (x, y) = try centre(of: element)
            let direction = value ?? "down"
            let steps = direction.hasPrefix("page") ? 3 : 1
            input.move(x, y)
            input.pause(10)
            for _ in 0..<steps {
                switch direction {
                case "up", "page_up": input.scroll(dx: 0, dy: -1)
                case "left": input.scroll(dx: -1, dy: 0)
                case "right": input.scroll(dx: 1, dy: 0)
                default: input.scroll(dx: 0, dy: 1)
                }
                input.pause(10)
            }
        case "click", "double_click", "right_click":
            let (x, y) = try centre(of: element)
            let button = action == "right_click" ? 1 : 0
            let count = action == "double_click" ? 2 : 1
            if let planned = a.dict("path") {
                let io = HelperIO(input: input, rules: rules, cleared: cleared)
                try io.guardPoints([(x, y)])
                try PathMotion.elementClick(Args(planned), x: x, y: y, io, button: button, count: count)
            } else {
                try rules.checkPoint(x: x, y: y, cleared: cleared)
                input.click(x, y, button: button, count: count)
            }
            clicked = [x, y]
        case "window_close":
            try windowButton(element, "AXCloseButton", "closed")
        case "window_minimize":
            if !AX.set(element, "AXMinimized", kCFBooleanTrue) { try windowButton(element, "AXMinimizeButton", "minimized") }
        case "window_maximize":
            try windowButton(element, "AXZoomButton", "maximized")
        case "window_restore":
            if AX.bool(element, "AXMinimized") == true {
                if !AX.set(element, "AXMinimized", kCFBooleanFalse) { throw HelperError("unavailable", "This window cannot be restored.") }
            } else {
                try windowButton(element, "AXZoomButton", "restored")
            }
        default:
            throw HelperError(windowStep ? "unavailable" : "bad_request", "Not available on macOS: \(action).")
        }

        input.pause(Double(min(3000, max(0, a.int("settleMs", 250)))))
        var waited = 0
        if let expect = a.dict("expect"), !expect.isEmpty {
            while !satisfied(expect, element: element, rid: rid) && waited < 2000 {
                input.pause(100)
                waited += 100
            }
        }
        let exists = AX.string(element, "AXRole") != nil
        var out: JSON = ["exists": exists]
        if exists { out["element"] = AX.node(element, depth: 0, parent: -1, rid: rid, bounds: Screen.virtualBounds()) }
        if let front = table.foreground() { out["foreground"] = ["title": AX.string(front.element, "AXTitle") ?? ""] as JSON }
        if let at = clicked { out["at"] = at }
        if waited > 0 { out["waitedMs"] = waited }
        return out
    }

    /// Zeigt das Element schon den erwarteten Zustand (value, toggle, expanded, selected, gone)? Fensterziele prüft die Laufzeit.
    func satisfied(_ expect: JSON, element: AXUIElement, rid: String) -> Bool {
        let alive = AX.string(element, "AXRole") != nil
        if (expect["gone"] as? NSNumber)?.boolValue == true { return !alive }
        guard alive else { return false }
        let node = AX.node(element, depth: 0, parent: -1, rid: rid, bounds: Screen.virtualBounds())
        if let wanted = expect["value"] as? String {
            let current = (node["value"] as? String) ?? (node["value"] as? Double).map { String($0) } ?? ""
            if current != wanted { return false }
        }
        if let wanted = expect["toggle"] as? String, (node["toggle"] as? String) != wanted { return false }
        if let wanted = expect["expanded"] as? NSNumber, ((node["expand"] as? String) == "expanded") != wanted.boolValue { return false }
        if let wanted = expect["selected"] as? NSNumber, ((node["selected"] as? Bool) ?? false) != wanted.boolValue { return false }
        return true
    }
}
