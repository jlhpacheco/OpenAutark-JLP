// autark-mac-helper: das macOS-Gegenstück zu windows-helper.ps1 und linux-helper.py (Protokoll 4, JSON-Zeilen auf stdin/stdout).
// `--probe` schreibt eine Diagnosezeile (Rechte, Bildschirme, Skala) und endet; ohne Argument läuft die Schleife.

import Foundation
import MacHelperCore

if CommandLine.arguments.contains("--probe") {
    print(LoopRunner.probe())
} else {
    LoopRunner.run()
}
