#!/usr/bin/env python3
"""Selbsttest des macOS-Helfers (läuft auf dem CI-Runner und auf einem echten Mac).

Startet ax-testapp (Fenster mit Knopf und Textfeld, loggt jede Eingabe, die es erreicht) und spricht mit autark-mac-helper
im Protokoll 4 (JSON-Zeilen). Zwei Phasen, damit ein Runner ohne Bedienungshilfen-Recht trotzdem etwas belegt:

  Phase 1 "cgevent": nur CGEvent-Eingaben (Klick, Text, Taste) mit AUTARK_MAC_SKIP_TRUST=1 – kommen sie in der App an?
  Phase 2 "ax": AX-Baum, Elementaktionen (invoke/click/set_value), Fensterliste – nur wenn der Prozess vertraut ist (AXIsProcessTrusted).

Ausgabe: je Beleg eine Zeile "PROOF <name>: <Logzeile der Test-App>", am Ende "SUMMARY {...}" als JSON.
Exit 0: mindestens ein Klick UND eine Taste sind in der Test-App belegt (Phase 1 oder 2). Exit 1: nichts angekommen.
Phase 2 ohne Recht wird als "skipped" markiert und lässt den Lauf nicht scheitern.

Aufruf: drive.py <autark-mac-helper> <ax-testapp> [--log-dir DIR]
"""

import json
import os
import re
import subprocess
import sys
import time

HELPER = sys.argv[1] if len(sys.argv) > 1 else ".build/release/autark-mac-helper"
TESTAPP = sys.argv[2] if len(sys.argv) > 2 else ".build/release/ax-testapp"
LOG_DIR = sys.argv[sys.argv.index("--log-dir") + 1] if "--log-dir" in sys.argv else "selftest-out"
os.makedirs(LOG_DIR, exist_ok=True)

summary = {"phases": {}, "proof": []}


def say(text):
    print(text, flush=True)


class Helper:
    def __init__(self, extra_env):
        env = dict(os.environ, AUTARK_MAC_NO_PROMPT="1", **extra_env)
        self.proc = subprocess.Popen([HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, env=env, bufsize=1)
        self.ready = json.loads(self.proc.stdout.readline())
        self.n = 0
        if self.ready.get("protocol") != 4:
            raise RuntimeError("unexpected ready line: %r" % self.ready)

    def call(self, op, **args):
        self.n += 1
        self.proc.stdin.write(json.dumps({"id": self.n, "op": op, "args": args}) + "\n")
        self.proc.stdin.flush()
        answer = json.loads(self.proc.stdout.readline())
        if answer.get("id") != self.n:
            raise RuntimeError("answer for another request: %r" % answer)
        return answer

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


class TestApp:
    def __init__(self, tag):
        self.log_path = os.path.join(LOG_DIR, "testapp-%s.log" % tag)
        open(self.log_path, "w").close()
        env = dict(os.environ, AX_TESTAPP_LOG=self.log_path, AX_TESTAPP_TTL="90")
        self.proc = subprocess.Popen([TESTAPP], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        self.info = None
        deadline = time.time() + 25
        while time.time() < deadline and self.info is None:
            for line in self.lines():
                m = re.match(r"READY pid=(\d+) button=(-?\d+),(-?\d+),(\d+),(\d+) field=(-?\d+),(-?\d+),(\d+),(\d+)", line)
                if m:
                    v = list(map(int, m.groups()))
                    self.info = {"pid": v[0], "button": v[1:5], "field": v[5:9]}
            time.sleep(0.3)
        if self.info is None:
            raise RuntimeError("ax-testapp did not report READY (no window?)")

    def lines(self):
        with open(self.log_path, encoding="utf-8", errors="replace") as handle:
            return handle.read().splitlines()

    def wait_for(self, pattern, since=0, seconds=6):
        rx = re.compile(pattern)
        end = time.time() + seconds
        while time.time() < end:
            for line in self.lines()[since:]:
                if rx.search(line):
                    return line
            time.sleep(0.2)
        return None

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def centre(rect, scale):
    return int((rect[0] + rect[2] / 2) * scale), int((rect[1] + rect[3] / 2) * scale)


def prove(phase, name, line):
    if line:
        say("PROOF %s/%s: %s" % (phase, name, line))
        summary["proof"].append("%s/%s: %s" % (phase, name, line))
    else:
        say("MISS  %s/%s: nothing arrived in the test app" % (phase, name))
    return bool(line)


def probe():
    out = subprocess.run([HELPER, "--probe"], capture_output=True, text=True, timeout=20,
                         env=dict(os.environ, AUTARK_MAC_NO_PROMPT="1"))
    say("PROBE " + out.stdout.strip())
    return json.loads(out.stdout.strip() or "{}")


def phase_cgevent(scale):
    """Klick, Text und Taste per CGEvent – ohne AX-Aufrufe."""
    result = {"click": False, "text": False, "key": False}
    app = TestApp("cgevent")
    helper = Helper({"AUTARK_MAC_SKIP_TRUST": "1", "AUTARK_MAC_SCALE": str(scale)})
    try:
        bx, by = centre(app.info["button"], scale)
        start = len(app.lines())
        answer = helper.call("click", x=bx, y=by, button="left", count=1)
        say("click -> %s" % json.dumps(answer)[:200])
        down = app.wait_for(r"MOUSE_DOWN", start)
        click = app.wait_for(r"CLICK count=\d+ via=mouse", start)
        result["click"] = prove("cgevent", "mouse_down", down) and prove("cgevent", "click", click)

        fx, fy = centre(app.info["field"], scale)
        helper.call("click", x=fx, y=fy, button="left", count=1)
        time.sleep(0.4)
        start = len(app.lines())
        answer = helper.call("type", text="hallo")
        say("type -> %s" % json.dumps(answer)[:200])
        result["text"] = prove("cgevent", "text", app.wait_for(r"TEXT value=.*hallo", start))

        start = len(app.lines())
        answer = helper.call("key", vks=[13])  # Enter
        say("key -> %s" % json.dumps(answer)[:200])
        result["key"] = prove("cgevent", "key_down", app.wait_for(r"KEY_DOWN code=36", start)) and prove("cgevent", "enter", app.wait_for(r"^ENTER", start))
    finally:
        helper.close()
        app.close()
    return result


def attempt(results, name, function):
    """Eine Einzelprüfung: Ausnahmen werden zum Befund, nie zum Abbruch."""
    try:
        results[name] = function()
    except Exception as error:  # noqa: BLE001
        results[name] = "error: %r" % (error,)
    say("CHECK %s -> %s" % (name, results[name]))


def window_of(helper, pid):
    for w in helper.call("windows").get("result", []):
        if w.get("pid") == pid:
            return w
    return {}


def phase_extra(helper, app, hwnd, scale):
    """Weitere Operationen am Test-App-Fenster: Haken, Unicode, Cmd+A, Pfadklick, Ziehen, Rad, Guard, Fensteraktionen, Infos."""
    out = {}
    pid = app.info["pid"]

    def node(aid):
        found = helper.call("find", hwnd=hwnd, aid=aid).get("result", {}).get("nodes", [])
        return found[0] if found else None

    def toggle():
        box = node("haken")
        start = len(app.lines())
        answer = helper.call("act", hwnd=hwnd, rid=box["rid"], action="toggle", value="on", settleMs=200)
        line = app.wait_for(r"CHECK state=1", start)
        state = (answer.get("result", {}).get("element", {}) or {}).get("toggle")
        prove("ax", "toggle_on", line)
        start = len(app.lines())
        helper.call("act", hwnd=hwnd, rid=box["rid"], action="toggle", value="off", settleMs=200)
        off = app.wait_for(r"CHECK state=0", start)
        prove("ax", "toggle_off", off)
        return bool(line and off and state == "on")

    def unicode_text():
        edit = node("eingabe")
        helper.call("act", hwnd=hwnd, rid=edit["rid"], action="focus", settleMs=200)
        helper.call("key", vks=[0x5B, 0x41])  # Cmd+A: alles markieren, der neue Text ersetzt es
        time.sleep(0.3)
        start = len(app.lines())
        helper.call("type", text="Größe 日本 ✓")
        line = app.wait_for(r"TEXT value=Größe 日本 ✓$", start)
        prove("extra", "unicode_cmd_a", line)
        value = node("eingabe").get("value")
        say("PROOF extra/tree_value: %r" % value)
        return bool(line) and value == "Größe 日本 ✓"

    def path_click():
        here = helper.call("cursor").get("result", {})
        bx, by = centre(app.info["button"], scale)
        sx, sy = here.get("x", bx - 80), here.get("y", by - 60)
        start = len(app.lines())
        answer = helper.call("path", steps=[sx, sy, 0, (sx + bx) // 2, (sy + by) // 2, 80, bx, by, 160], end="click", button="left", dwellMs=20, pressMs=30)
        say("path -> %s" % json.dumps(answer)[:200])
        return prove("extra", "path_click", app.wait_for(r"CLICK count=\d+ via=mouse", start))

    def drag_window():
        before = window_of(helper, pid)
        x, y, w, h = before["rect"]
        sx, sy = x + w - 60, y + 12  # Titelleiste
        answer = helper.call("path", steps=[sx, sy, 0], end="drag", drag=[sx, sy, 0, sx + 40, sy + 20, 150, sx + 80, sy + 40, 300], button="left", dwellMs=30, downMs=40, settleMs=40)
        say("drag -> %s" % json.dumps(answer)[:200])
        time.sleep(0.6)
        after = window_of(helper, pid)
        say("PROOF extra/drag: window rect %s -> %s" % (before["rect"], after.get("rect")))
        return after.get("rect", [x, y])[0] - x >= 40

    def wheel():
        x, y = centre(app.info["field"], scale)
        return helper.call("scroll", x=x, y=y, dy=3).get("ok") is True

    def guard_app_window():
        bx, by = centre(node("klick")["rect"], 1)
        helper.call("config", appPids=[pid], apps=None)
        refused = helper.call("click", x=bx, y=by, button="left")
        keyboard = helper.call("key", vks=[0x70])
        start = len(app.lines())
        helper.call("click", x=bx, y=by, button="left", app=True)
        arrived = bool(app.wait_for(r"CLICK count=\d+ via=mouse", start))
        helper.call("config", appPids=[], apps=["nicht-diese-app"])
        forbidden = helper.call("click", x=bx, y=by, button="left")
        helper.call("config", appPids=[], apps=None)
        codes = [refused.get("error", {}).get("code"), keyboard.get("error", {}).get("code"), arrived, forbidden.get("error", {}).get("code")]
        say("PROOF extra/guard: click %s, key %s, cleared click arrived=%s, other app %s" % tuple(codes))
        return codes == ["app_window", "app_window", True, "forbidden"]

    def window_steps():
        a1 = helper.call("act", hwnd=hwnd, action="window_minimize", settleMs=800)
        minimized = window_of(helper, pid).get("minimized")
        a2 = helper.call("act", hwnd=hwnd, action="window_restore", settleMs=800)
        say("window answers: %s | %s" % (json.dumps(a1.get("error") or "ok"), json.dumps(a2.get("error") or "ok")))
        restored = window_of(helper, pid).get("minimized")
        say("PROOF extra/window: minimized=%s then minimized=%s" % (minimized, restored))
        return minimized is True and restored is False

    def infos():
        return {name: helper.call(name).get("result") for name in ("screens", "presence", "cursor", "release")}

    attempt(out, "toggle", toggle)
    attempt(out, "unicode_cmd_a", unicode_text)
    attempt(out, "path_click", path_click)
    attempt(out, "wheel", wheel)
    attempt(out, "guard", guard_app_window)
    attempt(out, "drag_window", drag_window)
    attempt(out, "window_steps", window_steps)
    attempt(out, "infos", infos)
    return out


def phase_untrusted():
    """Nach dem Entzug des Rechts: der Helfer muss im Protokollformat sagen, was fehlt; CGEvent ohne Recht nur beobachten."""
    out = {}
    info = probe()
    out["trusted_after_revoke"] = bool(info.get("trusted"))
    helper = Helper({})
    try:
        for op, args in (("tree", {}), ("windows", {}), ("click", {"x": 5, "y": 5}), ("key", {"vks": [13]})):
            answer = helper.call(op, **args)
            error = answer.get("error", {})
            out[op] = [answer.get("ok"), error.get("code"), "Accessibility" in error.get("message", "")]
            say("CHECK untrusted %s -> %s %s" % (op, error.get("code"), error.get("message", "")[:120]))
        out["ping_ok"] = helper.call("ping").get("ok") is True
        out["config_ok"] = helper.call("config", appPids=[], apps=None).get("ok") is True
    finally:
        helper.close()
    app = TestApp("untrusted")
    helper = Helper({"AUTARK_MAC_SKIP_TRUST": "1"})
    try:
        bx, by = centre(app.info["button"], info.get("scale", 1))
        start = len(app.lines())
        helper.call("click", x=bx, y=by, button="left")
        out["cgevent_click_without_permission_arrives"] = bool(app.wait_for(r"CLICK count=\d+ via=mouse", start, seconds=4))
        say("INFO CGEvent click without Accessibility arrives: %s" % out["cgevent_click_without_permission_arrives"])
    finally:
        helper.close()
        app.close()
    return out


def phase_ax(scale):
    """Baum, Elementaktionen und Fensterliste über AX."""
    result = {}
    app = TestApp("ax")
    helper = Helper({"AUTARK_MAC_SCALE": str(scale)})
    try:
        windows = helper.call("windows")
        if not windows.get("ok"):
            result["error"] = windows.get("error")
            return result
        mine = [w for w in windows["result"] if w.get("pid") == app.info["pid"]]
        result["window_listed"] = bool(mine)
        say("PROOF ax/windows: %s" % json.dumps(mine)[:300])
        if not mine:
            return result
        hwnd = mine[0]["hwnd"]
        helper.call("focus_window", hwnd=hwnd)
        time.sleep(0.5)

        found = helper.call("find", hwnd=hwnd, aid="klick")
        nodes = found.get("result", {}).get("nodes", [])
        result["find_button"] = bool(nodes)
        say("PROOF ax/find: %s" % json.dumps(nodes)[:300])
        tree = helper.call("tree", hwnd=hwnd, depth=8)
        result["tree_nodes"] = len(tree.get("result", {}).get("nodes", []))
        if not nodes:
            return result
        rid = nodes[0]["rid"]

        start = len(app.lines())
        helper.call("act", hwnd=hwnd, rid=rid, action="invoke", settleMs=200)
        result["invoke"] = prove("ax", "invoke", app.wait_for(r"CLICK count=\d+ via=ax", start))

        start = len(app.lines())
        helper.call("act", hwnd=hwnd, rid=rid, action="click", settleMs=200)
        result["click"] = prove("ax", "click", app.wait_for(r"CLICK count=\d+ via=mouse", start))

        edit = helper.call("find", hwnd=hwnd, aid="eingabe").get("result", {}).get("nodes", [])
        if edit:
            set_value = helper.call("act", hwnd=hwnd, rid=edit[0]["rid"], action="set_value", value="per AX gesetzt", settleMs=200)
            value = (set_value.get("result", {}).get("element", {}) or {}).get("value")
            result["set_value"] = value == "per AX gesetzt"
            say("PROOF ax/set_value: element.value=%r" % value)
            helper.call("act", hwnd=hwnd, rid=edit[0]["rid"], action="focus")
            time.sleep(0.3)
            start = len(app.lines())
            helper.call("key", vks=[13])
            result["key"] = prove("ax", "key", app.wait_for(r"KEY_DOWN code=36", start))
            focused = helper.call("focused").get("result", {}).get("nodes", [])
            result["focused"] = bool(focused)
            say("PROOF ax/focused: %s" % json.dumps(focused)[:200])
        result["extra"] = phase_extra(helper, app, hwnd, scale)
    finally:
        helper.close()
        app.close()
    return result


def main():
    if "--untrusted" in sys.argv:
        result = phase_untrusted()
        say("SUMMARY-UNTRUSTED " + json.dumps(result))
        refused = all(result.get(op, [None, None, None])[1:] == ["unavailable", True] for op in ("tree", "windows", "click", "key"))
        if refused and result.get("ping_ok") and result.get("config_ok"):
            return 0
        return 3 if result.get("trusted_after_revoke") else 1
    info = probe()
    scale = info.get("scale", 1)
    summary["probe"] = info
    trusted = bool(info.get("trusted"))

    try:
        summary["phases"]["cgevent"] = phase_cgevent(scale)
    except Exception as error:  # Diagnose statt Absturz
        summary["phases"]["cgevent"] = {"error": repr(error)}

    if trusted:
        try:
            summary["phases"]["ax"] = phase_ax(scale)
        except Exception as error:
            summary["phases"]["ax"] = {"error": repr(error)}
    else:
        summary["phases"]["ax"] = {"skipped": "AXIsProcessTrusted() is false in this process (no Accessibility permission)"}
        say("SKIP  ax phase: no Accessibility permission for this process")

    cg = summary["phases"]["cgevent"]
    ax = summary["phases"].get("ax", {})
    clicked = bool(cg.get("click") or ax.get("click") or ax.get("invoke"))
    keyed = bool(cg.get("key") or ax.get("key"))
    summary["click_proven"] = clicked
    summary["key_proven"] = keyed
    say("SUMMARY " + json.dumps(summary))
    with open(os.path.join(LOG_DIR, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=2)
    return 0 if clicked and keyed else 1


if __name__ == "__main__":
    sys.exit(main())
