// WindowsHelper process client against a fake child process (no PowerShell is started). B-080: the helper's C# as text –
// focus_window gets past Windows' foreground lock by attaching to the front window's input thread (no key presses), and an
// unsupported pattern names the computer.act actions the element takes (the broker compiles the same C#).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WindowsHelper } from '../../../src/runtime/computer/helper.ts';
import { HELPER_PROTOCOL } from '../../../src/runtime/computer/protocol.ts';
import { MemoryLogger } from '../fakes.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { fakeSpawn, testSupervisor, type SpawnCall } from '../engines/fakes.ts';

function scripted(answer: (message: { id: number; op: string; args: Record<string, unknown> }, call: SpawnCall) => void, ready = true) {
  return fakeSpawn((call) => {
    call.child.onLine = (message) => answer(message, call);
    if (ready) setImmediate(() => call.child.send({ ready: true, protocol: HELPER_PROTOCOL, pid: 4242, dpiAware: true }));
  });
}

test('starts lazily, matches answers by id and maps error codes', async () => {
  const fake = scripted((message, call) => {
    if (message.op === 'config' || message.op === 'windows') call.child.send({ id: message.id, ok: true, result: message.op === 'windows' ? [{ hwnd: 1 }] : { done: true } });
    if (message.op === 'act') call.child.send({ id: message.id, ok: false, error: { code: 'conflict', message: 'The element changed' } });
    // B-044: a press on the Workforce window – what it would hit travels with the refusal.
    if (message.op === 'click') call.child.send({ id: message.id, ok: false, error: { code: 'app_window', message: 'That point is on the Workforce window', app: { window: 77, point: { x: 5, y: 6 }, junk: 1 } } });
    if (message.op === 'presence') {
      call.child.send({ id: 9999, ok: true, result: 'late answer of something else' }); // ignored
      call.child.stdout.write('WARNING: noise from PowerShell\n');
      call.child.send({ id: message.id, ok: true, result: { idleMs: 5 } });
    }
  });
  const helper = new WindowsHelper({ supervisor: testSupervisor(fake.spawn), scriptPath: 'C:\\app\\resources\\computer\\windows-helper.ps1', log: new MemoryLogger() });
  assert.equal(fake.calls.length, 0); // lazy
  assert.deepEqual(await helper.call('windows'), [{ hwnd: 1 }]);
  assert.equal(fake.calls.length, 1);
  const { command, args } = fake.calls[0];
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\app\\resources\\computer\\windows-helper.ps1']);
  assert.equal((fake.calls[0].child.lines[0] as { op: string }).op, 'windows', 'no config line first');
  assert.equal(helper.running(), true);
  await assert.rejects(helper.call('act', { rid: '1' }), (error: unknown) => error instanceof WorkforceError && error.code === 'conflict' && error.message === 'The element changed' && error.details === undefined);
  await assert.rejects(helper.call('click', { x: 5, y: 6 }), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden' && error.details === undefined);
  assert.deepEqual(await helper.call('presence'), { idleMs: 5 });
  assert.equal(fake.calls.length, 1); // one persistent process
  await helper.dispose();
  assert.equal(helper.running(), false);
});

test('a hung request times out and restarts the helper; a crash rejects what is pending', async () => {
  const fake = scripted((message, call) => {
    if (message.op === 'windows') call.child.send({ id: message.id, ok: true, result: [] });
    if (message.op === 'cursor') call.child.exit(1);
    // 'tree' never answers
  });
  const helper = new WindowsHelper({ supervisor: testSupervisor(fake.spawn), scriptPath: 'h.ps1', log: new MemoryLogger() });
  await helper.call('windows');
  await assert.rejects(helper.call('tree', {}, { timeoutMs: 30 }), (error: unknown) => error instanceof WorkforceError && error.code === 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.calls[0].child.killed, true);
  await helper.call('windows');
  assert.equal(fake.calls.length, 2); // restarted on demand
  const crashed = helper.call('cursor');
  await assert.rejects(crashed, (error: unknown) => error instanceof WorkforceError && /stopped|restarted/.test(error.message));
  await helper.dispose();
});

test('a helper that exits before it is ready reports unavailable and cools down after repeated failures', async () => {
  const fake = fakeSpawn((call) => setImmediate(() => call.child.exit(1)));
  let now = 1_000;
  const helper = new WindowsHelper({ supervisor: testSupervisor(fake.spawn), scriptPath: 'h.ps1', log: new MemoryLogger(), now: () => now });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(helper.call('ping'), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && /could not start/.test(error.message));
  }
  await assert.rejects(helper.call('ping'), /failed to start several times/);
  assert.equal(fake.calls.length, 3);
  now += 61_000;
  await assert.rejects(helper.call('ping'), /could not start/);
  assert.equal(fake.calls.length, 4);
});

const SOURCE = readFileSync(new URL('../../../resources/computer/windows-helper.ps1', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** The body of one C# member of the helper, up to its closing brace at the class member indentation. */
const method = (signature: string) => {
  const start = SOURCE.indexOf(signature);
  assert.ok(start >= 0, signature);
  const end = SOURCE.slice(start).search(/\n {8}\};?\n/);
  assert.ok(end > 0, `end of ${signature}`);
  return SOURCE.slice(start, start + end);
};

test('B-080 focus_window: when another window stays in front, it attaches to that window\'s input thread around BringWindowToTop/SetForegroundWindow and detaches', () => {
  for (const line of [
    '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);',
    '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);',
    '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  ]) assert.ok(SOURCE.includes(line), line);
  const focus = method('public static Dictionary<string, object> Focus(IntPtr hwnd)');
  const order = [
    'Native.SetForegroundWindow(hwnd);', 'IntPtr front = Native.GetForegroundWindow();', 'if (front != hwnd)',
    'Native.GetWindowThreadProcessId(front, out frontPid)', 'Native.GetCurrentThreadId()', 'Native.AttachThreadInput(ownThread, frontThread, true)',
    'Native.BringWindowToTop(hwnd);', 'Native.SetForegroundWindow(hwnd);', 'finally', 'if (attached) Native.AttachThreadInput(ownThread, frontThread, false);',
    'AutomationElement.FromHandle(hwnd).SetFocus()', 'd["focused"] = Native.GetForegroundWindow() == hwnd;',
  ];
  let at = 0;
  for (const step of order) {
    const found = focus.indexOf(step, at);
    assert.ok(found >= 0, `in order: ${step}`);
    at = found + step.length;
  }
  assert.doesNotMatch(focus, /SendInput|keybd_event|Input\.Key/, 'no key presses');
});

test('B-080 an unsupported pattern names the computer.act actions of the element\'s patterns, and click where it has a point', () => {
  const map = method('static readonly Dictionary<string, string> PatternActions');
  assert.match(map, /\{ "ScrollItem", "scroll_into_view" \}/);
  assert.match(map, /\{ "ExpandCollapse", "expand, collapse" \}/);
  for (const [pattern, action] of [['Invoke', 'invoke'], ['Toggle', 'toggle'], ['SelectionItem', 'select'], ['Value', 'set_value'], ['Scroll', 'scroll']]) {
    assert.ok(map.includes(`{ "${pattern}", "${action}" }`), pattern);
  }
  const hint = method('static object Pattern(AutomationElement el, AutomationPattern pattern, string label)');
  assert.match(hint, /PatternActions\.TryGetValue\(name, out action\)/);
  assert.match(hint, /if \(Clickable\(el\)\) actions\.Add\("click"\);/);
  assert.match(hint, /" I reach it with computer\.act " \+ string\.Join\(", ", actions\.ToArray\(\)\)/);
  assert.doesNotMatch(SOURCE, /Try action 'click'\./, 'no fixed click hint');
  assert.match(method('static bool Clickable(AutomationElement el)'), /TryGetClickablePoint\(out point\) \|\| !el\.Current\.BoundingRectangle\.IsEmpty/);
});
