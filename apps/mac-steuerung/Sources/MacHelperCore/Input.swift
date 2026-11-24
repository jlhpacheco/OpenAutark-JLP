// Eingaben als CGEvent am HID-Eingang (cghidEventTap): Zeiger bewegen, Klicks (links/rechts/Mitte, doppelt/dreifach),
// Ziehen, Mausrad, Text (Unicode, nicht über die Zwischenablage), Tastenkürzel, Loslassen. Alle Koordinaten kommen in Pixeln
// der Laufzeit und werden hier in Punkte umgerechnet (Screen.swift). Braucht das Bedienungshilfen-Recht (Permission.swift).
// Besitzt: Ereignisse erzeugen und senden, was gerade gedrückt ist, die Zeit der letzten eigenen Eingabe. Nie: Schutzregeln
// (Guard.swift), Pfade und Zeitplanung (PathMotion.swift) oder Wiederholungen – eine Eingabe läuft nie zweimal.

import ApplicationServices
import CoreGraphics
import Foundation

public final class Input {
    private let source = CGEventSource(stateID: .hidSystemState)
    private var layout: [UInt16: CGKeyCode]?
    private var heldButtons = Set<Int>() // 0 links, 1 rechts, 2 Mitte
    private var heldKeys: [CGKeyCode] = []
    public private(set) var lastInjected: Double?

    public init() {}

    static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    private func touch() { lastInjected = Input.now() }

    private func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }

    public func pause(_ ms: Double) { Thread.sleep(forTimeInterval: ms / 1000) }

    // MARK: Zeiger

    /// Wo der Zeiger jetzt ist, in Pixeln.
    public func pointer() -> (x: Int, y: Int)? {
        guard let location = CGEvent(source: nil)?.location else { return nil }
        return (Screen.px(location.x), Screen.px(location.y))
    }

    public static func buttonNumber(_ name: String?) -> Int? {
        switch name ?? "left" {
        case "left": return 0
        case "right": return 1
        case "middle": return 2
        default: return nil
        }
    }

    private func kinds(_ button: Int) -> (down: CGEventType, up: CGEventType, drag: CGEventType, button: CGMouseButton) {
        switch button {
        case 1: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
        case 2: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
        default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
        }
    }

    /// Bewegt den Zeiger; mit gedrückter Taste als Ziehen.
    public func move(_ x: Int, _ y: Int) {
        let location = CGPoint(x: Screen.pt(x), y: Screen.pt(y))
        let held = heldButtons.sorted().first
        let set = kinds(held ?? 0)
        let event = CGEvent(mouseEventSource: source, mouseType: held == nil ? .mouseMoved : set.drag, mouseCursorPosition: location, mouseButton: set.button)
        if held == 2 { event?.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
        post(event)
        touch()
    }

    public func press(_ x: Int, _ y: Int, button: Int, down: Bool, clickState: Int = 1) {
        let location = CGPoint(x: Screen.pt(x), y: Screen.pt(y))
        let set = kinds(button)
        let event = CGEvent(mouseEventSource: source, mouseType: down ? set.down : set.up, mouseCursorPosition: location, mouseButton: set.button)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        if button == 2 { event?.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
        if down { heldButtons.insert(button) } else { heldButtons.remove(button) }
        post(event)
        touch()
    }

    /// Klick an (x, y): hinfahren, drücken, loslassen; bei count > 1 mit steigendem Klickzähler.
    public func click(_ x: Int, _ y: Int, button: Int, count: Int) {
        move(x, y)
        pause(15)
        for n in 1...max(1, count) {
            press(x, y, button: button, down: true, clickState: n)
            pause(25)
            press(x, y, button: button, down: false, clickState: n)
            if n < count { pause(60) }
        }
    }

    /// Mausrad in Zeilen am Zeiger: dy > 0 scrollt nach unten, dx > 0 nach rechts.
    public func scroll(dx: Int, dy: Int) {
        let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0)
        post(event)
        touch()
    }

    // MARK: Tastatur

    private func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        event?.flags = flags
        post(event)
        touch()
    }

    private func tap(_ code: CGKeyCode) {
        keyEvent(code, down: true, flags: [])
        pause(8)
        keyEvent(code, down: false, flags: [])
    }

    /// Text als Unicode-Tastenereignisse (höchstens 20 UTF-16-Einheiten je Ereignis); Zeilenumbruch und Tab als echte Tasten.
    public func type(_ text: String) {
        var buffer: [UniChar] = []
        func flush() {
            guard !buffer.isEmpty else { return }
            let units = buffer
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                event?.flags = [] // Text trägt nie Modifikatoren, auch wenn der Zustand des Geräts welche zeigt
                if let event = event {
                    units.withUnsafeBufferPointer { pointer in
                        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress)
                    }
                }
                post(event)
            }
            touch()
            buffer.removeAll()
            pause(3)
        }
        for character in text {
            if character == "\n" || character == "\r" || character == "\r\n" {
                flush()
                tap(0x24)
            } else if character == "\t" {
                flush()
                tap(0x30)
            } else {
                let units = Array(String(character).utf16)
                if buffer.count + units.count > 18 { flush() }
                buffer.append(contentsOf: units)
            }
        }
        flush()
    }

    /// Eine Tastenkombination aus Windows-Tastencodes: Modifikatoren zuerst, dann die Taste, in umgekehrter Reihenfolge los.
    public func chord(_ vks: [Int], repeat times: Int) throws {
        let table = layout ?? KeyLayout.current()
        layout = table
        var modifiers: [KeySpec] = []
        var mains: [CGKeyCode] = []
        for vk in vks {
            let spec = try Keys.spec(vk: vk, layout: table)
            if spec.flag != nil { modifiers.append(spec) } else { mains.append(spec.code) }
        }
        for _ in 0..<max(1, times) {
            var flags: CGEventFlags = []
            for modifier in modifiers {
                flags.insert(modifier.flag ?? [])
                keyEvent(modifier.code, down: true, flags: flags)
                heldKeys.append(modifier.code)
            }
            for code in mains {
                keyEvent(code, down: true, flags: flags)
                pause(8)
                keyEvent(code, down: false, flags: flags)
            }
            if mains.isEmpty { pause(8) }
            for modifier in modifiers.reversed() {
                flags.remove(modifier.flag ?? []) // die Loslass-Meldung trägt den Zustand NACH dem Loslassen, sonst bleibt die Taste für macOS gedrückt
                keyEvent(modifier.code, down: false, flags: flags)
                heldKeys.removeAll(where: { $0 == modifier.code })
            }
            if times > 1 { pause(10) }
        }
    }

    /// Lässt alles los, was dieser Prozess gedrückt hält (nach einem Stopp); drückt nie etwas.
    public func release() -> [String] {
        var out: [String] = []
        let names = ["left", "right", "middle"]
        for button in heldButtons.sorted() {
            let here = pointer() ?? (0, 0)
            press(here.x, here.y, button: button, down: false)
            out.append(names[min(button, 2)])
        }
        for code in heldKeys.reversed() {
            keyEvent(code, down: false, flags: [])
            out.append("key\(code)")
        }
        heldKeys.removeAll()
        return out
    }

    // MARK: Anwesenheit

    /// Millisekunden seit der letzten Eingabe irgendeines Geräts (auch unserer eigenen – die Laufzeit trennt das mit injectedAgoMs).
    public func idleMs() -> Int? {
        guard let anyInput = CGEventType(rawValue: UInt32.max) else { return nil }
        let seconds = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)
        guard seconds.isFinite, seconds >= 0 else { return nil }
        return Int(min(seconds, 1e7) * 1000)
    }

    public func presence() -> JSON {
        var out: JSON = [:]
        if let idle = idleMs() { out["idleMs"] = idle } else { out["idleUnknown"] = true }
        if let last = lastInjected { out["injectedAgoMs"] = Int((Input.now() - last) * 1000) } else { out["injectedAgoMs"] = NSNull() }
        return out
    }
}
