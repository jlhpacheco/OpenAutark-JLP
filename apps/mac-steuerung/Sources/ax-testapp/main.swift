// ax-testapp: eine winzige Mac-App für den CI-Selbsttest des Helfers. Sie zeigt ein Fenster mit einem Knopf („Klick mich“) und
// einem Textfeld und schreibt jede Eingabe, die sie erreicht, als Logzeile (stdout und, falls AX_TESTAPP_LOG gesetzt ist, in diese Datei):
//   READY pid=… button=x,y,w,h field=x,y,w,h      (Bildschirmpunkte, Ursprung oben links)
//   MOUSE_DOWN x=… y=…                           (ein echter Mausdruck ist angekommen)
//   CLICK count=… via=mouse|ax                   (der Knopf wurde ausgelöst; ax = ohne Mausdruck, also per AXPress)
//   KEY_DOWN code=… chars=…                      (eine echte Taste ist angekommen)
//   TEXT value=…                                 (das Textfeld hat sich durch Tippen geändert)
//   ENTER                                        (Eingabetaste im Textfeld)
// Besitzt: nur das Fenster und seine Logzeilen. Nie: etwas anderes tun – sie beendet sich nach AX_TESTAPP_TTL Sekunden (Standard 150).

import AppKit
import Foundation

func emit(_ line: String) {
    print(line)
    fflush(stdout)
    if let path = ProcessInfo.processInfo.environment["AX_TESTAPP_LOG"], let data = (line + "\n").data(using: .utf8) {
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            handle.closeFile()
        } else {
            FileManager.default.createFile(atPath: path, contents: data)
        }
    }
}

final class TestDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    var window: NSWindow!
    var button: NSButton!
    var field: NSTextField!
    var check: NSButton!
    var count = 0
    var mouseSeen = false

    func topLeft(_ view: NSView) -> String {
        let onScreen = window.convertToScreen(view.convert(view.bounds, to: nil))
        let height = NSScreen.screens.first?.frame.height ?? 0
        return "\(Int(onScreen.minX)),\(Int(height - onScreen.maxY)),\(Int(onScreen.width)),\(Int(onScreen.height))"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 220, y: 300, width: 420, height: 220), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "AX Testapp"
        guard let content = window.contentView else { return }

        button = NSButton(title: "Klick mich", target: self, action: #selector(clicked))
        button.frame = NSRect(x: 20, y: 140, width: 140, height: 40)
        button.setAccessibilityIdentifier("klick")
        content.addSubview(button)

        field = NSTextField(frame: NSRect(x: 20, y: 80, width: 300, height: 28))
        field.setAccessibilityIdentifier("eingabe")
        field.delegate = self
        content.addSubview(field)

        check = NSButton(checkboxWithTitle: "Haken", target: self, action: #selector(checked))
        check.frame = NSRect(x: 20, y: 30, width: 200, height: 24)
        check.setAccessibilityIdentifier("haken")
        content.addSubview(check)

        // Ein Bearbeiten-Menü, damit Cmd+A/Cmd+C im Textfeld wirken (ohne Menü gäbe es keine Tastenkürzel).
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "Bearbeiten")
        editMenu.addItem(withTitle: "Alles auswählen", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(withTitle: "Kopieren", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Einfügen", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editItem.submenu = editMenu
        NSApp.mainMenu = main

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(field)

        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .keyDown]) { [weak self] event in
            guard let self = self else { return event }
            if event.type == .leftMouseDown {
                let height = NSScreen.screens.first?.frame.height ?? 0
                let here = NSEvent.mouseLocation
                self.mouseSeen = true
                emit("MOUSE_DOWN x=\(Int(here.x)) y=\(Int(height - here.y))")
            } else {
                emit("KEY_DOWN code=\(event.keyCode) chars=\(event.characters ?? "")")
            }
            return event
        }

        let ttl = Double(ProcessInfo.processInfo.environment["AX_TESTAPP_TTL"] ?? "") ?? 150
        DispatchQueue.main.asyncAfter(deadline: .now() + ttl) { NSApp.terminate(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [self] in
            emit("READY pid=\(getpid()) button=\(topLeft(button)) field=\(topLeft(field))")
        }
    }

    @objc func checked() {
        emit("CHECK state=\(check.state == .on ? 1 : 0)")
    }

    @objc func clicked() {
        count += 1
        let via = mouseSeen ? "mouse" : "ax"
        mouseSeen = false
        emit("CLICK count=\(count) via=\(via)")
    }

    func controlTextDidChange(_ obj: Notification) {
        emit("TEXT value=\(field.stringValue)")
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) { emit("ENTER") }
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = TestDelegate()
application.delegate = delegate
application.run()
