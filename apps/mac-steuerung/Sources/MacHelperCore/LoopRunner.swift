// Die Schleife des Helfers: Bereit-Zeile, dann je eine Anfragezeile von stdin → eine Antwortzeile auf stdout (Protokoll 4).
// Besitzt: stdin/stdout, Zeilenformat, Fehlerumsetzung (jede Ausnahme wird zur Fehlerzeile, nie zum Absturz). Nie: Operationen
// selbst (Service.swift). Auf stdout steht ausschließlich Protokoll; Diagnose geht nach stderr.

import Foundation

public enum LoopRunner {
    static func write(_ line: String) {
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8) ?? Data())
    }

    public static func ready() -> String {
        Wire.encode(["ready": true, "protocol": HelperService.protocolVersion, "pid": Int(getpid()), "dpiAware": true]) ?? "{\"ready\":true,\"protocol\":4}"
    }

    /// Eine Anfragezeile → die Antwortzeile (testbar ohne stdin).
    public static func respond(_ line: String, _ service: HelperService) -> String {
        guard let request = Wire.parse(line) else {
            return Wire.failure(id: 0, error: HelperError("bad_request", "The request is not a JSON object."))
        }
        let id: Any = (request["id"] as? NSNumber) ?? 0
        guard let op = request["op"] as? String else {
            return Wire.failure(id: id, error: HelperError("bad_request", "The request has no op."))
        }
        let args = Args((request["args"] as? JSON) ?? [:])
        do {
            return Wire.ok(id: id, result: try service.handle(op, args))
        } catch let error as HelperError {
            return Wire.failure(id: id, error: error)
        } catch {
            return Wire.failure(id: id, error: HelperError("internal", "\(error)"))
        }
    }

    public static func run() {
        setvbuf(stdout, nil, _IOLBF, 0)
        let service = HelperService()
        write(ready())
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            write(respond(line, service))
        }
        _ = service.input.release()
    }

    /// `--probe`: eine Zeile Diagnose (CI): Rechte, Bildschirme, Skalierung.
    public static func probe() -> String {
        let out: JSON = [
            "protocol": HelperService.protocolVersion,
            "trusted": Permission.trusted,
            "skipCheck": Permission.skipCheck,
            "scale": Screen.scale,
            "screens": Screen.screens(),
        ]
        return Wire.encode(out) ?? "{}"
    }
}
