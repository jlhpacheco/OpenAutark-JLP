// AX-Seite des Helfers: dünne Hüllen um AXUIElement, die AX-Rollen als Rollen des Protokolls (die Namen der
// Windows-Steuerelementtypen, klein geschrieben), der Baum als Knoten-Liste, Elemente über ihren Indexpfad ("0.3.1").
// Besitzt: AX lesen, Rollen/Namen/Knoten, Auflösen von Indexpfaden. Nie: Eingaben erzeugen, Rechte entscheiden, auf stdout schreiben.

import ApplicationServices
import AppKit
import Foundation

public enum AX {
    public static let timeout: Float = 1.5
    public static let maxDepth = 40
    public static let maxNodes = 2000

    // MARK: Hüllen

    public static func app(_ pid: pid_t) -> AXUIElement {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, timeout)
        return element
    }

    public static func value(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var out: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &out) == .success else { return nil }
        return out
    }

    public static func string(_ element: AXUIElement, _ name: String) -> String? { value(element, name) as? String }

    public static func bool(_ element: AXUIElement, _ name: String) -> Bool? {
        guard let number = value(element, name) as? NSNumber else { return nil }
        return number.boolValue
    }

    public static func number(_ element: AXUIElement, _ name: String) -> Double? {
        guard let number = value(element, name) as? NSNumber, !Args.isBool(number) else { return nil }
        return number.doubleValue.isFinite ? number.doubleValue : nil
    }

    public static func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let object = value(element, name), CFGetTypeID(object) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(object, to: AXUIElement.self)
    }

    public static func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
        guard let object = value(element, name), CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(unsafeDowncast(object, to: AXValue.self), .cgPoint, &point) ? point : nil
    }

    public static func size(_ element: AXUIElement, _ name: String) -> CGSize? {
        guard let object = value(element, name), CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(unsafeDowncast(object, to: AXValue.self), .cgSize, &size) ? size : nil
    }

    /// Rechteck in Punkten (Bildschirmkoordinaten, Ursprung oben links) oder nil.
    public static func rect(_ element: AXUIElement) -> CGRect? {
        guard let origin = point(element, "AXPosition"), let size = size(element, "AXSize") else { return nil }
        guard origin.x.isFinite, origin.y.isFinite, size.width.isFinite, size.height.isFinite else { return nil }
        return CGRect(origin: origin, size: size)
    }

    public static func children(_ element: AXUIElement) -> [AXUIElement] {
        let list = (value(element, "AXChildren") as? [AXUIElement]) ?? []
        return Array(list.prefix(5000))
    }

    public static func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }

    @discardableResult
    public static func perform(_ element: AXUIElement, _ action: String) -> Bool {
        AXUIElementPerformAction(element, action as CFString) == .success
    }

    public static func settable(_ element: AXUIElement, _ name: String) -> Bool {
        var flag = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, name as CFString, &flag) == .success && flag.boolValue
    }

    @discardableResult
    public static func set(_ element: AXUIElement, _ name: String, _ newValue: CFTypeRef) -> Bool {
        AXUIElementSetAttributeValue(element, name as CFString, newValue) == .success
    }

    public static func pid(_ element: AXUIElement) -> pid_t {
        var pid: pid_t = 0
        _ = AXUIElementGetPid(element, &pid)
        return pid
    }

    public static func same(_ a: AXUIElement, _ b: AXUIElement) -> Bool { CFEqual(a, b) }

    /// Chromium/Electron-Apps zeigen ihren AX-Baum erst, wenn eine Hilfstechnik gemeldet ist (AXManualAccessibility).
    public static func enableManual(_ appElement: AXUIElement) {
        _ = set(appElement, "AXManualAccessibility", kCFBooleanTrue)
    }

    // MARK: Rollen

    /// AX-Rolle (+ Unterrolle) → Rolle des Protokolls (wie die Windows-Steuerelementtypen, klein).
    public static func mapRole(_ role: String, _ subrole: String?) -> String {
        if role == "AXOutline" { return "tree" }
        switch role {
        case "AXWindow", "AXSheet", "AXDrawer", "AXPopover": return "window"
        case "AXButton", "AXDisclosureTriangle", "AXColorWell", "AXMenuButton": return "button"
        case "AXCheckBox": return "checkbox"
        case "AXRadioButton": return subrole == "AXTabButton" ? "tabitem" : "radiobutton"
        case "AXTextField", "AXTextArea", "AXSearchField": return "edit"
        case "AXStaticText", "AXHeading": return "text"
        case "AXComboBox", "AXPopUpButton": return "combobox"
        case "AXList": return "list"
        case "AXTable", "AXBrowser": return "table"
        case "AXRow": return subrole == "AXOutlineRow" ? "treeitem" : "listitem"
        case "AXCell": return "dataitem"
        case "AXMenuBar": return "menubar"
        case "AXMenuBarItem", "AXMenuItem": return "menuitem"
        case "AXMenu": return "menu"
        case "AXTabGroup": return "tab"
        case "AXGroup", "AXRadioGroup": return "group"
        case "AXScrollArea", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXMatte", "AXGrowArea": return "pane"
        case "AXScrollBar": return "scrollbar"
        case "AXSlider": return "slider"
        case "AXIncrementor", "AXStepper": return "spinner"
        case "AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator", "AXRelevanceIndicator": return "progressbar"
        case "AXToolbar": return "toolbar"
        case "AXImage": return "image"
        case "AXLink": return "hyperlink"
        case "AXWebArea": return "document"
        case "AXSplitter", "AXValueIndicator": return "separator"
        case "AXUnknown": return "unknown"
        default:
            let bare = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
            return bare.isEmpty ? "unknown" : bare.lowercased()
        }
    }

    public static func role(of element: AXUIElement) -> String {
        mapRole(string(element, "AXRole") ?? "AXUnknown", string(element, "AXSubrole"))
    }

    // MARK: Namen und Knoten

    /// Der Name eines Elements (höchstens 200 Zeichen): Titel, Beschreibung, beschriftendes Element, Text eines Textfelds.
    public static func name(_ element: AXUIElement, rawRole: String) -> String {
        for key in ["AXTitle", "AXDescription"] {
            if let text = string(element, key), !text.isEmpty { return clip(text, 200) }
        }
        if let label = self.element(element, "AXTitleUIElement") {
            if let text = string(label, "AXValue") ?? string(label, "AXTitle"), !text.isEmpty { return clip(text, 200) }
        }
        if rawRole == "AXStaticText", let text = string(element, "AXValue"), !text.isEmpty { return clip(text, 200) }
        if let text = string(element, "AXPlaceholderValue"), !text.isEmpty { return clip(text, 200) }
        return ""
    }

    static let valueRoles: Set<String> = ["edit", "combobox", "document", "dataitem", "spinner"]
    static let numberRoles: Set<String> = ["slider", "spinner", "progressbar", "scrollbar"]
    static let selectRoles: Set<String> = ["radiobutton", "tabitem", "listitem", "treeitem", "dataitem"]

    /// Ein Knoten der Baum-Antwort (Felder wie im Windows-Helfer; `bounds`: alle Bildschirme in Punkten).
    public static func node(_ element: AXUIElement, depth: Int, parent: Int, rid: String, bounds: CGRect) -> JSON {
        let rawRole = string(element, "AXRole") ?? "AXUnknown"
        let subrole = string(element, "AXSubrole")
        let role = mapRole(rawRole, subrole)
        var out: JSON = ["d": depth, "p": parent, "rid": rid, "role": role]
        let label = name(element, rawRole: rawRole)
        if !label.isEmpty { out["name"] = label }
        if let identifier = string(element, "AXIdentifier"), !identifier.isEmpty { out["aid"] = clip(identifier, 200) }
        if let frame = rect(element) {
            out["rect"] = Screen.pxRect(frame)
            if !bounds.intersects(frame) { out["offscreen"] = true }
        }
        if bool(element, "AXEnabled") == false { out["disabled"] = true }
        if bool(element, "AXFocused") == true { out["focused"] = true }
        if bool(element, "AXSelected") == true { out["selected"] = true }

        let names = actions(element)
        var toggle: String?
        if role == "checkbox" || role == "radiobutton" {
            toggle = (number(element, "AXValue") ?? 0) != 0 ? "on" : "off"
        } else if rawRole == "AXMenuItem", let mark = string(element, "AXMenuItemMarkChar"), !mark.isEmpty {
            toggle = "on"
        }
        if let toggle = toggle { out["toggle"] = toggle }
        var expand: String?
        if let open = bool(element, "AXDisclosing") ?? bool(element, "AXExpanded") { expand = open ? "expanded" : "collapsed" }
        if let expand = expand { out["expand"] = expand }

        var patterns: [String] = []
        if names.contains("AXPress") || names.contains("AXPick") || names.contains("AXConfirm") { patterns.append("invoke") }
        let textLike = role == "edit" || role == "slider" || role == "spinner" || role == "combobox"
        if textLike && settable(element, "AXValue") { patterns.append("value") }
        if toggle != nil { patterns.append("toggle") }
        if expand != nil { patterns.append("expand") }
        if selectRoles.contains(role) && (role == "radiobutton" || role == "tabitem" || value(element, "AXSelected") != nil) { patterns.append("select") }
        if !patterns.isEmpty { out["patterns"] = patterns }

        if subrole != "AXSecureTextField", let object = value(element, "AXValue") {
            if let text = object as? String, valueRoles.contains(role) {
                if !text.isEmpty { out["value"] = clip(text, 400) }
            } else if let number = object as? NSNumber, !Args.isBool(number), numberRoles.contains(role), number.doubleValue.isFinite {
                out["value"] = number.doubleValue
            }
        }
        return out
    }

    /// Alle Knoten unter `root` in Reihenfolge der Tiefensuche; `match` filtert (Eltern-Indizes zeigen auf den letzten gefundenen Vorfahren).
    public static func walk(_ root: AXUIElement, maxDepth: Int, maxNodes: Int, match: ((AXUIElement) -> Bool)? = nil) -> (nodes: [JSON], truncated: Bool) {
        var nodes: [JSON] = []
        var truncated = false
        let bounds = Screen.virtualBounds()
        func visit(_ element: AXUIElement, _ depth: Int, _ parent: Int, _ path: String) {
            if nodes.count >= maxNodes { truncated = true; return }
            var index = parent
            if match == nil || match!(element) {
                nodes.append(node(element, depth: depth, parent: parent, rid: path, bounds: bounds))
                index = nodes.count - 1
            }
            if depth >= maxDepth { return }
            for (position, child) in children(element).enumerated() {
                if truncated { return }
                visit(child, depth + 1, index, path.isEmpty ? String(position) : "\(path).\(position)")
            }
        }
        visit(root, 0, -1, "")
        return (nodes, truncated)
    }

    /// Das Element zu einem Indexpfad unterhalb des Fensters ("" = das Fenster selbst).
    public static func resolve(_ window: AXUIElement, rid: String) throws -> AXUIElement {
        var current = window
        if rid.isEmpty { return current }
        for part in rid.split(separator: ".") {
            guard let index = Int(part), index >= 0 else { throw HelperError("bad_request", "The element reference is not valid.") }
            let kids = children(current)
            guard index < kids.count else {
                throw HelperError("not_found", "The element is gone (the UI changed). Observe again with computer.ui_tree.")
            }
            current = kids[index]
        }
        return current
    }

    /// Der Indexpfad von `element` im Fenster `window` (über AXParent nach oben), oder nil.
    public static func path(of element: AXUIElement, in window: AXUIElement) -> String? {
        var parts: [String] = []
        var current = element
        var guardCount = 0
        while !same(current, window) {
            guardCount += 1
            guard guardCount <= maxDepth, let parent = self.element(current, "AXParent") else { return nil }
            guard let index = children(parent).firstIndex(where: { same($0, current) }) else { return nil }
            parts.append(String(index))
            current = parent
        }
        return parts.reversed().joined(separator: ".")
    }
}
