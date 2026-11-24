// Tasten: die Laufzeit schickt Windows-Tastencodes (keys.ts); hier werden sie zu macOS-Hardware-Tastencodes.
// Buchstaben, Ziffern und Satzzeichen folgen dem AKTUELLEN Tastaturlayout (QWERTZ: Cmd+Z liegt auf einer anderen
// Taste als bei QWERTY); nur wenn das Layout das Zeichen nicht liefert, gilt die ANSI-Tabelle.
// Besitzt: die Tabellen und die Layout-Suche. Nie: Ereignisse senden.

import CoreGraphics
import Foundation
import Carbon.HIToolbox

public struct KeySpec: Equatable {
    public let code: CGKeyCode
    /// Gesetzt bei Umschalt-, Strg-, Alt- (Option) und Win-/Cmd-Taste.
    public let flag: CGEventFlags?

    public static func == (lhs: KeySpec, rhs: KeySpec) -> Bool { lhs.code == rhs.code && lhs.flag?.rawValue == rhs.flag?.rawValue }
}

public enum Keys {
    /// ANSI-Position je Zeichen (kVK_ANSI_*), wenn das Layout nichts liefert.
    static let ansi: [Character: CGKeyCode] = [
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B,
        "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16,
        "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20, "[": 0x21,
        "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29, "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D,
        "m": 0x2E, ".": 0x2F, "`": 0x32,
    ]

    /// Windows-Tastencode → Zeichen, das auf der Taste liegt (für die Layout-Suche).
    static func character(vk: Int) -> Character? {
        if (0x41...0x5A).contains(vk) { return Character(UnicodeScalar(UInt8(vk + 32))) }
        if (0x30...0x39).contains(vk) { return Character(UnicodeScalar(UInt8(vk))) }
        switch vk {
        case 0xBA: return ";"
        case 0xBB: return "="
        case 0xBC: return ","
        case 0xBD: return "-"
        case 0xBE: return "."
        case 0xBF: return "/"
        case 0xC0: return "`"
        case 0xDB: return "["
        case 0xDC: return "\\"
        case 0xDD: return "]"
        case 0xDE: return "'"
        default: return nil
        }
    }

    /// Tasten ohne Zeichen: gleiche Hardware-Codes auf jedem Layout.
    static let fixed: [Int: CGKeyCode] = [
        0x08: 0x33, 0x09: 0x30, 0x0D: 0x24, 0x1B: 0x35, 0x20: 0x31, 0x21: 0x74, 0x22: 0x79, 0x23: 0x77, 0x24: 0x73,
        0x25: 0x7B, 0x26: 0x7E, 0x27: 0x7C, 0x28: 0x7D, 0x2D: 0x72, 0x2E: 0x75,
        0x60: 0x52, 0x61: 0x53, 0x62: 0x54, 0x63: 0x55, 0x64: 0x56, 0x65: 0x57, 0x66: 0x58, 0x67: 0x59, 0x68: 0x5B, 0x69: 0x5C,
        0x6A: 0x43, 0x6B: 0x45, 0x6D: 0x4E, 0x6E: 0x41, 0x6F: 0x4B,
        // F1–F12, F13–F20
        0x70: 0x7A, 0x71: 0x78, 0x72: 0x63, 0x73: 0x76, 0x74: 0x60, 0x75: 0x61, 0x76: 0x62, 0x77: 0x64, 0x78: 0x65, 0x79: 0x6D,
        0x7A: 0x67, 0x7B: 0x6F, 0x7C: 0x69, 0x7D: 0x6B, 0x7E: 0x71, 0x7F: 0x6A, 0x80: 0x40, 0x81: 0x4F, 0x82: 0x50, 0x83: 0x5A,
    ]

    static let modifiers: [Int: KeySpec] = [
        0x10: KeySpec(code: 0x38, flag: .maskShift),
        0x11: KeySpec(code: 0x3B, flag: .maskControl),
        0x12: KeySpec(code: 0x3A, flag: .maskAlternate),
        0x5B: KeySpec(code: 0x37, flag: .maskCommand),
    ]

    /// Der macOS-Tastencode (und bei Modifikatoren das Flag) zu einem Windows-Tastencode.
    public static func spec(vk: Int, layout: [UInt16: CGKeyCode] = [:]) throws -> KeySpec {
        if let modifier = modifiers[vk] { return modifier }
        if let code = fixed[vk] { return KeySpec(code: code, flag: nil) }
        if let char = character(vk: vk), let ascii = char.asciiValue {
            if let code = layout[UInt16(ascii)] { return KeySpec(code: code, flag: nil) }
            if let code = ansi[char] { return KeySpec(code: code, flag: nil) }
        }
        throw HelperError("bad_request", "This key is not available on macOS.")
    }
}

/// Das aktuelle ASCII-fähige Tastaturlayout als Zeichen → Tastencode (ohne Modifikatoren).
public enum KeyLayout {
    public static func current() -> [UInt16: CGKeyCode] {
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
        guard let bytes = CFDataGetBytePtr(data) else { return [:] }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        var map: [UInt16: CGKeyCode] = [:]
        for code in 0..<128 {
            var dead: UInt32 = 0
            var length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
                                        OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, 4, &length, &chars)
            if status == noErr && length == 1 && map[chars[0]] == nil { map[chars[0]] = CGKeyCode(code) }
        }
        return map
    }
}
