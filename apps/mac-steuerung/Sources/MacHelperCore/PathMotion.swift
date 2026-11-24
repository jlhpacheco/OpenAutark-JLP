// Zeigerpfade (op 'path', Protokoll 4, B-055; Vorbild linux_path.py): die Laufzeit plant den Weg (motion.ts) als Schritte
// x, y, t (ganze Pixel, Millisekunden seit dem Start); hier läuft er pünktlich ab und endet in einem Klick (Taste gehalten pressMs),
// einem Ziehen entlang eines zweiten Pfads oder Mausradschritten. Ein Klick auf ein Element biegt den Pfad auf dessen Mitte.
// Bewegt der Mensch den Zeiger (weiter als ein paar Pixel von dem weg, wo unser letzter Schritt ihn ließ), endet der Pfad mit
// 'human_active', bevor etwas gedrückt wurde; ein gehaltenes Ziehen wird sofort losgelassen ('conflict').
// Besitzt: Schritte prüfen, Zeitplan, Unterbrechungsprüfung, Reihenfolge von Drücken und Loslassen. Nie: vor den Schutzprüfungen
// drücken, eine Taste gehalten lassen oder selbst Bewegung planen.

import Foundation

public struct PathStep {
    public let x: Int
    public let y: Int
    public let t: Int
}

/// Was der Pfad vom Helfer braucht (Tests setzen ein Fake ein).
public protocol PathIO {
    func move(_ x: Int, _ y: Int)
    func press(_ x: Int, _ y: Int, button: Int, down: Bool, clickState: Int)
    func pointer() -> (x: Int, y: Int)?
    func wheel(dx: Int, dy: Int)
    func guardPoints(_ points: [(Int, Int)]) throws
    func pause(_ ms: Double)
}

/// Die zuletzt erwarteten Zeigerorte: macOS meldet einen eben gesendeten Schritt erst einen Moment später, deshalb zählt
/// der Zeiger auch dann als unseren, wenn er bei einem der letzten drei Ziele steht.
struct Trail {
    var points: [(x: Int, y: Int)] = []

    mutating func add(_ point: (x: Int, y: Int)?) {
        guard let point = point else { return }
        points.append(point)
        if points.count > 3 { points.removeFirst() }
    }
}

public enum PathMotion {
    static let tolerance = 4
    static let maxSteps = 1000

    public static func steps(_ a: Args, _ key: String) throws -> [PathStep] {
        guard let raw = a.list(key), !raw.isEmpty, raw.count % 3 == 0, raw.count <= maxSteps * 3 else {
            throw HelperError("bad_request", "\(key) must be 1 to \(maxSteps) steps of x, y, t.")
        }
        var out: [PathStep] = []
        var last = 0
        var index = 0
        while index < raw.count {
            guard let x = Args.number(raw[index]), let y = Args.number(raw[index + 1]), let t = Args.number(raw[index + 2]),
                  abs(x) <= 1e6, abs(y) <= 1e6, abs(t) <= 1e6 else {
                throw HelperError("bad_request", "\(key) must be finite numbers.")
            }
            let time = Int(t.rounded())
            if time < last || time > 60000 { throw HelperError("bad_request", "\(key): t must never fall and stay within 60 s.") }
            last = time
            out.append(PathStep(x: Int(x.rounded()), y: Int(y.rounded()), t: time))
            index += 3
        }
        return out
    }

    static func check(_ io: PathIO, _ trail: Trail, held: Bool) throws {
        guard !trail.points.isEmpty, let now = io.pointer() else { return }
        if trail.points.contains(where: { abs(now.x - $0.x) <= tolerance && abs(now.y - $0.y) <= tolerance }) { return }
        if held {
            throw HelperError("conflict", "The person moved the mouse during the drag, so it was let go early at \(now.x),\(now.y). Look at the screen before you go on.")
        }
        throw HelperError("human_active", "The person moved the mouse, so the pointer stopped on its way and nothing was pressed.")
    }

    static func start(_ a: Args, _ io: PathIO) throws -> (x: Int, y: Int)? {
        let now = io.pointer()
        guard a.has("from"), let here = now else { return now }
        guard let want = a.list("from"), want.count == 2, let fx = Args.number(want[0]), let fy = Args.number(want[1]) else {
            throw HelperError("bad_request", "from must be [x, y].")
        }
        if abs(here.x - Int(fx.rounded())) > tolerance || abs(here.y - Int(fy.rounded())) > tolerance {
            throw HelperError("human_active", "The person moved the mouse since this step was planned; nothing was pressed.")
        }
        return here
    }

    /// Bewegt entlang der Schritte pünktlich; ein schon verspäteter Schritt wird übersprungen (der letzte nie).
    static func replay(_ steps: [PathStep], _ io: PathIO, _ trail: inout Trail, held: Bool = false) throws {
        let begin = Input.now()
        for (index, step) in steps.enumerated() {
            let elapsed = (Input.now() - begin) * 1000
            if index < steps.count - 1 && elapsed >= Double(steps[index + 1].t) { continue }
            if Double(step.t) > elapsed { io.pause(Double(step.t) - elapsed) }
            try check(io, trail, held: held)
            io.move(step.x, step.y)
            trail.add((step.x, step.y))
        }
    }

    static func ms(_ a: Args, _ key: String, _ fallback: Int, _ top: Int) -> Double {
        Double(min(top, max(0, a.int(key) ?? fallback)))
    }

    static func buttonOf(_ a: Args) throws -> Int {
        guard let button = Input.buttonNumber(a.string("button")) else { throw HelperError("bad_request", "button must be left, right or middle.") }
        return button
    }

    static func click(_ a: Args, _ steps: [PathStep], _ io: PathIO, button: Int, count: Int) throws {
        guard let end = steps.last else { return }
        var trail = Trail()
        trail.add(try start(a, io))
        try replay(steps, io, &trail)
        io.pause(ms(a, "dwellMs", 20, 1000))
        try check(io, trail, held: false)
        let hold = ms(a, "pressMs", 0, 500)
        let gap = max(20, ms(a, "gapMs", 60, 400))
        for n in 1...max(1, count) {
            io.press(end.x, end.y, button: button, down: true, clickState: n)
            io.pause(hold)
            io.press(end.x, end.y, button: button, down: false, clickState: n)
            if n < count { io.pause(gap) }
        }
    }

    /// op 'path': end none (nur hinfahren), click, drag (a["drag"]: der gehaltene Pfad) oder wheel (dx, dy).
    public static func run(_ a: Args, _ io: PathIO) throws -> JSON {
        let list = try steps(a, "steps")
        let end = a.string("end") ?? "none"
        let first = list[list.count - 1]
        switch end {
        case "click":
            let button = try buttonOf(a)
            try io.guardPoints([(first.x, first.y)])
            try click(a, list, io, button: button, count: max(1, min(3, a.int("count", 1))))
            return ["done": true, "at": [first.x, first.y]]
        case "drag":
            let button = try buttonOf(a)
            let dragSteps = try steps(a, "drag")
            let target = dragSteps[dragSteps.count - 1]
            try io.guardPoints([(first.x, first.y), (target.x, target.y)]) // beide Enden, bevor die Taste unten ist: nie ein halbes Ziehen
            var trail = Trail()
            trail.add(try start(a, io))
            try replay(list, io, &trail)
            io.pause(ms(a, "dwellMs", 40, 1000))
            try check(io, trail, held: false)
            io.press(first.x, first.y, button: button, down: true, clickState: 1)
            var released = false
            do {
                io.pause(ms(a, "downMs", 60, 1000))
                var dragTrail = Trail()
                dragTrail.add(io.pointer())
                try replay(dragSteps, io, &dragTrail, held: true)
                io.pause(ms(a, "settleMs", 60, 1000))
                io.press(target.x, target.y, button: button, down: false, clickState: 1)
                released = true
            } catch {
                if !released {
                    let here = io.pointer() ?? (target.x, target.y)
                    io.press(here.x, here.y, button: button, down: false, clickState: 1) // nie die Taste gehalten lassen
                }
                throw error
            }
            return ["done": true, "at": [target.x, target.y]]
        case "none", "wheel":
            var trail = Trail()
            trail.add(try start(a, io))
            try replay(list, io, &trail)
            if end == "wheel" {
                io.pause(ms(a, "dwellMs", 20, 1000))
                try check(io, trail, held: false)
                io.wheel(dx: max(-50, min(50, a.int("dx", 0))), dy: max(-50, min(50, a.int("dy", 0))))
            }
            return ["done": true, "at": [first.x, first.y]]
        default:
            throw HelperError("bad_request", "end must be none, click, drag or wheel.")
        }
    }

    /// Ein Elementklick mit geplantem Pfad (op 'act'): auf die Mitte (x, y) des Elements gebogen, dann geklickt.
    public static func elementClick(_ a: Args, x: Int, y: Int, _ io: PathIO, button: Int, count: Int) throws {
        let list = try steps(a, "steps")
        let last = list[list.count - 1]
        let dx = Double(x - last.x)
        let dy = Double(y - last.y)
        let total = Double(max(1, last.t))
        var bent = list.map { step in
            PathStep(x: step.x + Int((dx * Double(step.t) / total).rounded()), y: step.y + Int((dy * Double(step.t) / total).rounded()), t: step.t)
        }
        bent[bent.count - 1] = PathStep(x: x, y: y, t: last.t)
        try click(a, bent, io, button: button, count: count)
    }
}
