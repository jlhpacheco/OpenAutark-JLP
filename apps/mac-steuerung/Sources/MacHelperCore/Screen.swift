// Koordinaten: macOS (CGEvent, AX, CGWindowList) rechnet in Punkten, die Laufzeit (Screenshots, Fensterrechtecke, Klicks)
// in Pixeln des Hauptbildschirms. Der Helfer rechnet an seiner Grenze um: Pixel = Punkte × Skala, die Skala ist
// pixelWidth/width des Hauptbildschirms (Retina: 2), überschreibbar mit AUTARK_MAC_SCALE.
// Besitzt: Skala, Umrechnung, Bildschirmliste. Nie: Eingaben oder AX.

import CoreGraphics
import Foundation

public enum Screen {
    public static let scale: Double = {
        if let text = ProcessInfo.processInfo.environment["AUTARK_MAC_SCALE"], let value = Double(text), value >= 0.5, value <= 8 {
            return value
        }
        if let mode = CGDisplayCopyDisplayMode(CGMainDisplayID()), mode.width > 0 {
            let value = Double(mode.pixelWidth) / Double(mode.width)
            if value.isFinite && value >= 1 { return value }
        }
        return 1
    }()

    public static func px(_ points: CGFloat) -> Int {
        let value = Double(points) * scale
        return value.isFinite ? Int(value.rounded()) : 0
    }

    public static func pt(_ pixels: Int) -> CGFloat { CGFloat(Double(pixels) / scale) }

    public static func pxRect(_ rect: CGRect) -> [Int] {
        [px(rect.origin.x), px(rect.origin.y), px(rect.size.width), px(rect.size.height)]
    }

    public static func activeDisplays() -> [CGDirectDisplayID] {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return [] }
        let list = Array(ids.prefix(Int(count)))
        // Hauptbildschirm zuerst: die Laufzeit zählt Bildschirme ab 0 mit dem Hauptbildschirm vorn.
        return list.filter { CGDisplayIsMain($0) != 0 } + list.filter { CGDisplayIsMain($0) == 0 }
    }

    /// Alle Bildschirme in Pixeln (op 'screens').
    public static func screens() -> [JSON] {
        var out: [JSON] = []
        for (index, id) in activeDisplays().enumerated() {
            let bounds = CGDisplayBounds(id)
            let rect = pxRect(bounds)
            out.append([
                "index": index, "x": rect[0], "y": rect[1], "width": rect[2], "height": rect[3],
                "primary": CGDisplayIsMain(id) != 0, "name": "Display \(index + 1)",
            ])
        }
        return out
    }

    /// Alle Bildschirme zusammen in Punkten (Sichtbarkeitsprüfung der Elemente).
    public static func virtualBounds() -> CGRect {
        var union = CGRect.null
        for id in activeDisplays() { union = union.union(CGDisplayBounds(id)) }
        return union.isNull ? CGRect(x: 0, y: 0, width: 1, height: 1) : union
    }
}
