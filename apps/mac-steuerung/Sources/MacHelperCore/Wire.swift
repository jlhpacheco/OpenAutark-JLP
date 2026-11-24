// Draht-Format des Helfers (Protokoll 4): eine JSON-Zeile pro Anfrage und Antwort, die Ausgabe ist reines ASCII
// (alles ab U+007F als \uXXXX), damit keine Codepage etwas verfälscht – wie asciiJson() in protocol.ts.
// Besitzt: Zeilen parsen/kodieren, Argument-Zugriff, den Fehlertyp. Nie: AX, CGEvent oder Prozesszustand.

import Foundation

public typealias JSON = [String: Any]

/// Ein Fehler im Protokollformat: `code` (bad_request, not_found, conflict, forbidden, unavailable, timeout, internal,
/// app_window, human_active) und eine Meldung, die ein Agent versteht. `app` nur bei app_window.
public struct HelperError: Error {
    public let code: String
    public let message: String
    public let app: JSON?

    public init(_ code: String, _ message: String, app: JSON? = nil) {
        self.code = code
        self.message = message
        self.app = app
    }
}

public enum Wire {
    public static func parse(_ line: String) -> JSON? {
        guard let data = line.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: []),
              let object = any as? JSON else { return nil }
        return object
    }

    /// Alles ab U+007F als \uXXXX (UTF-16-Einheiten), der Rest unverändert – gültig, weil nur Zeichen in Strings betroffen sind.
    public static func ascii(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.utf8.count)
        for scalar in text.unicodeScalars {
            if scalar.value < 0x7f {
                out.unicodeScalars.append(scalar)
            } else {
                for unit in String(scalar).utf16 {
                    out += String(format: "\\u%04x", UInt32(unit))
                }
            }
        }
        return out
    }

    public static func encode(_ object: JSON) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return nil }
        return ascii(text)
    }

    public static func ok(id: Any, result: Any) -> String {
        if let line = encode(["id": id, "ok": true, "result": result]) { return line }
        return failure(id: id, error: HelperError("internal", "The helper could not encode its answer."))
    }

    public static func failure(id: Any, error: HelperError) -> String {
        var body: JSON = ["code": error.code, "message": error.message]
        if let app = error.app { body["app"] = app }
        return encode(["id": id, "ok": false, "error": body]) ?? "{\"id\":0,\"ok\":false,\"error\":{\"code\":\"internal\",\"message\":\"encode failed\"}}"
    }
}

/// Typisierter Zugriff auf die Argumente einer Anfrage (JSONSerialization liefert NSNumber für Zahlen und Booleans).
public struct Args {
    public let raw: JSON

    public init(_ raw: JSON) { self.raw = raw }

    public func has(_ key: String) -> Bool {
        guard let value = raw[key] else { return false }
        return !(value is NSNull)
    }

    public func string(_ key: String) -> String? { raw[key] as? String }

    public func double(_ key: String) -> Double? { Args.number(raw[key]) }

    public func int(_ key: String) -> Int? {
        guard let value = double(key), abs(value) < 1e9 else { return nil }
        return Int(value.rounded())
    }

    public func int(_ key: String, _ fallback: Int) -> Int { int(key) ?? fallback }

    /// true bei JSON-true und bei jeder Zahl ungleich 0 (die Laufzeit schickt `app` als Fensternummer oder true).
    public func bool(_ key: String) -> Bool {
        guard let number = raw[key] as? NSNumber else { return false }
        return number.boolValue
    }

    public func list(_ key: String) -> [Any]? { raw[key] as? [Any] }

    public func dict(_ key: String) -> JSON? { raw[key] as? JSON }

    public static func isBool(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }

    /// Eine endliche Zahl (kein Bool, kein String) oder nil.
    public static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, !isBool(number) else { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }
}

public func clip(_ text: String, _ limit: Int) -> String {
    text.count <= limit ? text : String(text.prefix(limit))
}
