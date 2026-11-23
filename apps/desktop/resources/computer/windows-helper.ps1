# Workforce computer-use helper for Windows (protocol 4, B-055: 'path' replays a planned pointer path;
# protocol 3, B-044: the Workforce app's windows are operable after the window's own check; protocol
# 2 added the 'release' op).
# One persistent Windows PowerShell 5.1 process started by the runtime with
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File windows-helper.ps1
# It reads one JSON request per line on stdin and writes one JSON line per answer on stdout:
#   -> {"id":1,"op":"tree","args":{"hwnd":1234}}
#   <- {"id":1,"ok":true,"result":{...}}   or   {"id":1,"ok":false,"error":{"code":"...","message":"..."}}
# The first line it writes is {"ready":true,"protocol":4,"pid":...,"dpiAware":true}.
# The Workforce app (its process ids from 'config' appPids): a click, a drag's ends, keys, typed
# text or an element action that would reach one of its windows answers code 'app_window' with
# error.app = {window, point | rect | keyboard} and sends nothing, until the request carries
# "app": <that window> – the runtime asked the window whether the target is a guarded control
# (runtime/computer/app-guard.ts). Moves, wheel steps and focusing its window need no clearance.
# An element of the app reached through another window (the desktop root) is refused outright.
# Sicher-Runde 19.11.2026 (additive, protocol 4 stays): Trust AI mode sends no pids (today's open helper); Secure mode
# sends Autark's pids and never clears a window, and with chosen apps 'config' also takes `apps` (process names):
# a press, keys or an element action for any other process answers 'forbidden' and sends nothing.
# B-055 'path' (runtime/computer/motion.ts): steps x, y, t (ms since the start) replayed on a
# Stopwatch with 1 ms timer resolution, then a click (hold pressMs), a drag along a second path or
# wheel steps; an element click ('act' with `path`) bends the path onto the element's clickable
# point. The person moving the mouse (the pointer is no longer where our last step left it) or
# holding a button stops it: 'human_active' before anything was pressed; a drag already held is let
# go at once and reported as 'conflict'. 'cursor' also reports the idle times (like 'presence') and, B-081, `window`:
# the title of the top-level window under the pointer (at most 120 characters, none when it has no title).
# B-080 (additive, protocol 4 stays): 'focused' answers the element that holds the keyboard focus and its window;
# 'act' takes `expect` and then re-reads every 100 ms until that state shows, at most 2 s (answering `waitedMs`), and
# counts a closed window or a dead node as gone; window_* acts on the window id alone; toggle on/off waits for each
# change (at most 1 s) before the next; a window screenshot is the window drawing itself (PrintWindow), also behind
# another window or off the screen; focus_window brings a window that lies off every screen onto the primary one, and
# where Windows' foreground lock leaves another window in front, it attaches to that window's input thread for
# BringWindowToTop/SetForegroundWindow and lets go (no key presses); an unsupported pattern names the element's
# computer.act actions.
# Owns: SendInput (Unicode typing, keys, mouse; 'release' lets go of mouse buttons and
# Ctrl/Shift/Alt/Win keys Windows still reports held after a Stop killed the helper mid-drag or
# mid-chord – it never presses anything), window list/focus, the UI Automation tree with a
# CacheRequest and node caps, pattern actions, GDI screenshots (downscaled JPEG) and optional
# Windows.Media.Ocr. The C# part is compiled once per process with Add-Type.
# Never: uses the clipboard, focuses a window unless asked (focus_window / act focus), presses or
# types into a Workforce window without its clearance, or writes anything but protocol lines to
# stdout. Stdin and stdout are pure ASCII JSON (non-ASCII is \u-escaped both ways).

$ErrorActionPreference = 'Stop'
Set-StrictMode -Off

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using SD = System.Drawing;
using SDI = System.Drawing.Imaging;

namespace WorkforceHelper
{
    public class HelperException : Exception
    {
        public readonly string Code;
        public HelperException(string code, string message) : base(message) { Code = code; }
    }

    /// Input that would reach a Workforce window without its clearance: what it would hit (error.app).
    public class AppWindowException : HelperException
    {
        public readonly Dictionary<string, object> App;
        public AppWindowException(string message, Dictionary<string, object> app) : base("app_window", message) { App = app; }
    }

    // ------------------------------------------------------------------ JSON (no dependencies)
    public static class Json
    {
        public static object Parse(string text)
        {
            int i = 0;
            object value = ReadValue(text, ref i);
            SkipWs(text, ref i);
            if (i != text.Length) throw new HelperException("bad_request", "Invalid JSON.");
            return value;
        }

        static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        static void Expect(string s, ref int i, char c)
        {
            if (i >= s.Length || s[i] != c) throw new HelperException("bad_request", "Invalid JSON.");
            i++;
        }

        static bool Word(string s, ref int i, string word)
        {
            if (i + word.Length > s.Length || string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return false;
            i += word.Length;
            return true;
        }

        static object ReadValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            if (i >= s.Length) throw new HelperException("bad_request", "Invalid JSON.");
            char c = s[i];
            if (c == '{')
            {
                i++;
                Dictionary<string, object> obj = new Dictionary<string, object>();
                SkipWs(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return obj; }
                while (true)
                {
                    SkipWs(s, ref i);
                    string key = ReadString(s, ref i);
                    SkipWs(s, ref i);
                    Expect(s, ref i, ':');
                    obj[key] = ReadValue(s, ref i);
                    SkipWs(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    Expect(s, ref i, '}');
                    return obj;
                }
            }
            if (c == '[')
            {
                i++;
                List<object> list = new List<object>();
                SkipWs(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(ReadValue(s, ref i));
                    SkipWs(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    Expect(s, ref i, ']');
                    return list;
                }
            }
            if (c == '"') return ReadString(s, ref i);
            if (Word(s, ref i, "true")) return true;
            if (Word(s, ref i, "false")) return false;
            if (Word(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            double number;
            if (i == start || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out number))
                throw new HelperException("bad_request", "Invalid JSON number.");
            return number;
        }

        static string ReadString(string s, ref int i)
        {
            Expect(s, ref i, '"');
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) throw new HelperException("bad_request", "Invalid JSON string.");
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) throw new HelperException("bad_request", "Invalid JSON string.");
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new HelperException("bad_request", "Invalid JSON escape.");
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new HelperException("bad_request", "Invalid JSON escape.");
                }
            }
        }

        public static string Write(object value)
        {
            StringBuilder sb = new StringBuilder();
            WriteValue(sb, value, 0);
            return sb.ToString();
        }

        static void WriteValue(StringBuilder sb, object value, int depth)
        {
            if (depth > 64) throw new HelperException("internal", "JSON nesting too deep.");
            if (value == null) { sb.Append("null"); return; }
            // Values built in PowerShell (the OCR result) arrive wrapped in PSObject: unwrap via
            // reflection (no reference to System.Management.Automation needed), else a list would
            // be written as one string of type names.
            if (value.GetType().FullName == "System.Management.Automation.PSObject")
            {
                System.Reflection.PropertyInfo baseObject = value.GetType().GetProperty("BaseObject");
                object inner = baseObject != null ? baseObject.GetValue(value, null) : null;
                if (inner != null && !ReferenceEquals(inner, value)) { WriteValue(sb, inner, depth + 1); return; }
            }
            string text = value as string;
            if (text != null) { WriteString(sb, text); return; }
            if (value is bool) { sb.Append((bool)value ? "true" : "false"); return; }
            if (value is int || value is long || value is uint || value is short || value is ushort || value is byte)
            {
                sb.Append(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is double || value is float || value is decimal)
            {
                double d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
                else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            IDictionary<string, object> dict = value as IDictionary<string, object>;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (KeyValuePair<string, object> pair in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, pair.Key);
                    sb.Append(':');
                    WriteValue(sb, pair.Value, depth + 1);
                }
                sb.Append('}');
                return;
            }
            IEnumerable list = value as IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteValue(sb, item, depth + 1);
                }
                sb.Append(']');
                return;
            }
            WriteString(sb, value.ToString());
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            sb.Append('"');
        }
    }

    // ------------------------------------------------------------------ argument access
    public static class Args
    {
        public static object Get(Dictionary<string, object> a, string key)
        {
            object v;
            return a != null && a.TryGetValue(key, out v) ? v : null;
        }

        public static bool Has(Dictionary<string, object> a, string key) { return Get(a, key) != null; }

        public static double Num(Dictionary<string, object> a, string key, double fallback)
        {
            object v = Get(a, key);
            if (v == null) return fallback;
            if (!(v is double)) throw new HelperException("bad_request", key + " must be a number.");
            double d = (double)v;
            if (double.IsNaN(d) || double.IsInfinity(d)) throw new HelperException("bad_request", key + " must be a finite number.");
            return d;
        }

        public static int Int(Dictionary<string, object> a, string key, int fallback)
        {
            double d = Num(a, key, fallback);
            if (d > int.MaxValue || d < int.MinValue) throw new HelperException("bad_request", key + " is out of range.");
            return (int)Math.Round(d);
        }

        public static int ReqInt(Dictionary<string, object> a, string key)
        {
            if (!Has(a, key)) throw new HelperException("bad_request", key + " is required.");
            return Int(a, key, 0);
        }

        public static string Str(Dictionary<string, object> a, string key, string fallback)
        {
            object v = Get(a, key);
            if (v == null) return fallback;
            string s = v as string;
            if (s == null) throw new HelperException("bad_request", key + " must be a string.");
            return s;
        }

        public static Dictionary<string, object> Obj(Dictionary<string, object> a, string key)
        {
            return Get(a, key) as Dictionary<string, object>;
        }

        public static List<object> List(Dictionary<string, object> a, string key)
        {
            return Get(a, key) as List<object>;
        }

        public static int Clamp(int value, int min, int max) { return Math.Max(min, Math.Min(max, value)); }

        public static string Clip(string s, int max)
        {
            if (s == null) return "";
            return s.Length > max ? s.Substring(0, max) : s;
        }
    }

    // ------------------------------------------------------------------ Win32
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }

        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);

        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        [DllImport("kernel32.dll")] public static extern uint GetTickCount();
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
        [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint period);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, ref RECT value, uint winIni);

        /// Per-monitor DPI awareness: UIA rectangles, GDI capture and SendInput then all use
        /// physical pixels of the virtual desktop. When the process awareness is already fixed,
        /// the calling thread (the one that runs every request) is switched instead.
        public static bool InitDpi()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch (EntryPointNotFoundException) { }
            try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return true; } catch (EntryPointNotFoundException) { }
            try { return SetProcessDPIAware(); } catch (Exception) { return false; }
        }

        public static SD.Rectangle VirtualScreen()
        {
            return new SD.Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
        }
    }

    // ------------------------------------------------------------------ safety gates
    // The Workforce app's windows (B-044): a press, keys or an element action that reaches one is
    // refused with 'app_window' until the request clears exactly that top-level window ("app").
    // Sicher-Runde 19.11.2026: in Secure mode the runtime sends Autark's process ids and never clears a window; with
    // computer use set to chosen apps it also sends `apps` (process names, lower case, no .exe) and input reaches only
    // windows of those processes (null: every app).
    public static class Guard
    {
        public static readonly Dictionary<int, bool> AppPids = new Dictionary<int, bool>();
        public static HashSet<string> Apps = null;

        /// The process name of pid (lower case), or "" when it cannot be read.
        static string NameOf(int pid)
        {
            try { return System.Diagnostics.Process.GetProcessById(pid).ProcessName.ToLowerInvariant(); } catch (Exception) { return ""; }
        }

        /// Input for a process that is not among the chosen apps is refused (Autark's own windows are AppRoot's).
        public static void ListedPid(int pid)
        {
            if (Apps == null || AppPids.ContainsKey(pid)) return;
            string name = NameOf(pid);
            if (name.Length > 0 && Apps.Contains(name)) return;
            throw new HelperException("forbidden", "That input would reach " + (name.Length > 0 ? name : "a window whose app I cannot tell") + ", which is not among the apps open to me in this company. With its window named (computer.windows lists it), the app asks for it.");
        }

        /// The same for the top-level window hwnd belongs to.
        public static void Listed(IntPtr hwnd)
        {
            if (Apps == null || hwnd == IntPtr.Zero) return;
            IntPtr root = Native.GetAncestor(hwnd, 3); // GA_ROOTOWNER
            if (root == IntPtr.Zero) root = hwnd;
            uint pid;
            Native.GetWindowThreadProcessId(root, out pid);
            ListedPid((int)pid);
        }

        /// The app's top-level window hwnd belongs to (GA_ROOTOWNER: menus and dialogs count), or Zero.
        public static IntPtr AppRoot(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || AppPids.Count == 0) return IntPtr.Zero;
            IntPtr root = Native.GetAncestor(hwnd, 3); // GA_ROOTOWNER
            if (root == IntPtr.Zero) root = hwnd;
            uint pid;
            Native.GetWindowThreadProcessId(root, out pid);
            if (AppPids.ContainsKey((int)pid)) return root;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            return AppPids.ContainsKey((int)pid) ? root : IntPtr.Zero;
        }

        /// The window the runtime cleared for this request (its "app" argument), or 0.
        public static long Cleared(Dictionary<string, object> a)
        {
            object v = Args.Get(a, "app");
            return v is double ? (long)(double)v : 0;
        }

        static Dictionary<string, object> Hit(IntPtr root)
        {
            Dictionary<string, object> app = new Dictionary<string, object>();
            app["window"] = root.ToInt64();
            return app;
        }

        public static void OnScreen(int x, int y)
        {
            SD.Rectangle vs = Native.VirtualScreen();
            if (x < vs.Left || y < vs.Top || x >= vs.Right || y >= vs.Bottom)
                throw new HelperException("bad_request", "The point (" + x + ", " + y + ") is outside the screen (" + vs.Left + "," + vs.Top + " " + vs.Width + "x" + vs.Height + ").");
        }

        /// A press or release at (x, y).
        public static void Point(int x, int y, long cleared)
        {
            OnScreen(x, y);
            Native.POINT p = new Native.POINT();
            p.X = x;
            p.Y = y;
            IntPtr under = Native.WindowFromPoint(p);
            Listed(under);
            IntPtr root = AppRoot(under);
            if (root == IntPtr.Zero || root.ToInt64() == cleared) return;
            Dictionary<string, object> app = Hit(root);
            Dictionary<string, object> at = new Dictionary<string, object>();
            at["x"] = x;
            at["y"] = y;
            app["point"] = at;
            throw new AppWindowException("That point is on Autark's own window, which stays closed to computer use in this company.", app);
        }

        /// Keys and typed text go to the window in front.
        public static void Foreground(long cleared)
        {
            IntPtr front = Native.GetForegroundWindow();
            Listed(front);
            IntPtr root = AppRoot(front);
            if (root == IntPtr.Zero || root.ToInt64() == cleared) return;
            Dictionary<string, object> app = Hit(root);
            app["keyboard"] = true;
            throw new AppWindowException("Autark's own window has the keyboard, and it stays closed to computer use in this company.", app);
        }

        /// An element action in a window of the app: the element's rectangle is checked first.
        public static void Element(IntPtr hwnd, AutomationElement.AutomationElementInformation current, long cleared)
        {
            ListedPid(current.ProcessId);
            IntPtr root = AppRoot(hwnd);
            if (root == IntPtr.Zero) root = AppRoot(new IntPtr(current.NativeWindowHandle));
            // A web element of the app has no window handle of its own: reached through another
            // window (the desktop root) it would skip the check, so its process decides then.
            if (root == IntPtr.Zero && AppPids.ContainsKey(current.ProcessId))
                throw new HelperException("forbidden", "That element is in Autark's own window, which stays closed to computer use in this company.");
            if (root == IntPtr.Zero || root.ToInt64() == cleared) return;
            Dictionary<string, object> app = Hit(root);
            System.Windows.Rect r = current.BoundingRectangle;
            if (!r.IsEmpty && r.Width > 0 && r.Height > 0)
                app["rect"] = new List<object> { (int)Math.Round(r.X), (int)Math.Round(r.Y), (int)Math.Round(r.Width), (int)Math.Round(r.Height) };
            throw new AppWindowException("That element is in Autark's own window, which stays closed to computer use in this company.", app);
        }
    }

    // ------------------------------------------------------------------ input (SendInput, never the clipboard)
    public static class Input
    {
        const uint INPUT_MOUSE = 0;
        const uint INPUT_KEYBOARD = 1;
        const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
        const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
        const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004;
        public static uint LastInjectTick = 0;

        static void Send(Native.INPUT[] inputs)
        {
            if (inputs.Length == 0) return;
            uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
            LastInjectTick = Native.GetTickCount();
            if (sent != inputs.Length)
                throw new HelperException("forbidden", "Windows blocked the input: an administrator window or the secure desktop (lock screen, UAC prompt) is in front, which the desktop broker reaches.");
        }

        static Native.INPUT Mouse(uint flags, int dx, int dy, uint data)
        {
            Native.INPUT input = new Native.INPUT();
            input.type = INPUT_MOUSE;
            input.U.mi.dx = dx;
            input.U.mi.dy = dy;
            input.U.mi.mouseData = data;
            input.U.mi.dwFlags = flags;
            return input;
        }

        static bool Extended(ushort vk)
        {
            return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D
                || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5 || vk == 0x2C;
        }

        static Native.INPUT Key(ushort vk, bool up)
        {
            Native.INPUT input = new Native.INPUT();
            input.type = INPUT_KEYBOARD;
            input.U.ki.wVk = vk;
            input.U.ki.wScan = (ushort)Native.MapVirtualKey(vk, 0);
            input.U.ki.dwFlags = (up ? KEY_UP : 0) | (Extended(vk) ? KEY_EXTENDED : 0);
            return input;
        }

        static Native.INPUT Unicode(char c, bool up)
        {
            Native.INPUT input = new Native.INPUT();
            input.type = INPUT_KEYBOARD;
            input.U.ki.wVk = 0;
            input.U.ki.wScan = c;
            input.U.ki.dwFlags = KEY_UNICODE | (up ? KEY_UP : 0);
            return input;
        }

        public static uint[] Buttons(string button)
        {
            if (button == "left") return new uint[] { LEFTDOWN, LEFTUP };
            if (button == "right") return new uint[] { RIGHTDOWN, RIGHTUP };
            if (button == "middle") return new uint[] { MIDDLEDOWN, MIDDLEUP };
            throw new HelperException("bad_request", "button must be left, right or middle.");
        }

        static void MoveAbsolute(int x, int y)
        {
            SD.Rectangle vs = Native.VirtualScreen();
            int nx = (int)Math.Round((x - vs.Left) * 65535.0 / Math.Max(1, vs.Width - 1));
            int ny = (int)Math.Round((y - vs.Top) * 65535.0 / Math.Max(1, vs.Height - 1));
            Send(new Native.INPUT[] { Mouse(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny, 0) });
        }

        /// Moves to the exact pixel: a real input move event (apps see hover) plus a snap.
        public static void MoveTo(int x, int y)
        {
            Guard.OnScreen(x, y);
            MoveAbsolute(x, y);
            Native.SetCursorPos(x, y);
        }

        /// An intermediate step of a path: kept inside the virtual screen (an overshoot at its edge), never refused.
        public static void MoveClamped(int x, int y)
        {
            SD.Rectangle vs = Native.VirtualScreen();
            x = Math.Max(vs.Left, Math.Min(vs.Right - 1, x));
            y = Math.Max(vs.Top, Math.Min(vs.Bottom - 1, y));
            MoveAbsolute(x, y);
            Native.SetCursorPos(x, y);
        }

        public static void SendMouse(uint flags) { Send(new Native.INPUT[] { Mouse(flags, 0, 0, 0) }); }

        /// Wheel steps where the pointer is: dy > 0 scrolls down, dx > 0 right; one step = one notch.
        public static void Wheel(int dx, int dy)
        {
            List<Native.INPUT> list = new List<Native.INPUT>();
            if (dy != 0) list.Add(Mouse(WHEEL, 0, 0, unchecked((uint)(-dy * 120))));
            if (dx != 0) list.Add(Mouse(HWHEEL, 0, 0, unchecked((uint)(dx * 120))));
            Send(list.ToArray());
        }

        /// Where a step ended: the point and the top-level window under it (id and title).
        public static Dictionary<string, object> At(int x, int y)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["done"] = true;
            d["at"] = new List<object> { x, y };
            Native.POINT p = new Native.POINT();
            p.X = x;
            p.Y = y;
            IntPtr root = Native.GetAncestor(Native.WindowFromPoint(p), 2); // GA_ROOT
            if (root != IntPtr.Zero)
            {
                d["window"] = root.ToInt64();
                StringBuilder title = new StringBuilder(Math.Min(512, Native.GetWindowTextLength(root) + 1));
                Native.GetWindowText(root, title, title.Capacity);
                d["title"] = Args.Clip(title.ToString(), 200);
            }
            return d;
        }

        public static void Click(int x, int y, string button, int count, long cleared)
        {
            uint[] flags = Buttons(button);
            Guard.Point(x, y, cleared);
            MoveTo(x, y);
            Thread.Sleep(30);
            for (int n = 0; n < count; n++)
            {
                Send(new Native.INPUT[] { Mouse(flags[0], 0, 0, 0), Mouse(flags[1], 0, 0, 0) });
                if (n + 1 < count) Thread.Sleep(60);
            }
        }

        /// dy > 0 scrolls down (content moves up), dx > 0 scrolls right; one step = one wheel notch.
        /// Wheel steps press nothing, so they need no clearance on a Workforce window either.
        public static void Scroll(bool hasPoint, int x, int y, int dx, int dy)
        {
            if (hasPoint) { MoveTo(x, y); Thread.Sleep(30); }
            List<Native.INPUT> list = new List<Native.INPUT>();
            if (dy != 0) list.Add(Mouse(WHEEL, 0, 0, unchecked((uint)(-dy * 120))));
            if (dx != 0) list.Add(Mouse(HWHEEL, 0, 0, unchecked((uint)(dx * 120))));
            Send(list.ToArray());
        }

        /// Unicode typing via KEYEVENTF_UNICODE (layout independent); newline = Enter, tab = Tab.
        public static void Type(string text, long cleared)
        {
            Guard.Foreground(cleared);
            List<Native.INPUT> batch = new List<Native.INPUT>();
            foreach (char c in text)
            {
                if (c == '\r') continue;
                if (c == '\n') { batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); }
                else if (c == '\t') { batch.Add(Key(0x09, false)); batch.Add(Key(0x09, true)); }
                else { batch.Add(Unicode(c, false)); batch.Add(Unicode(c, true)); }
                if (batch.Count >= 40)
                {
                    Send(batch.ToArray());
                    batch.Clear();
                    Thread.Sleep(8);
                }
            }
            Send(batch.ToArray());
        }

        /// Presses a chord: keys down in order, released in reverse order (always released).
        public static void Chord(List<object> vks, int repeat, long cleared)
        {
            Guard.Foreground(cleared);
            if (vks == null || vks.Count == 0 || vks.Count > 4) throw new HelperException("bad_request", "vks needs 1 to 4 keys.");
            ushort[] codes = new ushort[vks.Count];
            for (int i = 0; i < vks.Count; i++)
            {
                if (!(vks[i] is double)) throw new HelperException("bad_request", "vks must be numbers.");
                double d = (double)vks[i];
                if (d < 1 || d > 254) throw new HelperException("bad_request", "Invalid virtual key.");
                codes[i] = (ushort)d;
            }
            for (int r = 0; r < repeat; r++)
            {
                Native.INPUT[] down = new Native.INPUT[codes.Length];
                Native.INPUT[] up = new Native.INPUT[codes.Length];
                for (int i = 0; i < codes.Length; i++)
                {
                    down[i] = Key(codes[i], false);
                    up[codes.Length - 1 - i] = Key(codes[i], true);
                }
                try { Send(down); Thread.Sleep(25); }
                finally { Send(up); }
                if (r + 1 < repeat) Thread.Sleep(40);
            }
        }

        static readonly string[] HeldButtons = { "left", "right", "middle" };
        static readonly int[] HeldButtonVks = { 0x01, 0x02, 0x04 };
        static readonly ushort[] HeldKeys = { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C };
        static readonly string[] HeldKeyNames = { "lshift", "rshift", "lctrl", "rctrl", "lalt", "ralt", "lwin", "rwin" };

        /// After a Stop killed the helper during a drag or a chord (their finally never ran): sends
        /// the up event for each mouse button and Ctrl/Shift/Alt/Win key Windows reports as held.
        /// Never presses anything; returns the names it let go of.
        public static List<object> Release()
        {
            List<object> released = new List<object>();
            for (int i = 0; i < HeldButtons.Length; i++)
            {
                if ((Native.GetAsyncKeyState(HeldButtonVks[i]) & 0x8000) == 0) continue;
                Send(new Native.INPUT[] { Mouse(Buttons(HeldButtons[i])[1], 0, 0, 0) });
                released.Add(HeldButtons[i]);
            }
            for (int i = 0; i < HeldKeys.Length; i++)
            {
                if ((Native.GetAsyncKeyState(HeldKeys[i]) & 0x8000) == 0) continue;
                Send(new Native.INPUT[] { Key(HeldKeys[i], true) });
                released.Add(HeldKeyNames[i]);
            }
            return released;
        }
    }

    // ------------------------------------------------------------------ pointer paths (B-055)
    /// One planned path replayed with precise timing (runtime/computer/motion.ts): flat steps
    /// x, y, t (whole px, ms since the start), then a click, a drag along a second path, or wheel
    /// steps. The person moving the mouse - the pointer is not where our last step left it, beyond a
    /// few pixels of sensor noise - or holding a button stops it: 'human_active' before anything was
    /// pressed; a drag already held is let go at once ('conflict', the effect needs a look).
    public static class PathMotion
    {
        const int Tolerance = 4;
        const int MaxSteps = 1000;

        static int[] Steps(Dictionary<string, object> a, string key)
        {
            List<object> raw = Args.List(a, key);
            if (raw == null || raw.Count == 0 || raw.Count % 3 != 0 || raw.Count > MaxSteps * 3)
                throw new HelperException("bad_request", key + " must be 1 to " + MaxSteps + " steps of x, y, t.");
            int[] steps = new int[raw.Count];
            int lastT = 0;
            for (int i = 0; i < raw.Count; i++)
            {
                if (!(raw[i] is double)) throw new HelperException("bad_request", key + " must be numbers.");
                double d = (double)raw[i];
                if (double.IsNaN(d) || double.IsInfinity(d) || Math.Abs(d) > 1000000) throw new HelperException("bad_request", key + " must be finite numbers.");
                steps[i] = (int)Math.Round(d);
                if (i % 3 != 2) continue;
                if (steps[i] < lastT || steps[i] > 60000) throw new HelperException("bad_request", key + ": t must never fall and stay within 60 s.");
                lastT = steps[i];
            }
            return steps;
        }

        static void WaitUntil(System.Diagnostics.Stopwatch clock, long t)
        {
            long wait = t - clock.ElapsedMilliseconds;
            if (wait > 1) Thread.Sleep((int)(wait - 1));
            while (clock.ElapsedMilliseconds < t) Thread.Sleep(0);
        }

        /// The person moved the pointer since `last` (where our own step left it).
        static void Interrupted(Native.POINT last, bool held)
        {
            Native.POINT now;
            Native.GetCursorPos(out now);
            if (Math.Abs(now.X - last.X) <= Tolerance && Math.Abs(now.Y - last.Y) <= Tolerance) return;
            if (held) throw new HelperException("conflict", "The person moved the mouse during the drag, so it was let go early at " + now.X + "," + now.Y + ". Look at the screen before you go on.");
            throw new HelperException("human_active", "The person moved the mouse, so the pointer stopped on its way and nothing was pressed.");
        }

        static void ButtonsUp()
        {
            if ((Native.GetAsyncKeyState(0x01) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x02) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x04) & 0x8000) != 0)
                throw new HelperException("human_active", "The person is holding a mouse button, so nothing was pressed.");
        }

        /// The pointer must still be where the runtime read it before planning (`from`).
        static Native.POINT Start(Dictionary<string, object> a)
        {
            Native.POINT now;
            Native.GetCursorPos(out now);
            List<object> from = Args.List(a, "from");
            if (from == null) return now;
            if (from.Count != 2 || !(from[0] is double) || !(from[1] is double)) throw new HelperException("bad_request", "from must be [x, y].");
            if (Math.Abs(now.X - (int)Math.Round((double)from[0])) > Tolerance || Math.Abs(now.Y - (int)Math.Round((double)from[1])) > Tolerance)
                throw new HelperException("human_active", "The person moved the mouse since this step was planned; nothing was pressed.");
            return now;
        }

        /// Replays steps on the stopwatch; a step that is already late is skipped (the last one never). `last`: where our previous step left the pointer.
        static Native.POINT Replay(int[] steps, Native.POINT last, bool held)
        {
            System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
            int n = steps.Length / 3;
            for (int i = 0; i < n; i++)
            {
                bool final = i == n - 1;
                if (!final && clock.ElapsedMilliseconds >= steps[3 * (i + 1) + 2]) continue;
                WaitUntil(clock, steps[3 * i + 2]);
                Interrupted(last, held);
                if (final) Input.MoveTo(steps[3 * i], steps[3 * i + 1]);
                else Input.MoveClamped(steps[3 * i], steps[3 * i + 1]);
                // Where the pointer really is now (a monitor edge may clamp it) is the reference for the next check.
                Native.GetCursorPos(out last);
            }
            return last;
        }

        static void Press(string button, int count, int pressMs, int gapMs)
        {
            uint[] flags = Input.Buttons(button);
            for (int c = 0; c < count; c++)
            {
                Input.SendMouse(flags[0]);
                try { if (pressMs > 0) Thread.Sleep(pressMs); }
                finally { Input.SendMouse(flags[1]); }
                if (c + 1 < count) Thread.Sleep(gapMs);
            }
        }

        static void ClickAlong(Dictionary<string, object> a, int[] steps, string button, int count)
        {
            Native.POINT last = Start(a);
            Native.timeBeginPeriod(1);
            try
            {
                last = Replay(steps, last, false);
                Thread.Sleep(Args.Clamp(Args.Int(a, "dwellMs", 20), 0, 1000));
                Interrupted(last, false);
                ButtonsUp();
                Press(button, count, Args.Clamp(Args.Int(a, "pressMs", 0), 0, 500), Args.Clamp(Args.Int(a, "gapMs", 60), 20, 400));
            }
            finally { Native.timeEndPeriod(1); }
        }

        /// op 'path': end none (a hover), click, drag (args.drag: the held path) or wheel (dx, dy).
        public static Dictionary<string, object> Run(Dictionary<string, object> a)
        {
            int[] steps = Steps(a, "steps");
            string end = Args.Str(a, "end", "none");
            string button = Args.Str(a, "button", "left");
            long cleared = Guard.Cleared(a);
            int fx = steps[steps.Length - 3], fy = steps[steps.Length - 2];
            Guard.OnScreen(fx, fy);
            if (end == "click")
            {
                Input.Buttons(button);
                Guard.Point(fx, fy, cleared);
                ClickAlong(a, steps, button, Args.Clamp(Args.Int(a, "count", 1), 1, 3));
                return Input.At(fx, fy);
            }
            if (end == "drag")
            {
                uint[] flags = Input.Buttons(button);
                int[] held = Steps(a, "drag");
                int tx = held[held.Length - 3], ty = held[held.Length - 2];
                Guard.OnScreen(tx, ty);
                Guard.Point(fx, fy, cleared); // both ends before the button goes down: never half a drag
                Guard.Point(tx, ty, cleared);
                Native.POINT last = Start(a);
                Native.timeBeginPeriod(1);
                try
                {
                    last = Replay(steps, last, false);
                    Thread.Sleep(Args.Clamp(Args.Int(a, "dwellMs", 40), 0, 1000));
                    Interrupted(last, false);
                    ButtonsUp();
                    Input.SendMouse(flags[0]);
                    try
                    {
                        Thread.Sleep(Args.Clamp(Args.Int(a, "downMs", 60), 0, 1000));
                        Replay(held, last, true);
                        Thread.Sleep(Args.Clamp(Args.Int(a, "settleMs", 60), 0, 1000));
                    }
                    finally { Input.SendMouse(flags[1]); } // the button is always released, even on errors
                }
                finally { Native.timeEndPeriod(1); }
                return Input.At(tx, ty);
            }
            if (end != "none" && end != "wheel") throw new HelperException("bad_request", "end must be none, click, drag or wheel.");
            Native.POINT at = Start(a);
            Native.timeBeginPeriod(1);
            try
            {
                at = Replay(steps, at, false);
                if (end == "wheel")
                {
                    // Wheel steps press nothing, so they need no clearance on a Workforce window either.
                    Thread.Sleep(Args.Clamp(Args.Int(a, "dwellMs", 20), 0, 1000));
                    Interrupted(at, false);
                    Input.Wheel(Args.Clamp(Args.Int(a, "dx", 0), -50, 50), Args.Clamp(Args.Int(a, "dy", 0), -50, 50));
                }
            }
            finally { Native.timeEndPeriod(1); }
            return Input.At(fx, fy);
        }

        /// An element click with a planned path (op 'act'): the path ends at the observed centre; the
        /// element's clickable point may differ a little, so the path is bent onto it (more towards the end).
        public static void ElementClick(Dictionary<string, object> a, int px, int py, string button, int count, long cleared)
        {
            int[] steps = Steps(a, "steps");
            int n = steps.Length / 3;
            int dx = px - steps[3 * n - 3], dy = py - steps[3 * n - 2];
            double total = Math.Max(1, steps[3 * n - 1]);
            for (int i = 0; i < n; i++)
            {
                double f = steps[3 * i + 2] / total;
                steps[3 * i] += (int)Math.Round(dx * f);
                steps[3 * i + 1] += (int)Math.Round(dy * f);
            }
            steps[3 * n - 3] = px;
            steps[3 * n - 2] = py;
            Guard.Point(px, py, cleared);
            ClickAlong(a, steps, button, count);
        }
    }

    // ------------------------------------------------------------------ presence of the human
    public static class Presence
    {
        public static Dictionary<string, object> Read()
        {
            Native.LASTINPUTINFO info = new Native.LASTINPUTINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(Native.LASTINPUTINFO));
            Native.GetLastInputInfo(ref info);
            uint now = Native.GetTickCount();
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["idleMs"] = (long)unchecked(now - info.dwTime);
            d["injectedAgoMs"] = Input.LastInjectTick == 0 ? null : (object)(long)unchecked(now - Input.LastInjectTick);
            return d;
        }
    }

    // ------------------------------------------------------------------ screens and capture
    public static class Screens
    {
        class Display { public int X; public int Y; public int W; public int H; public bool Primary; public string Name; }

        static List<Display> Monitors()
        {
            List<Display> list = new List<Display>();
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr monitor, IntPtr hdc, ref Native.RECT rect, IntPtr data)
            {
                Native.MONITORINFOEX info = new Native.MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
                if (Native.GetMonitorInfo(monitor, ref info))
                {
                    Display m = new Display();
                    m.X = info.rcMonitor.Left;
                    m.Y = info.rcMonitor.Top;
                    m.W = info.rcMonitor.Right - info.rcMonitor.Left;
                    m.H = info.rcMonitor.Bottom - info.rcMonitor.Top;
                    m.Primary = (info.dwFlags & 1) != 0;
                    m.Name = info.szDevice ?? "";
                    list.Add(m);
                }
                return true;
            }, IntPtr.Zero);
            // Stable order: primary first, then left-to-right, top-to-bottom.
            list.Sort(delegate (Display a, Display b)
            {
                if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
                if (a.X != b.X) return a.X.CompareTo(b.X);
                return a.Y.CompareTo(b.Y);
            });
            return list;
        }

        public static List<object> List()
        {
            List<object> result = new List<object>();
            List<Display> monitors = Monitors();
            for (int i = 0; i < monitors.Count; i++)
            {
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["index"] = i;
                d["x"] = monitors[i].X;
                d["y"] = monitors[i].Y;
                d["width"] = monitors[i].W;
                d["height"] = monitors[i].H;
                d["primary"] = monitors[i].Primary;
                d["name"] = monitors[i].Name;
                result.Add(d);
            }
            return result;
        }

        public static SD.Rectangle WindowRect(IntPtr hwnd)
        {
            Native.RECT r;
            if (Native.DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(Native.RECT))) != 0) Native.GetWindowRect(hwnd, out r);
            return new SD.Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
        }

        /// The window a capture draws (a window id without a region), or Zero.
        static IntPtr ShotWindow(Dictionary<string, object> a)
        {
            return Args.Obj(a, "region") == null && Args.Has(a, "hwnd") ? Uia.Hwnd(a, false) : IntPtr.Zero;
        }

        /// The physical rectangle to capture: region, window, screen index ("all" = every screen).
        /// B-080: a window keeps its whole rectangle, also off the screen - it draws itself (Grab).
        public static SD.Rectangle Bounds(Dictionary<string, object> a)
        {
            SD.Rectangle vs = Native.VirtualScreen();
            SD.Rectangle rect;
            Dictionary<string, object> region = Args.Obj(a, "region");
            IntPtr window = ShotWindow(a);
            if (region != null)
            {
                rect = new SD.Rectangle(Args.ReqInt(region, "x"), Args.ReqInt(region, "y"), Args.ReqInt(region, "width"), Args.ReqInt(region, "height"));
            }
            else if (window != IntPtr.Zero)
            {
                if (Native.IsIconic(window)) throw new HelperException("conflict", "The window is minimised; restore it (focus_window) before capturing it.");
                rect = WindowRect(window);
                if (rect.Width <= 0 || rect.Height <= 0) throw new HelperException("conflict", "The window has no area to capture.");
                return rect;
            }
            else if (Args.Get(a, "screen") is string && (string)Args.Get(a, "screen") == "all")
            {
                rect = vs;
            }
            else
            {
                List<Display> monitors = Monitors();
                int index = Args.Int(a, "screen", 0);
                if (monitors.Count == 0) return vs;
                if (index < 0 || index >= monitors.Count) throw new HelperException("not_found", "There is no screen " + index + " (this PC has " + monitors.Count + ").");
                Display m = monitors[index];
                rect = new SD.Rectangle(m.X, m.Y, m.W, m.H);
            }
            rect.Intersect(vs);
            if (rect.Width <= 0 || rect.Height <= 0) throw new HelperException("bad_request", "The area to capture is outside the screen.");
            return rect;
        }

        public static SD.Bitmap Capture(SD.Rectangle rect)
        {
            SD.Bitmap bmp = new SD.Bitmap(rect.Width, rect.Height, SDI.PixelFormat.Format24bppRgb);
            try
            {
                using (SD.Graphics g = SD.Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(rect.X, rect.Y, 0, 0, rect.Size, SD.CopyPixelOperation.SourceCopy);
                }
            }
            catch (System.ComponentModel.Win32Exception)
            {
                bmp.Dispose();
                throw new HelperException("unavailable", "The screen cannot be captured right now (locked, or a secure prompt is shown).");
            }
            return bmp;
        }

        public static byte[] Encode(SD.Bitmap bmp, string format, long quality)
        {
            using (MemoryStream ms = new MemoryStream())
            {
                if (format == "png")
                {
                    bmp.Save(ms, SDI.ImageFormat.Png);
                }
                else
                {
                    SDI.ImageCodecInfo codec = null;
                    foreach (SDI.ImageCodecInfo candidate in SDI.ImageCodecInfo.GetImageEncoders())
                        if (candidate.MimeType == "image/jpeg") codec = candidate;
                    SDI.EncoderParameters parameters = new SDI.EncoderParameters(1);
                    parameters.Param[0] = new SDI.EncoderParameter(SDI.Encoder.Quality, quality);
                    bmp.Save(ms, codec, parameters);
                }
                return ms.ToArray();
            }
        }

        /// B-080: a window draws itself (PrintWindow with PW_RENDERFULLCONTENT) into a bitmap of its rectangle - its own
        /// content also behind another window or off the screen. Where it cannot, the screen copy of its rectangle.
        static SD.Bitmap CaptureWindow(IntPtr hwnd, SD.Rectangle rect)
        {
            Native.RECT outer;
            if (Native.GetWindowRect(hwnd, out outer) && outer.Right > outer.Left && outer.Bottom > outer.Top)
            {
                int w = outer.Right - outer.Left, h = outer.Bottom - outer.Top;
                // PrintWindow draws the whole window rectangle; the capture is its visible frame inside it.
                SD.Rectangle inner = new SD.Rectangle(rect.X - outer.Left, rect.Y - outer.Top, rect.Width, rect.Height);
                inner.Intersect(new SD.Rectangle(0, 0, w, h));
                using (SD.Bitmap whole = new SD.Bitmap(w, h, SDI.PixelFormat.Format24bppRgb))
                {
                    bool drawn;
                    using (SD.Graphics g = SD.Graphics.FromImage(whole))
                    {
                        IntPtr hdc = g.GetHdc();
                        try { drawn = Native.PrintWindow(hwnd, hdc, 2); } finally { g.ReleaseHdc(hdc); }
                    }
                    if (drawn && inner.Size == rect.Size)
                    {
                        SD.Bitmap bmp = new SD.Bitmap(rect.Width, rect.Height, SDI.PixelFormat.Format24bppRgb);
                        using (SD.Graphics g = SD.Graphics.FromImage(bmp))
                            g.DrawImage(whole, new SD.Rectangle(0, 0, rect.Width, rect.Height), inner, SD.GraphicsUnit.Pixel);
                        return bmp;
                    }
                }
            }
            SD.Rectangle visible = rect;
            visible.Intersect(Native.VirtualScreen());
            if (visible.Width <= 0 || visible.Height <= 0)
                throw new HelperException("unavailable", "The window does not draw itself and lies outside the screen; focus_window brings it onto the screen.");
            return Capture(rect);
        }

        /// The picture of Bounds(a): a window drawn by itself, else the screen.
        public static SD.Bitmap Grab(Dictionary<string, object> a, SD.Rectangle rect)
        {
            IntPtr window = ShotWindow(a);
            return window != IntPtr.Zero ? CaptureWindow(window, rect) : Capture(rect);
        }

        public static byte[] GrabPng(Dictionary<string, object> a, SD.Rectangle rect)
        {
            using (SD.Bitmap bmp = Grab(a, rect)) { return Encode(bmp, "png", 0); }
        }

        /// B-080: a window that is not the one in front at its centre - behind another one, or off the screen. Its picture
        /// shows the window itself (CaptureWindow), while a click by coordinates hits what is in front at that point.
        static bool Covered(IntPtr window, SD.Rectangle rect)
        {
            Native.POINT p = new Native.POINT();
            p.X = rect.X + rect.Width / 2;
            p.Y = rect.Y + rect.Height / 2;
            if (!Native.VirtualScreen().Contains(p.X, p.Y)) return true;
            return Native.GetAncestor(Native.WindowFromPoint(p), 2) != Native.GetAncestor(window, 2); // GA_ROOT
        }

        /// 22.11.2026 (live 21.11.: a card number typed into a billing form in the person's Chrome was readable in the
        /// agent's screenshots): text fields of the captured window and the window in front whose name or id matches
        /// `secretLabel` (card number, CVC, expiry, PIN, password, codes - the runtime's SECRET_LABEL), and every password
        /// field, are painted black before the picture leaves the helper. Bounded to 2.5 s; what was found by then is painted.
        static readonly HashSet<IntPtr> Asked = new HashSet<IntPtr>();
        static int MaskSecrets(SD.Bitmap bmp, SD.Rectangle rect, Dictionary<string, object> a)
        {
            string label = Args.Str(a, "secretLabel", null);
            if (string.IsNullOrEmpty(label)) return 0;
            System.Text.RegularExpressions.Regex rx;
            try { rx = new System.Text.RegularExpressions.Regex(label, System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant); }
            catch (ArgumentException) { return 0; }
            List<IntPtr> roots = new List<IntPtr>();
            IntPtr window = ShotWindow(a);
            if (window != IntPtr.Zero) roots.Add(window);
            IntPtr front = Native.GetForegroundWindow();
            if (front != IntPtr.Zero && front != window) roots.Add(front);
            List<SD.Rectangle> boxes = new List<SD.Rectangle>();
            Thread finder = new Thread(delegate ()
            {
                foreach (IntPtr root in roots)
                {
                    try
                    {
                        CacheRequest request = new CacheRequest();
                        request.TreeScope = TreeScope.Element;
                        request.Add(AutomationElement.NameProperty);
                        request.Add(AutomationElement.AutomationIdProperty);
                        request.Add(AutomationElement.IsPasswordProperty);
                        request.Add(AutomationElement.BoundingRectangleProperty);
                        Condition fields = new AndCondition(
                            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
                            new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
                        // Chrome and Edge build a page's tree only once a client asks (measured 22.11.: the first look at
                        // a fresh window found only the address bar, a look 1 s later the page's fields): a window seen
                        // for the first time is asked again until its page shows a field, within the time bound.
                        bool first;
                        lock (Asked) first = Asked.Add(root);
                        for (int look = 0; look < (first ? 4 : 1); look++)
                        {
                            if (look > 0) Thread.Sleep(400);
                            AutomationElementCollection edits;
                            using (request.Activate()) edits = AutomationElement.FromHandle(root).FindAll(TreeScope.Descendants, fields);
                            bool hit = false;
                            foreach (AutomationElement edit in edits)
                            {
                                string name = edit.Cached.Name ?? "";
                                string id = edit.Cached.AutomationId ?? "";
                                if (!edit.Cached.IsPassword && !rx.IsMatch(name) && !rx.IsMatch(id)) continue;
                                System.Windows.Rect r = edit.Cached.BoundingRectangle;
                                if (r.IsEmpty || double.IsInfinity(r.Width) || r.Width <= 0 || r.Height <= 0) continue;
                                SD.Rectangle box = new SD.Rectangle((int)r.X - 2, (int)r.Y - 2, (int)Math.Ceiling(r.Width) + 4, (int)Math.Ceiling(r.Height) + 4);
                                lock (boxes) boxes.Add(box);
                                hit = true;
                            }
                            if (hit || edits.Count > 1) break; // more than the address bar: the page is there
                        }
                    }
                    catch (Exception) { /* a window that closed or does not answer: the others still count */ }
                }
            });
            finder.IsBackground = true;
            finder.Start();
            finder.Join(2500);
            List<SD.Rectangle> found;
            lock (boxes) found = new List<SD.Rectangle>(boxes);
            if (found.Count == 0) return 0;
            using (SD.Graphics g = SD.Graphics.FromImage(bmp))
            {
                foreach (SD.Rectangle box in found)
                {
                    SD.Rectangle part = SD.Rectangle.Intersect(box, rect);
                    if (part.Width <= 0 || part.Height <= 0) continue;
                    part.Offset(-rect.X, -rect.Y);
                    g.FillRectangle(SD.Brushes.Black, part);
                }
            }
            return found.Count;
        }

        public static Dictionary<string, object> Shot(Dictionary<string, object> a)
        {
            SD.Rectangle rect = Bounds(a);
            int maxEdge = Args.Clamp(Args.Int(a, "maxEdge", 1600), 64, 4096);
            long quality = Args.Clamp(Args.Int(a, "quality", 70), 30, 95);
            string format = Args.Str(a, "format", "jpeg") == "png" ? "png" : "jpeg";
            byte[] bytes;
            int width;
            int height;
            int masked;
            using (SD.Bitmap full = Grab(a, rect))
            {
                masked = MaskSecrets(full, rect, a);
                double scale = Math.Min(1.0, (double)maxEdge / Math.Max(rect.Width, rect.Height));
                width = Math.Max(1, (int)Math.Round(rect.Width * scale));
                height = Math.Max(1, (int)Math.Round(rect.Height * scale));
                if (width == rect.Width && height == rect.Height)
                {
                    bytes = Encode(full, format, quality);
                }
                else
                {
                    using (SD.Bitmap small = new SD.Bitmap(width, height, SDI.PixelFormat.Format24bppRgb))
                    {
                        using (SD.Graphics g = SD.Graphics.FromImage(small))
                        {
                            g.InterpolationMode = SD.Drawing2D.InterpolationMode.HighQualityBilinear;
                            g.PixelOffsetMode = SD.Drawing2D.PixelOffsetMode.HighQuality;
                            g.DrawImage(full, 0, 0, width, height);
                        }
                        bytes = Encode(small, format, quality);
                    }
                }
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["data"] = Convert.ToBase64String(bytes);
            d["mime"] = format == "png" ? "image/png" : "image/jpeg";
            d["width"] = width;
            d["height"] = height;
            d["x"] = rect.X;
            d["y"] = rect.Y;
            d["srcWidth"] = rect.Width;
            d["srcHeight"] = rect.Height;
            IntPtr window = ShotWindow(a);
            if (window != IntPtr.Zero && Covered(window, rect)) d["covered"] = true;
            if (masked > 0) d["masked"] = masked;
            return d;
        }
    }

    // ------------------------------------------------------------------ top-level windows
    public static class Windows
    {
        public static Dictionary<string, object> Describe(IntPtr hwnd, IntPtr foreground, Dictionary<uint, string> names)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["hwnd"] = hwnd.ToInt64();
            int length = Native.GetWindowTextLength(hwnd);
            StringBuilder title = new StringBuilder(Math.Max(1, length + 1));
            Native.GetWindowText(hwnd, title, title.Capacity);
            d["title"] = Args.Clip(title.ToString(), 300);
            StringBuilder cls = new StringBuilder(256);
            Native.GetClassName(hwnd, cls, cls.Capacity);
            d["cls"] = cls.ToString();
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            d["pid"] = pid;
            string name;
            if (names == null || !names.TryGetValue(pid, out name))
            {
                try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { name = ""; }
                if (names != null) names[pid] = name;
            }
            d["process"] = name;
            SD.Rectangle r = Screens.WindowRect(hwnd);
            d["rect"] = new List<object> { r.X, r.Y, r.Width, r.Height };
            d["minimized"] = Native.IsIconic(hwnd);
            d["foreground"] = hwnd == foreground;
            d["app"] = Guard.AppRoot(hwnd) != IntPtr.Zero;
            return d;
        }

        public static List<object> List()
        {
            List<object> result = new List<object>();
            IntPtr foreground = Native.GetForegroundWindow();
            Dictionary<uint, string> names = new Dictionary<uint, string>();
            Native.EnumWindows(delegate (IntPtr hwnd, IntPtr lParam)
            {
                if (!Native.IsWindowVisible(hwnd)) return true;
                if (Native.GetWindowTextLength(hwnd) == 0) return true;
                int cloaked;
                if (Native.DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                result.Add(Describe(hwnd, foreground, names));
                return result.Count < 200;
            }, IntPtr.Zero);
            return result;
        }

        public static Dictionary<string, object> Focus(IntPtr hwnd)
        {
            if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, 9); // SW_RESTORE
            // B-080: a window off every screen (an off-screen browser at -32000,-32000) comes onto the primary work
            // area (left+40, top+40, its size kept), so pointer steps reach it.
            if (!Screens.WindowRect(hwnd).IntersectsWith(Native.VirtualScreen()))
            {
                Native.RECT work = new Native.RECT();
                if (!Native.SystemParametersInfo(0x0030, 0, ref work, 0)) { work.Left = 0; work.Top = 0; } // SPI_GETWORKAREA
                Native.SetWindowPos(hwnd, IntPtr.Zero, work.Left + 40, work.Top + 40, 0, 0, 0x0001 | 0x0004 | 0x0010); // NOSIZE | NOZORDER | NOACTIVATE
            }
            Native.SetForegroundWindow(hwnd);
            Thread.Sleep(100);
            // B-080 (live: focus_window answered focused:false 5 of 8 times): Windows' foreground lock keeps a window behind
            // the one in front when a background process asks. Attached to the input thread of the window in front, this
            // thread brings the window up (no key presses), then it lets go.
            IntPtr front = Native.GetForegroundWindow();
            if (front != hwnd)
            {
                uint frontPid;
                uint frontThread = Native.GetWindowThreadProcessId(front, out frontPid);
                uint ownThread = Native.GetCurrentThreadId();
                bool attached = frontThread != 0 && frontThread != ownThread && Native.AttachThreadInput(ownThread, frontThread, true);
                try
                {
                    Native.BringWindowToTop(hwnd);
                    Native.SetForegroundWindow(hwnd);
                }
                finally
                {
                    if (attached) Native.AttachThreadInput(ownThread, frontThread, false);
                }
            }
            if (Native.GetForegroundWindow() != hwnd)
            {
                try { AutomationElement.FromHandle(hwnd).SetFocus(); } catch (Exception) { }
                Thread.Sleep(100);
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["focused"] = Native.GetForegroundWindow() == hwnd;
            return d;
        }
    }

    // ------------------------------------------------------------------ UI Automation
    public static class Uia
    {
        static readonly AutomationProperty[] Props = new AutomationProperty[]
        {
            AutomationElement.RuntimeIdProperty, AutomationElement.NameProperty, AutomationElement.ControlTypeProperty,
            AutomationElement.AutomationIdProperty, AutomationElement.ClassNameProperty, AutomationElement.BoundingRectangleProperty,
            AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty, AutomationElement.HasKeyboardFocusProperty,
            AutomationElement.IsPasswordProperty, AutomationElement.IsInvokePatternAvailableProperty,
            AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
            AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty,
            AutomationElement.IsScrollPatternAvailableProperty, AutomationElement.IsScrollItemPatternAvailableProperty,
            AutomationElement.IsRangeValuePatternAvailableProperty, AutomationElement.IsWindowPatternAvailableProperty,
            ValuePattern.ValueProperty, TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
            SelectionItemPattern.IsSelectedProperty, RangeValuePattern.ValueProperty
        };

        static CacheRequest Request()
        {
            CacheRequest request = new CacheRequest();
            request.TreeScope = TreeScope.Element;
            request.TreeFilter = Automation.ControlViewCondition;
            foreach (AutomationProperty property in Props) request.Add(property);
            return request;
        }

        public static IntPtr Hwnd(Dictionary<string, object> a, bool foregroundDefault)
        {
            IntPtr hwnd;
            if (Args.Has(a, "hwnd")) hwnd = new IntPtr((long)Args.Num(a, "hwnd", 0));
            else if (foregroundDefault) hwnd = Native.GetForegroundWindow();
            else throw new HelperException("bad_request", "hwnd is required.");
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) throw new HelperException("not_found", "The window is gone. List windows again.");
            return hwnd;
        }

        static object Cached(AutomationElement el, AutomationProperty property)
        {
            try { return el.GetCachedPropertyValue(property, true); } catch (Exception) { return null; }
        }

        static string CachedString(AutomationElement el, AutomationProperty property)
        {
            string s = Cached(el, property) as string;
            return s ?? "";
        }

        static bool CachedBool(AutomationElement el, AutomationProperty property, bool fallback)
        {
            object v = Cached(el, property);
            return v is bool ? (bool)v : fallback;
        }

        public static string RoleName(ControlType type)
        {
            if (type == null) return "unknown";
            string name = type.ProgrammaticName ?? "";
            if (name.StartsWith("ControlType.")) name = name.Substring(12);
            return name.ToLowerInvariant();
        }

        static string RuntimeId(int[] id)
        {
            if (id == null) return "";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < id.Length; i++)
            {
                if (i > 0) sb.Append('.');
                sb.Append(id[i].ToString(CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }

        static int[] ParseRid(string rid)
        {
            string[] parts = rid.Split('.');
            int[] id = new int[parts.Length];
            for (int i = 0; i < parts.Length; i++)
            {
                if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out id[i]))
                    throw new HelperException("bad_request", "Invalid element ref.");
            }
            return id;
        }

        static Dictionary<string, object> Node(AutomationElement el, int depth, int parent)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["d"] = depth;
            d["p"] = parent;
            d["rid"] = RuntimeId(Cached(el, AutomationElement.RuntimeIdProperty) as int[]);
            d["role"] = RoleName(Cached(el, AutomationElement.ControlTypeProperty) as ControlType);
            string name = CachedString(el, AutomationElement.NameProperty);
            if (name.Length > 0) d["name"] = Args.Clip(name, 200);
            string aid = CachedString(el, AutomationElement.AutomationIdProperty);
            if (aid.Length > 0) d["aid"] = Args.Clip(aid, 120);
            string cls = CachedString(el, AutomationElement.ClassNameProperty);
            if (cls.Length > 0) d["cls"] = Args.Clip(cls, 120);
            object rect = Cached(el, AutomationElement.BoundingRectangleProperty);
            if (rect is System.Windows.Rect)
            {
                System.Windows.Rect r = (System.Windows.Rect)rect;
                if (!r.IsEmpty && !double.IsInfinity(r.Width) && !double.IsInfinity(r.Height))
                    d["rect"] = new List<object> { (int)Math.Round(r.X), (int)Math.Round(r.Y), (int)Math.Round(r.Width), (int)Math.Round(r.Height) };
            }
            if (!CachedBool(el, AutomationElement.IsEnabledProperty, true)) d["disabled"] = true;
            if (CachedBool(el, AutomationElement.IsOffscreenProperty, false)) d["offscreen"] = true;
            if (CachedBool(el, AutomationElement.HasKeyboardFocusProperty, false)) d["focused"] = true;
            bool password = CachedBool(el, AutomationElement.IsPasswordProperty, false);
            List<object> patterns = new List<object>();
            if (CachedBool(el, AutomationElement.IsInvokePatternAvailableProperty, false)) patterns.Add("invoke");
            if (CachedBool(el, AutomationElement.IsValuePatternAvailableProperty, false))
            {
                patterns.Add("value");
                string value = Cached(el, ValuePattern.ValueProperty) as string;
                if (!string.IsNullOrEmpty(value)) d["value"] = password ? "********" : Args.Clip(value, 300);
            }
            if (CachedBool(el, AutomationElement.IsRangeValuePatternAvailableProperty, false))
            {
                patterns.Add("range");
                object range = Cached(el, RangeValuePattern.ValueProperty);
                if (range is double && !d.ContainsKey("value")) d["value"] = (double)range;
            }
            if (CachedBool(el, AutomationElement.IsTogglePatternAvailableProperty, false))
            {
                patterns.Add("toggle");
                object toggle = Cached(el, TogglePattern.ToggleStateProperty);
                if (toggle is ToggleState) d["toggle"] = ((ToggleState)toggle).ToString().ToLowerInvariant();
            }
            if (CachedBool(el, AutomationElement.IsExpandCollapsePatternAvailableProperty, false))
            {
                patterns.Add("expand");
                object expand = Cached(el, ExpandCollapsePattern.ExpandCollapseStateProperty);
                if (expand is ExpandCollapseState) d["expand"] = ((ExpandCollapseState)expand).ToString().ToLowerInvariant();
            }
            if (CachedBool(el, AutomationElement.IsSelectionItemPatternAvailableProperty, false))
            {
                patterns.Add("select");
                if (CachedBool(el, SelectionItemPattern.IsSelectedProperty, false)) d["selected"] = true;
            }
            if (CachedBool(el, AutomationElement.IsScrollPatternAvailableProperty, false)) patterns.Add("scroll");
            if (CachedBool(el, AutomationElement.IsScrollItemPatternAvailableProperty, false)) patterns.Add("scroll_into_view");
            if (CachedBool(el, AutomationElement.IsWindowPatternAvailableProperty, false)) patterns.Add("window");
            if (patterns.Count > 0) d["patterns"] = patterns;
            return d;
        }

        /// Depth-first walk of the control view with per-element cached properties.
        /// visit(element, depth, parentIndex) returns the new node index or -1 to skip children.
        static void Walk(TreeWalker walker, CacheRequest request, AutomationElement el, int depth, int maxDepth, int parent,
            Func<AutomationElement, int, int, int> visit, Func<bool> full, ref bool truncated)
        {
            if (full()) { truncated = true; return; }
            int index = visit(el, depth, parent);
            if (index < 0 || depth >= maxDepth) return;
            AutomationElement child = null;
            try { child = walker.GetFirstChild(el, request); } catch (ElementNotAvailableException) { return; }
            while (child != null)
            {
                if (full()) { truncated = true; return; }
                Walk(walker, request, child, depth + 1, maxDepth, index, visit, full, ref truncated);
                try { child = walker.GetNextSibling(child, request); } catch (ElementNotAvailableException) { child = null; }
            }
        }

        static AutomationElement Root(IntPtr hwnd, CacheRequest request)
        {
            using (request.Activate()) { return AutomationElement.FromHandle(hwnd); }
        }

        public static Dictionary<string, object> Tree(Dictionary<string, object> a)
        {
            IntPtr hwnd = Hwnd(a, true);
            int maxDepth = Args.Clamp(Args.Int(a, "depth", 12), 1, 40);
            int maxNodes = Args.Clamp(Args.Int(a, "maxNodes", 400), 10, 3000);
            CacheRequest request = Request();
            AutomationElement root = Root(hwnd, request);
            List<object> nodes = new List<object>();
            TreeWalker walker = new TreeWalker(Automation.ControlViewCondition);
            bool truncated = false;
            Walk(walker, request, root, 0, maxDepth, -1,
                delegate (AutomationElement el, int depth, int parent) { nodes.Add(Node(el, depth, parent)); return nodes.Count - 1; },
                delegate () { return nodes.Count >= maxNodes; }, ref truncated);
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["hwnd"] = hwnd.ToInt64();
            d["title"] = CachedString(root, AutomationElement.NameProperty);
            d["nodes"] = nodes;
            d["truncated"] = truncated;
            return d;
        }

        static bool Matches(AutomationElement el, string name, string aid, string role, bool exact)
        {
            if (name != null)
            {
                string actual = CachedString(el, AutomationElement.NameProperty);
                if (exact ? !string.Equals(actual, name, StringComparison.OrdinalIgnoreCase) : actual.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) return false;
            }
            if (aid != null && !string.Equals(CachedString(el, AutomationElement.AutomationIdProperty), aid, StringComparison.Ordinal)) return false;
            if (role != null && RoleName(Cached(el, AutomationElement.ControlTypeProperty) as ControlType) != role) return false;
            return true;
        }

        static List<AutomationElement> Search(IntPtr hwnd, string name, string aid, string role, bool exact, int max, ref bool truncated)
        {
            CacheRequest request = Request();
            AutomationElement root = Root(hwnd, request);
            TreeWalker walker = new TreeWalker(Automation.ControlViewCondition);
            List<AutomationElement> found = new List<AutomationElement>();
            int visited = 0;
            Walk(walker, request, root, 0, 60, -1,
                delegate (AutomationElement el, int depth, int parent)
                {
                    visited++;
                    if (Matches(el, name, aid, role, exact)) found.Add(el);
                    return 0;
                },
                delegate () { return found.Count >= max || visited >= 6000; }, ref truncated);
            return found;
        }

        public static Dictionary<string, object> Find(Dictionary<string, object> a)
        {
            IntPtr hwnd = Hwnd(a, true);
            string name = Args.Str(a, "name", null);
            string aid = Args.Str(a, "aid", null);
            string role = Args.Str(a, "role", null);
            int max = Args.Clamp(Args.Int(a, "max", 20), 1, 100);
            bool truncated = false;
            List<AutomationElement> found = Search(hwnd, name, aid, role, false, max, ref truncated);
            List<object> nodes = new List<object>();
            foreach (AutomationElement el in found) nodes.Add(Node(el, 0, -1));
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["hwnd"] = hwnd.ToInt64();
            d["nodes"] = nodes;
            d["truncated"] = truncated;
            return d;
        }

        /// B-080: the element that holds the keyboard focus now (one node, the same cached properties as a tree; a
        /// password value stays "********") and the top-level window it is in - computer.type reads where its text landed.
        public static Dictionary<string, object> Focused()
        {
            CacheRequest request = Request();
            AutomationElement focused;
            using (request.Activate()) { focused = AutomationElement.FocusedElement; }
            Dictionary<string, object> d = new Dictionary<string, object>();
            List<object> nodes = new List<object>();
            IntPtr own = IntPtr.Zero;
            if (focused != null)
            {
                nodes.Add(Node(focused, 0, -1));
                try { own = new IntPtr(focused.Current.NativeWindowHandle); } catch (Exception) { own = IntPtr.Zero; }
            }
            if (own == IntPtr.Zero) own = Native.GetForegroundWindow();
            IntPtr top = own == IntPtr.Zero ? IntPtr.Zero : Native.GetAncestor(own, 2); // GA_ROOT
            if (top == IntPtr.Zero) top = own;
            d["hwnd"] = top.ToInt64();
            d["nodes"] = nodes;
            return d;
        }

        static AutomationElement ByRid(IntPtr hwnd, string rid)
        {
            int[] wanted = ParseRid(rid);
            CacheRequest request = Request();
            AutomationElement root = Root(hwnd, request);
            AutomationElement match = null;
            bool truncated = false;
            Walk(new TreeWalker(Automation.ControlViewCondition), request, root, 0, 60, -1,
                delegate (AutomationElement el, int depth, int parent)
                {
                    int[] id = Cached(el, AutomationElement.RuntimeIdProperty) as int[];
                    if (id != null && id.Length == wanted.Length)
                    {
                        bool same = true;
                        for (int i = 0; i < id.Length && same; i++) same = id[i] == wanted[i];
                        if (same) match = el;
                    }
                    return 0;
                },
                delegate () { return match != null; }, ref truncated);
            return match;
        }

        static AutomationElement Target(IntPtr hwnd, Dictionary<string, object> a)
        {
            string rid = Args.Str(a, "rid", null);
            if (rid != null) return ByRid(hwnd, rid);
            string name = Args.Str(a, "name", null);
            string aid = Args.Str(a, "aid", null);
            string role = Args.Str(a, "role", null);
            // B-080: a window step with only the window id acts on the window itself.
            if (name == null && aid == null && Args.Str(a, "action", "").StartsWith("window_")) return AutomationElement.FromHandle(hwnd);
            if (name == null && aid == null) throw new HelperException("bad_request", "This step needs a ref, a name or an automation id.");
            bool truncated = false;
            List<AutomationElement> found = Search(hwnd, name, aid, role, true, 3, ref truncated);
            if (found.Count == 0) found = Search(hwnd, name, aid, role, false, 3, ref truncated);
            if (found.Count > 1) throw new HelperException("conflict", found.Count + " elements match. Use a ref from computer.ui_tree to pick one.");
            return found.Count == 1 ? found[0] : null;
        }

        // B-080 (live: "Try action 'click'" for scroll on a ScrollItem element): an unsupported pattern answers with
        // the computer.act actions the element takes - one per pattern it supports, and click where it has a point to click.
        static readonly Dictionary<string, string> PatternActions = new Dictionary<string, string>
        {
            { "Invoke", "invoke" }, { "Toggle", "toggle" }, { "SelectionItem", "select" }, { "ExpandCollapse", "expand, collapse" },
            { "Value", "set_value" }, { "RangeValue", "set_value" }, { "ScrollItem", "scroll_into_view" }, { "Scroll", "scroll" },
        };

        static object Pattern(AutomationElement el, AutomationPattern pattern, string label)
        {
            object p;
            if (el.TryGetCurrentPattern(pattern, out p)) return p;
            List<string> names = new List<string>();
            List<string> actions = new List<string>();
            foreach (AutomationPattern supported in el.GetSupportedPatterns())
            {
                string name = supported.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "");
                names.Add(name);
                string action;
                if (PatternActions.TryGetValue(name, out action) && !actions.Contains(action)) actions.Add(action);
            }
            if (Clickable(el)) actions.Add("click");
            throw new HelperException("bad_request", "The element does not support " + label + " (supports: " + (names.Count > 0 ? string.Join(", ", names.ToArray()) : "nothing") + ")."
                + (actions.Count > 0 ? " I reach it with computer.act " + string.Join(", ", actions.ToArray()) + "." : ""));
        }

        /// <summary>A point a click step reaches (its clickable point, else the centre of its rectangle) on the screen.</summary>
        static bool Clickable(AutomationElement el)
        {
            try
            {
                if (el.Current.IsOffscreen) return false;
                System.Windows.Point point;
                return el.TryGetClickablePoint(out point) || !el.Current.BoundingRectangle.IsEmpty;
            }
            catch (Exception) { return false; }
        }

        public static Dictionary<string, object> Act(Dictionary<string, object> a)
        {
            IntPtr hwnd = Hwnd(a, true);
            string action = Args.Str(a, "action", "");
            AutomationElement el = Target(hwnd, a);
            if (el == null) throw new HelperException("not_found", "The element is gone (the UI changed). Observe again with computer.ui_tree.");
            AutomationElement.AutomationElementInformation current = el.Current;
            string expectName = Args.Str(a, "expectName", null);
            string expectRole = Args.Str(a, "expectRole", null);
            // Hard preconditions BEFORE acting: identity, enabled state, a Workforce window's clearance.
            // Observed names are clipped to 200 characters (Node), so compare the same prefix.
            if (expectName != null && Args.Clip(current.Name ?? "", 200) != expectName)
                throw new HelperException("conflict", "The element changed: expected \"" + Args.Clip(expectName, 80) + "\" but found \"" + Args.Clip(current.Name, 80) + "\". Observe again before acting.");
            if (expectRole != null && RoleName(current.ControlType) != expectRole)
                throw new HelperException("conflict", "The element changed: expected a " + expectRole + " but found a " + RoleName(current.ControlType) + ". Observe again before acting.");
            long cleared = Guard.Cleared(a);
            if (action != "scroll" && action != "scroll_into_view" && !action.StartsWith("window_")) Guard.Element(hwnd, current, cleared);
            if (action != "focus" && action != "scroll_into_view" && !current.IsEnabled)
                throw new HelperException("conflict", "The element is disabled.");
            string value = Args.Str(a, "value", null);
            List<object> clickedAt = null;
            switch (action)
            {
                case "invoke":
                    ((InvokePattern)Pattern(el, InvokePattern.Pattern, "invoke")).Invoke();
                    break;
                case "set_value":
                    if (value == null) throw new HelperException("bad_request", "set_value needs a value.");
                    object vp;
                    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp))
                    {
                        if (((ValuePattern)vp).Current.IsReadOnly) throw new HelperException("conflict", "The field is read-only.");
                        ((ValuePattern)vp).SetValue(value);
                    }
                    else
                    {
                        double number;
                        if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number))
                            throw new HelperException("bad_request", "The element has no text value; for sliders give a number.");
                        ((RangeValuePattern)Pattern(el, RangeValuePattern.Pattern, "set_value")).SetValue(number);
                    }
                    break;
                case "toggle":
                    TogglePattern toggle = (TogglePattern)Pattern(el, TogglePattern.Pattern, "toggle");
                    if (value == "on" || value == "off")
                    {
                        // B-080: one toggle at a time - an async app (Chromium, WebView2) shows the new state later, so the
                        // next one (at most 3, for tri-state) waits until the state changed, at most 1 s.
                        for (int i = 0; i < 3 && ToggleOf(toggle) != value; i++)
                        {
                            string was = ToggleOf(toggle);
                            toggle.Toggle();
                            Until(1000, delegate () { return ToggleOf(toggle) != was; });
                        }
                    }
                    else toggle.Toggle();
                    break;
                case "expand":
                    ((ExpandCollapsePattern)Pattern(el, ExpandCollapsePattern.Pattern, "expand")).Expand();
                    break;
                case "collapse":
                    ((ExpandCollapsePattern)Pattern(el, ExpandCollapsePattern.Pattern, "collapse")).Collapse();
                    break;
                case "select":
                    ((SelectionItemPattern)Pattern(el, SelectionItemPattern.Pattern, "select")).Select();
                    break;
                case "scroll_into_view":
                    ((ScrollItemPattern)Pattern(el, ScrollItemPattern.Pattern, "scroll_into_view")).ScrollIntoView();
                    break;
                case "scroll":
                    ScrollPattern scroll = (ScrollPattern)Pattern(el, ScrollPattern.Pattern, "scroll");
                    if (value == "up") scroll.ScrollVertical(ScrollAmount.SmallDecrement);
                    else if (value == "page_up") scroll.ScrollVertical(ScrollAmount.LargeDecrement);
                    else if (value == "page_down") scroll.ScrollVertical(ScrollAmount.LargeIncrement);
                    else if (value == "left") scroll.ScrollHorizontal(ScrollAmount.SmallDecrement);
                    else if (value == "right") scroll.ScrollHorizontal(ScrollAmount.SmallIncrement);
                    else scroll.ScrollVertical(ScrollAmount.SmallIncrement);
                    break;
                case "focus":
                    el.SetFocus();
                    break;
                case "click":
                case "double_click":
                case "right_click":
                    if (current.IsOffscreen) throw new HelperException("conflict", "The element is off screen; use scroll_into_view first.");
                    System.Windows.Point point;
                    if (!el.TryGetClickablePoint(out point))
                    {
                        System.Windows.Rect r = current.BoundingRectangle;
                        if (r.IsEmpty) throw new HelperException("conflict", "The element has no clickable point.");
                        point = new System.Windows.Point(r.X + r.Width / 2, r.Y + r.Height / 2);
                    }
                    int px = (int)Math.Round(point.X), py = (int)Math.Round(point.Y);
                    Dictionary<string, object> path = Args.Obj(a, "path");
                    if (path != null) PathMotion.ElementClick(path, px, py, action == "right_click" ? "right" : "left", action == "double_click" ? 2 : 1, cleared);
                    else Input.Click(px, py, action == "right_click" ? "right" : "left", action == "double_click" ? 2 : 1, cleared);
                    clickedAt = new List<object> { px, py };
                    break;
                case "window_close":
                case "window_minimize":
                case "window_maximize":
                case "window_restore":
                    object wp;
                    AutomationElement windowElement = el;
                    if (!el.TryGetCurrentPattern(WindowPattern.Pattern, out wp))
                    {
                        windowElement = AutomationElement.FromHandle(hwnd);
                        wp = Pattern(windowElement, WindowPattern.Pattern, action);
                    }
                    WindowPattern window = (WindowPattern)wp;
                    if (action == "window_close") window.Close();
                    else if (action == "window_minimize") window.SetWindowVisualState(WindowVisualState.Minimized);
                    else if (action == "window_maximize") window.SetWindowVisualState(WindowVisualState.Maximized);
                    else window.SetWindowVisualState(WindowVisualState.Normal);
                    break;
                default:
                    throw new HelperException("bad_request", "Unknown action " + action + ".");
            }
            Dictionary<string, object> d = new Dictionary<string, object>();
            Dictionary<string, object> expect = Args.Obj(a, "expect");
            if (expect == null)
            {
                Thread.Sleep(Args.Clamp(Args.Int(a, "settleMs", 250), 0, 3000));
                ReadBack(el, hwnd, action, d);
            }
            else
            {
                // B-080: re-read every 100 ms until the expected state shows, at most 2 s (the runtime's VERIFY_MS).
                System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
                Until(2000, delegate () { ReadBack(el, hwnd, action, d); return Settled(expect, d); });
                d["waitedMs"] = clock.ElapsedMilliseconds;
            }
            IntPtr foreground = Native.GetForegroundWindow();
            if (foreground != IntPtr.Zero) d["foreground"] = Windows.Describe(foreground, foreground, null);
            if (clickedAt != null) d["at"] = clickedAt;
            return d;
        }

        static string ToggleOf(TogglePattern toggle)
        {
            return toggle.Current.ToggleState.ToString().ToLowerInvariant();
        }

        /// Reads every 100 ms until `shows` holds, at most `ms`; true when it showed.
        static bool Until(int ms, Func<bool> shows)
        {
            System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
            while (!shows())
            {
                if (clock.ElapsedMilliseconds >= ms) return false;
                Thread.Sleep(100);
            }
            return true;
        }

        /// The element's state after a step, into d ("element", "exists"). B-080: gone is a window no longer there (after
        /// window_close also a hidden one), an element no longer available, or the dead node UI Automation hands back for a
        /// removed element (no control type, no name).
        static void ReadBack(AutomationElement el, IntPtr hwnd, string action, Dictionary<string, object> d)
        {
            d.Remove("element");
            d["exists"] = false;
            if (!Native.IsWindow(hwnd) || (action == "window_close" && !Native.IsWindowVisible(hwnd))) return;
            try
            {
                Dictionary<string, object> node = Node(el.GetUpdatedCache(Request()), 0, -1);
                if ((string)node["role"] == "unknown" && !node.ContainsKey("name")) return;
                d["element"] = node;
                d["exists"] = true;
            }
            catch (ElementNotAvailableException) { }
        }

        /// Does the read-back show what `expect` names (value, toggle, expanded, selected, gone)? A gone element ends the
        /// re-reading too: nothing about it changes any more. The expected window the runtime looks for itself.
        static bool Settled(Dictionary<string, object> expect, Dictionary<string, object> d)
        {
            if (!(bool)d["exists"]) return true;
            Dictionary<string, object> node = (Dictionary<string, object>)d["element"];
            object gone = Args.Get(expect, "gone");
            if (gone is bool && (bool)gone) return false;
            string value = Args.Str(expect, "value", null);
            if (value != null && ValueText(node) != value) return false;
            string toggle = Args.Str(expect, "toggle", null);
            if (toggle != null && !string.Equals(node.ContainsKey("toggle") ? node["toggle"] as string : null, toggle)) return false;
            object expanded = Args.Get(expect, "expanded");
            if (expanded is bool && (node.ContainsKey("expand") && (node["expand"] as string) == "expanded") != (bool)expanded) return false;
            object selected = Args.Get(expect, "selected");
            if (selected is bool && node.ContainsKey("selected") != (bool)selected) return false;
            return true;
        }

        static string ValueText(Dictionary<string, object> node)
        {
            object v;
            if (!node.TryGetValue("value", out v) || v == null) return "";
            if (v is double) return ((double)v).ToString(CultureInfo.InvariantCulture);
            return v as string ?? "";
        }
    }

    // ------------------------------------------------------------------ request dispatch
    public static class Dispatcher
    {
        static Dictionary<string, object> Error(string code, string message)
        {
            Dictionary<string, object> e = new Dictionary<string, object>();
            e["code"] = code;
            e["message"] = Args.Clip(message, 600);
            return e;
        }

        public static string Ready(bool dpiAware)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["ready"] = true;
            d["protocol"] = 4;
            d["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
            d["dpiAware"] = dpiAware;
            return Json.Write(d);
        }

        public static string Ok(object id, object result)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["id"] = id;
            d["ok"] = true;
            d["result"] = result;
            return Json.Write(d);
        }

        public static string Fail(object id, string code, string message)
        {
            return Fail(id, code, message, null);
        }

        /// app: what input refused on a Workforce window would hit (code 'app_window').
        public static string Fail(object id, string code, string message, Dictionary<string, object> app)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["id"] = id;
            d["ok"] = false;
            Dictionary<string, object> e = Error(code ?? "internal", message ?? "The computer-use helper failed.");
            if (app != null) e["app"] = app;
            d["error"] = e;
            return Json.Write(d);
        }

        static Dictionary<string, object> Done()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["done"] = true;
            return d;
        }

        public static string Handle(Dictionary<string, object> request)
        {
            object id = Args.Get(request, "id");
            try
            {
                string op = Args.Str(request, "op", "");
                Dictionary<string, object> a = Args.Obj(request, "args") ?? new Dictionary<string, object>();
                return Ok(id, Run(op, a));
            }
            catch (AppWindowException e) { return Fail(id, e.Code, e.Message, e.App); }
            catch (HelperException e) { return Fail(id, e.Code, e.Message); }
            catch (ElementNotAvailableException) { return Fail(id, "not_found", "The element disappeared while it was used; the action may have run. Observe again and check before repeating it."); }
            catch (ElementNotEnabledException) { return Fail(id, "conflict", "The element is disabled."); }
            catch (InvalidOperationException e) { return Fail(id, "conflict", "The element refused the action: " + Args.Clip(e.Message, 200)); }
            catch (System.ComponentModel.Win32Exception e) { return Fail(id, "unavailable", "Windows refused: " + Args.Clip(e.Message, 200)); }
            catch (TimeoutException) { return Fail(id, "timeout", "The application did not respond in time."); }
            catch (Exception e) { return Fail(id, "internal", e.GetType().Name + ": " + Args.Clip(e.Message, 300)); }
        }

        static object Run(string op, Dictionary<string, object> a)
        {
            switch (op)
            {
                case "ping":
                    return Done();
                case "config":
                    Guard.AppPids.Clear();
                    List<object> pids = Args.List(a, "appPids");
                    if (pids != null) foreach (object pid in pids) if (pid is double) Guard.AppPids[(int)(double)pid] = true;
                    List<object> apps = Args.List(a, "apps");
                    HashSet<string> chosen = null;
                    if (apps != null) { chosen = new HashSet<string>(); foreach (object app in apps) if (app is string) chosen.Add(((string)app).ToLowerInvariant()); }
                    Guard.Apps = chosen;
                    return Done();
                case "presence":
                    return Presence.Read();
                case "screens":
                    return Screens.List();
                case "screenshot":
                    return Screens.Shot(a);
                case "windows":
                    return Windows.List();
                case "focus_window":
                    return Windows.Focus(Uia.Hwnd(a, false));
                case "tree":
                    return Uia.Tree(a);
                case "find":
                    return Uia.Find(a);
                case "focused":
                    return Uia.Focused();
                case "act":
                    return Uia.Act(a);
                case "click":
                    Input.Click(Args.ReqInt(a, "x"), Args.ReqInt(a, "y"), Args.Str(a, "button", "left"), Args.Clamp(Args.Int(a, "count", 1), 1, 3), Guard.Cleared(a));
                    return Input.At(Args.ReqInt(a, "x"), Args.ReqInt(a, "y"));
                case "move":
                    Input.MoveTo(Args.ReqInt(a, "x"), Args.ReqInt(a, "y"));
                    return Done();
                case "path":
                    return PathMotion.Run(a);
                case "scroll":
                    bool hasPoint = Args.Has(a, "x") && Args.Has(a, "y");
                    Input.Scroll(hasPoint, Args.Int(a, "x", 0), Args.Int(a, "y", 0), Args.Clamp(Args.Int(a, "dx", 0), -50, 50), Args.Clamp(Args.Int(a, "dy", 0), -50, 50));
                    return Done();
                case "type":
                    string text = Args.Str(a, "text", "");
                    if (text.Length == 0 || text.Length > 5000) throw new HelperException("bad_request", "text must have 1 to 5000 characters.");
                    Input.Type(text, Guard.Cleared(a));
                    return Done();
                case "key":
                    Input.Chord(Args.List(a, "vks"), Args.Clamp(Args.Int(a, "repeat", 1), 1, 50), Guard.Cleared(a));
                    return Done();
                case "release":
                    Dictionary<string, object> held = new Dictionary<string, object>();
                    held["released"] = Input.Release();
                    return held;
                case "cursor":
                    Native.POINT p;
                    Native.GetCursorPos(out p);
                    Dictionary<string, object> c = Presence.Read(); // the idle times tell whether the person moved it last
                    c["x"] = p.X;
                    c["y"] = p.Y;
                    IntPtr under = Native.GetAncestor(Native.WindowFromPoint(p), 2); // GA_ROOT: B-081, the window the pointer rests on
                    int length = under == IntPtr.Zero ? 0 : Native.GetWindowTextLength(under);
                    if (length > 0)
                    {
                        StringBuilder name = new StringBuilder(Math.Min(512, length + 1));
                        Native.GetWindowText(under, name, name.Capacity);
                        if (name.Length > 0) c["window"] = Args.Clip(name.ToString(), 120);
                    }
                    return c;
                default:
                    throw new HelperException("bad_request", "Unknown op " + op + ".");
            }
        }
    }
}
'@

# ---------------------------------------------------------------- compile once per process
function Get-AssemblyPath([string]$name) {
  Add-Type -AssemblyName $name
  $assembly = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq $name } | Select-Object -First 1
  return $assembly.Location
}

$references = @('System', 'System.Drawing', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase') | ForEach-Object { Get-AssemblyPath $_ }
Add-Type -TypeDefinition $source -ReferencedAssemblies $references -Language CSharp
$dpiAware = [WorkforceHelper.Native]::InitDpi()

# ---------------------------------------------------------------- optional OCR (WinRT, PowerShell 5.1 only)
$script:ocrReady = $false
$script:asTask = $null

function Initialize-Ocr {
  if ($script:ocrReady) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1
  $script:ocrReady = $true
}

function Wait-WinRt($operation, [Type]$resultType) {
  $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(25000)) { throw (New-Object WorkforceHelper.HelperException('timeout', 'Text recognition timed out.')) }
  return $task.Result
}

function Invoke-Ocr($opArgs) {
  try { Initialize-Ocr } catch { throw (New-Object WorkforceHelper.HelperException('unavailable', 'Windows text recognition is not available on this PC.')) }
  $rect = [WorkforceHelper.Screens]::Bounds($opArgs)
  $png = [WorkforceHelper.Screens]::GrabPng($opArgs, $rect)
  $memory = New-Object System.IO.MemoryStream(, $png)
  $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
  $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = $null
  $language = [WorkforceHelper.Args]::Str($opArgs, 'language', $null)
  if ($language -is [string] -and $language.Length -gt 0) {
    try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($language))) } catch { $engine = $null }
  }
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { throw (New-Object WorkforceHelper.HelperException('unavailable', 'No text-recognition language is installed in Windows.')) }
  $result = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = New-Object 'System.Collections.Generic.List[object]'
  foreach ($line in $result.Lines) {
    $left = [double]::MaxValue; $top = [double]::MaxValue; $right = 0.0; $bottom = 0.0
    foreach ($word in $line.Words) {
      $box = $word.BoundingRect
      if ($box.X -lt $left) { $left = $box.X }
      if ($box.Y -lt $top) { $top = $box.Y }
      if ($box.X + $box.Width -gt $right) { $right = $box.X + $box.Width }
      if ($box.Y + $box.Height -gt $bottom) { $bottom = $box.Y + $box.Height }
    }
    if ($left -eq [double]::MaxValue) { continue }
    $entry = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    $entry['text'] = [string]$line.Text
    $box = New-Object 'System.Collections.Generic.List[object]'
    $box.Add([int][Math]::Round($rect.X + $left)); $box.Add([int][Math]::Round($rect.Y + $top))
    $box.Add([int][Math]::Round($right - $left)); $box.Add([int][Math]::Round($bottom - $top))
    $entry['rect'] = $box
    $lines.Add($entry)
  }
  $out = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $out['lines'] = $lines
  $out['language'] = [string]$engine.RecognizerLanguage.LanguageTag
  return $out
}

# ---------------------------------------------------------------- protocol loop
$utf8 = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true
$writer.NewLine = "`n"
$writer.WriteLine([WorkforceHelper.Dispatcher]::Ready($dpiAware))

while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  $out = $null
  try {
    $request = [WorkforceHelper.Json]::Parse($line)
    $id = [WorkforceHelper.Args]::Get($request, 'id')
    if ([WorkforceHelper.Args]::Get($request, 'op') -eq 'ocr') {
      $opArgs = [WorkforceHelper.Args]::Obj($request, 'args')
      if ($null -eq $opArgs) { $opArgs = New-Object 'System.Collections.Generic.Dictionary[string,object]' }
      $out = [WorkforceHelper.Dispatcher]::Ok($id, (Invoke-Ocr $opArgs))
    } else {
      $out = [WorkforceHelper.Dispatcher]::Handle($request)
    }
  } catch {
    $exception = $_.Exception
    while ($null -ne $exception.InnerException -and -not ($exception -is [WorkforceHelper.HelperException])) { $exception = $exception.InnerException }
    if ($exception -is [WorkforceHelper.HelperException]) {
      $out = [WorkforceHelper.Dispatcher]::Fail($id, $exception.Code, $exception.Message)
    } else {
      $out = [WorkforceHelper.Dispatcher]::Fail($id, 'internal', [string]$exception.Message)
    }
  }
  $writer.WriteLine($out)
}
