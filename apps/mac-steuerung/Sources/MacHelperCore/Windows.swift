// Fenster: die Fensterliste (op 'windows'), Fenster-Ids und das Fokussieren.
// Quelle der Fenster: AX (AXWindows je App mit Fenster); welche Apps Fenster haben, sagt CGWindowList (läuft ohne RunLoop,
// ohne Bildschirmaufnahme-Recht und liefert die Prozesse in Echtzeit – NSWorkspace.runningApplications altert in einem
// Kommandozeilenprozess ohne RunLoop). Fenster-Id = die CGWindowID (private, aber seit Jahren stabile Funktion
// _AXUIElementGetWindow, per dlsym gesucht – fehlt sie, zählt der Helfer selbst: eine Nummer je (pid, Index)).
// Besitzt: Fensterliste, Ids, Zwischenspeicher, Fokus. Nie: Eingaben erzeugen oder Sicherheitsregeln (Guard.swift) entscheiden.

import ApplicationServices
import AppKit
import Foundation

public struct WindowRef {
    public let hwnd: Int
    public let element: AXUIElement
    public let pid: pid_t
    public let process: String
}

public final class WindowTable {
    public var appPids = Set<pid_t>()
    private var synthetic: [String: Int] = [:]
    private var cache: [Int: WindowRef] = [:]
    private var prepared = Set<pid_t>()

    public init() {}

    typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

    static let getWindow: GetWindow? = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(symbol, to: GetWindow.self)
    }()

    // MARK: CGWindowList

    static func windowInfo(_ options: CGWindowListOption) -> [[String: Any]] {
        (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
    }

    static func bounds(_ entry: [String: Any]) -> CGRect? {
        guard let dictionary = entry[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
    }

    static func layer(_ entry: [String: Any]) -> Int { (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1 }

    static func owner(_ entry: [String: Any]) -> pid_t? {
        guard let number = entry[kCGWindowOwnerPID as String] as? NSNumber else { return nil }
        return pid_t(number.int32Value)
    }

    /// Prozesse mit Fenstern der Ebene 0, vorn zuerst, ohne den Helfer selbst.
    func candidatePids() -> [pid_t] {
        var seen = Set<pid_t>()
        var order: [pid_t] = []
        let me = getpid()
        for entry in WindowTable.windowInfo([.optionAll]) where WindowTable.layer(entry) == 0 {
            guard let pid = WindowTable.owner(entry), pid != me, !seen.contains(pid) else { continue }
            seen.insert(pid)
            order.append(pid)
        }
        return order
    }

    /// Das oberste sichtbare Fenster der Ebene 0 an einem Punkt (Punkte): Nummer und Titel (Titel nur, wenn das Fenster bekannt ist).
    public func windowAt(_ point: CGPoint) -> (id: Int, title: String)? {
        for entry in WindowTable.windowInfo([.optionOnScreenOnly]) where WindowTable.layer(entry) == 0 {
            guard let frame = WindowTable.bounds(entry), frame.contains(point),
                  let number = (entry[kCGWindowNumber as String] as? NSNumber)?.intValue else { continue }
            let title = cache[number].flatMap { AX.string($0.element, "AXTitle") } ?? ""
            return (number, clip(title, 200))
        }
        return nil
    }

    // MARK: Ids und Liste

    func windowID(_ element: AXUIElement, pid: pid_t, index: Int) -> Int {
        if let function = WindowTable.getWindow {
            var id: CGWindowID = 0
            if function(element, &id) == .success, id != 0 { return Int(id) }
        }
        let key = "\(pid):\(index)"
        if let known = synthetic[key] { return known }
        let next = 1_000_000_000 + synthetic.count + 1 // weit weg von echten CGWindowIDs
        synthetic[key] = next
        return next
    }

    static func processName(_ app: NSRunningApplication) -> String {
        app.localizedName ?? app.executableURL?.lastPathComponent ?? ""
    }

    /// Alle Fenster aller Apps mit Fenstern (AX).
    public func scan() -> [WindowRef] {
        var found: [WindowRef] = []
        var next: [Int: WindowRef] = [:]
        for pid in candidatePids() {
            guard let running = NSRunningApplication(processIdentifier: pid), running.activationPolicy == .regular, !running.isTerminated else { continue }
            let appElement = AX.app(pid)
            let process = WindowTable.processName(running)
            let windows = (AX.value(appElement, "AXWindows") as? [AXUIElement]) ?? []
            for (index, window) in windows.enumerated() where AX.string(window, "AXRole") == "AXWindow" {
                let ref = WindowRef(hwnd: windowID(window, pid: pid, index: index), element: window, pid: pid, process: process)
                found.append(ref)
                next[ref.hwnd] = ref
            }
        }
        cache = next
        return found
    }

    /// Chromium/Electron: AX-Baum einschalten, einmal je Prozess.
    public func prepare(_ pid: pid_t) {
        if prepared.insert(pid).inserted { AX.enableManual(AX.app(pid)) }
    }

    public func lookup(_ hwnd: Int) throws -> WindowRef {
        if let ref = cache[hwnd], AX.string(ref.element, "AXRole") != nil {
            prepare(ref.pid)
            return ref
        }
        if let ref = scan().first(where: { $0.hwnd == hwnd }) {
            prepare(ref.pid)
            return ref
        }
        throw HelperError("not_found", "The window is gone. List the windows again.")
    }

    /// Das Fenster mit dem Tastaturfokus (AXFocusedApplication → AXFocusedWindow), oder nil.
    public func foreground() -> WindowRef? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, AX.timeout)
        guard let appElement = AX.element(system, "AXFocusedApplication") else { return nil }
        let pid = AX.pid(appElement)
        guard let window = AX.element(appElement, "AXFocusedWindow") ?? AX.element(appElement, "AXMainWindow") else { return nil }
        let windows = (AX.value(appElement, "AXWindows") as? [AXUIElement]) ?? []
        let index = windows.firstIndex(where: { AX.same($0, window) }) ?? 0
        let process = NSRunningApplication(processIdentifier: pid).map { WindowTable.processName($0) } ?? ""
        let ref = WindowRef(hwnd: windowID(window, pid: pid, index: index), element: window, pid: pid, process: process)
        cache[ref.hwnd] = ref
        prepare(pid)
        return ref
    }

    public func list() -> [JSON] {
        let front = foreground()
        var out: [JSON] = []
        for ref in scan() {
            var item: JSON = [
                "hwnd": ref.hwnd, "title": clip(AX.string(ref.element, "AXTitle") ?? "", 200), "process": ref.process, "pid": Int(ref.pid),
                "minimized": AX.bool(ref.element, "AXMinimized") == true,
                "foreground": front.map { AX.same($0.element, ref.element) } ?? false,
                "app": appPids.contains(ref.pid),
            ]
            if let frame = AX.rect(ref.element) { item["rect"] = Screen.pxRect(frame) }
            out.append(item)
        }
        return out
    }

    /// Holt das Fenster nach vorn (aus dem Dock zurück, App aktivieren, anheben); sagt, ob es danach den Fokus hat.
    public func focus(_ ref: WindowRef) -> Bool {
        if AX.bool(ref.element, "AXMinimized") == true { AX.set(ref.element, "AXMinimized", kCFBooleanFalse) }
        _ = NSRunningApplication(processIdentifier: ref.pid)?.activate(options: [.activateIgnoringOtherApps])
        AX.perform(ref.element, "AXRaise")
        AX.set(ref.element, "AXMain", kCFBooleanTrue)
        AX.set(ref.element, "AXFocused", kCFBooleanTrue)
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
        guard let front = foreground() else { return false }
        return AX.same(front.element, ref.element)
    }
}
