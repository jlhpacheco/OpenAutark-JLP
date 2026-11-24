// Schutzregeln (wie Guard im Windows-Helfer, B-044 und Sicher-Runde 19.11.2026):
//  - Fenster der Autark-App (config.appPids): ein Klick/Drücken in ihrem Rechteck, Tasten bei ihrem Tastaturfokus und Elementaktionen
//    in ihren Fenstern antworten mit 'app_window' (und dem, was getroffen würde), bis die Anfrage `app` trägt (die Laufzeit hat freigegeben).
//  - Gewählte Apps (config.apps, Namen klein geschrieben): Eingabe erreicht nur Fenster dieser Prozesse; null = alle.
// Besitzt: diese Regeln. Nie: Eingaben senden oder Fenster ändern. Ein Lesefehler zählt als „weiß nicht“, nie als „kein Autark-Fenster“.

import ApplicationServices
import AppKit
import Foundation

public final class Guard {
    public var appPids = Set<pid_t>()
    public var apps: Set<String>?

    public init() {}

    /// Alle Namen, unter denen die Laufzeit eine App kennen kann (klein, ohne .app/.exe).
    static func names(of pid: pid_t) -> [String] {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return [] }
        var out: [String] = []
        for raw in [app.localizedName, app.executableURL?.lastPathComponent, app.bundleURL?.deletingPathExtension().lastPathComponent] {
            guard let raw = raw else { continue }
            let name = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if !name.isEmpty && !out.contains(name) { out.append(name) }
        }
        return out
    }

    /// Eingabe für einen Prozess außerhalb der gewählten Apps wird abgelehnt (Autark selbst regelt appPids).
    public func listed(pid: pid_t) throws {
        guard let apps = apps, !appPids.contains(pid) else { return }
        let names = Guard.names(of: pid)
        if names.contains(where: { apps.contains($0) }) { return }
        throw HelperError("forbidden", "That input would reach \(names.first ?? "a window whose app I cannot tell"), which is not among the apps open to me in this company. With its window named (computer.windows lists it), the app asks for it.")
    }

    func appRects() -> [CGRect] {
        guard !appPids.isEmpty else { return [] }
        var rects: [CGRect] = []
        for entry in WindowTable.windowInfo([.optionOnScreenOnly]) {
            guard let pid = WindowTable.owner(entry), appPids.contains(pid), let frame = WindowTable.bounds(entry) else { continue }
            rects.append(frame)
        }
        return rects
    }

    func owner(at point: CGPoint) -> pid_t? {
        for entry in WindowTable.windowInfo([.optionOnScreenOnly]) where WindowTable.layer(entry) == 0 {
            if let frame = WindowTable.bounds(entry), frame.contains(point) { return WindowTable.owner(entry) }
        }
        return nil
    }

    /// Ein Drücken/Loslassen bei (x, y) in Pixeln.
    public func checkPoint(x: Int, y: Int, cleared: Bool) throws {
        let point = CGPoint(x: Screen.pt(x), y: Screen.pt(y))
        if !cleared, appRects().contains(where: { $0.contains(point) }) {
            throw HelperError("app_window", "This point lies on (or under) an Autark window: its guarded controls are checked first.", app: ["point": ["x": x, "y": y]])
        }
        if apps != nil, let pid = owner(at: point) { try listed(pid: pid) }
    }

    /// Das Fenster mit dem Tastaturfokus gehört der Autark-App oder einer nicht gewählten App.
    public func checkKeyboard(cleared: Bool) throws {
        guard !appPids.isEmpty || apps != nil else { return }
        guard let pid = frontPid() else {
            throw HelperError("forbidden", "No window is known to have the keyboard, so nothing is typed (it could reach a control of the Autark app that needs the person). Focus the target window first (computer.focus_window).")
        }
        if appPids.contains(pid) && !cleared {
            throw HelperError("app_window", "The Autark window has the keyboard: its focused control is checked first.", app: ["keyboard": true])
        }
        try listed(pid: pid)
    }

    /// Eine Elementaktion in einem Fenster von `pid`.
    public func checkElement(pid: pid_t, rect: CGRect?, cleared: Bool) throws {
        if appPids.contains(pid) && !cleared {
            var hit: JSON = [:]
            if let rect = rect, rect.width > 0, rect.height > 0 { hit["rect"] = Screen.pxRect(rect) }
            throw HelperError("app_window", "That element is in the Autark window: its guarded controls are checked first.", app: hit)
        }
        try listed(pid: pid)
    }

    func frontPid() -> pid_t? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, AX.timeout)
        if let app = AX.element(system, "AXFocusedApplication") {
            let pid = AX.pid(app)
            if pid > 0 { return pid }
        }
        for entry in WindowTable.windowInfo([.optionOnScreenOnly]) where WindowTable.layer(entry) == 0 {
            if let pid = WindowTable.owner(entry) { return pid }
        }
        return nil
    }
}
