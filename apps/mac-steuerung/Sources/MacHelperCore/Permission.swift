// Das Bedienungshilfen-Recht (TCC „Accessibility“): ohne AXIsProcessTrusted() liefert AX keine Daten und
// CGEvent-Eingaben werden still verworfen. Der Helfer scheitert deshalb laut: eine Meldung im Protokollformat mit dem Weg zur Freigabe.
// Besitzt: Rechteprüfung und die einmalige Aufforderung an macOS. Nie: Rechte selbst vergeben.
//
// AUTARK_MAC_SKIP_TRUST=1 lässt Operationen trotz fehlendem Recht durch (nur für den Selbsttest: zeigt, ob CGEvent-Eingaben
// ohne Recht ankommen). AUTARK_MAC_NO_PROMPT=1 unterdrückt den macOS-Dialog (CI: der Dialog würde den Fokus stehlen).

import ApplicationServices
import Foundation

public enum Permission {
    private static var prompted = false

    public static var skipCheck: Bool { ProcessInfo.processInfo.environment["AUTARK_MAC_SKIP_TRUST"] == "1" }
    public static var noPrompt: Bool { ProcessInfo.processInfo.environment["AUTARK_MAC_NO_PROMPT"] == "1" }

    public static var trusted: Bool { AXIsProcessTrusted() }

    public static let missing = "macOS has not given Autark the Accessibility permission, so this PC cannot be controlled yet. "
        + "Open System Settings › Privacy & Security › Accessibility, switch Autark on and try again."

    /// Wirft `unavailable`, wenn das Recht fehlt; fragt macOS dabei einmal je Prozess nach (Dialog mit Link zur Systemeinstellung).
    public static func require() throws {
        if skipCheck || AXIsProcessTrusted() { return }
        if !prompted && !noPrompt {
            prompted = true
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        throw HelperError("unavailable", missing)
    }
}
