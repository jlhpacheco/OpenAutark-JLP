// B-080 computer use: computer.act hands `expect` to the helper (its bounded re-read) and checks a window it names within
// the rest of the same VERIFY_MS, a dead read-back node counts as gone, a window step takes the window id alone; computer.type
// reads back where its text landed (the focused element with its ref and value, masked like a typed secret), and an
// older helper without that read keeps the one-line answer. Review: a window that opens in front (browser.open where:
// 'chrome') starts under the caller's pointer lease (inFront), and a window picture of a covered window says so.
// Owns: these assertions only. Never: a real helper, screen or vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import { computerTools } from '../../../src/runtime/computer/tools.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { MemoryLogger } from '../fakes.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { agent } from '../chat/harness.ts';

class FakeHelper implements HelperClient {
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  answers: Record<string, (args: Record<string, unknown>) => unknown> = {};
  async call<T>(op: HelperOp, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, args });
    const answer = this.answers[op];
    return (answer ? answer(args) : { done: true }) as T;
  }
  running(): boolean { return true; }
  async dispose(): Promise<void> {}
  last(op: string) { return this.calls.filter((call) => call.op === op).at(-1)!.args; }
}

const FIELD = 'Nachricht an Lena schreiben';

function rig() {
  const helper = new FakeHelper();
  const host = {
    kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node' },
    async idleSeconds() { return 60; },
  } as Host;
  const computer = new ComputerService({ host, supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(), helper, platform: 'win32' });
  helper.answers.tree = () => ({
    hwnd: 77, title: 'WhatsApp', truncated: false,
    nodes: [
      { d: 0, p: -1, rid: '1', role: 'window', name: 'WhatsApp' },
      { d: 1, p: 0, rid: '1.2', role: 'edit', name: 'Suchen', patterns: ['value'] },
      { d: 1, p: 0, rid: '1.3', role: 'edit', name: FIELD, patterns: ['value'] },
      { d: 1, p: 0, rid: '1.4', role: 'checkbox', name: 'My day', toggle: 'off', patterns: ['toggle'] },
    ],
  });
  helper.answers.focused = () => ({ hwnd: 77, nodes: [{ rid: '1.3', role: 'edit', name: FIELD, value: 'er', focused: true, patterns: ['value'] }] });
  const secrets = { list: () => [{ id: 'pw_1', label: 'App password', kind: 'password' }], use: async () => 'pw-desktop-app-31', redact: (text: string) => text };
  const ctx = { agent: agent('ag_lena', 'Lena'), runId: 'run_1', mode: 'computer', signal: new AbortController().signal, status() {}, services: { secrets } } as unknown as ToolContext;
  const tools = new Map(computerTools(computer).map((tool) => [tool.name, tool]));
  const run = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.run(args, ctx)) as ToolOutput;
  const textOf = (out: ToolOutput) => out.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
  return { computer, helper, run, textOf };
}

test('computer.type says where the text landed: the focused element now, its ref and value, and a focus that moved away from ref', async () => {
  const r = rig();
  await r.run('computer.ui_tree', { window: 77 }); // e1 window, e2 Suchen, e3 the chat's message box, e4 My day
  const typed = r.textOf(await r.run('computer.type', { text: 'Salzburger' }));
  assert.equal(typed, `Typed 10 characters.\nNow: edit "${FIELD}" [ref=e3] = "er" [focused]`);
  const moved = r.textOf(await r.run('computer.type', { text: 'Salzburger', ref: 'e2' }));
  assert.match(moved, /\nThe focus is no longer on e2\.$/);
  assert.equal(r.helper.last('act').action, 'focus');
  const kept = r.textOf(await r.run('computer.type', { text: 'er', ref: 'e3' }));
  assert.doesNotMatch(kept, /no longer/);
});

test('a typed secret shows as its handle in the Now line; a helper without the focused read keeps the one-line answer', async () => {
  const r = rig();
  r.helper.answers.focused = () => ({ hwnd: 77, nodes: [{ rid: '1.9', role: 'edit', name: 'Login', value: 'pw-desktop-app-31', focused: true }] });
  const out = r.textOf(await r.run('computer.type', { text: 'secret://pw_1' }));
  assert.equal(r.helper.last('type').text, 'pw-desktop-app-31', 'the value is typed');
  assert.ok(!out.includes('pw-desktop-app-31'), out);
  assert.match(out, /^Typed 17 characters\.\nNow: edit "Login" \[ref=e\d+\] = "secret:\/\/pw_1" \[focused\]$/);
  r.helper.answers.focused = () => { throw new WorkforceError('bad_request', 'Unknown op focused.'); };
  assert.equal(r.textOf(await r.run('computer.type', { text: 'abc' })), 'Typed 3 characters. I check the field before the next step.');
  assert.equal(await r.computer.focused(), undefined);
  r.helper.answers.focused = () => ({ hwnd: 77, nodes: [] });
  assert.equal(await r.computer.focused(), undefined, 'nothing holds the focus');
});

test('a window step takes the window id alone; expect travels to the helper; a dead read-back node is gone', async () => {
  const r = rig();
  r.helper.answers.act = () => ({ exists: true, element: { rid: '1', role: 'window', name: 'Explorer' } });
  const restored = await r.computer.act({ window: 123, action: 'window_restore' });
  assert.deepEqual([r.helper.last('act').hwnd, r.helper.last('act').rid, r.helper.last('act').action], [123, undefined, 'window_restore']);
  assert.equal(restored.target, 'window 123');
  await assert.rejects(r.computer.act({ action: 'invoke' }), /This step needs a ref from computer\.ui_tree/);
  await r.computer.uiTree({ window: 77 });
  r.helper.answers.act = () => ({ exists: true, element: { rid: '1.4', role: 'checkbox', name: 'My day', toggle: 'on' }, waitedMs: 300 });
  const toggled = await r.computer.act({ ref: 'e4', action: 'toggle', value: 'on', expect: { toggle: 'on' } });
  assert.deepEqual(r.helper.last('act').expect, { toggle: 'on' });
  assert.equal(toggled.verified, true);
  r.helper.answers.act = () => ({ exists: true, element: { rid: '1.4', role: 'unknown' } });
  const closed = await r.computer.act({ ref: 'e4', action: 'invoke', expect: { gone: true } });
  assert.deepEqual([closed.exists, closed.verified, closed.after], [false, true, undefined]);
  assert.match(closed.checks.join('\n'), /ok: element is gone/);
  r.helper.answers.act = () => ({ exists: true, element: { rid: '1.4', role: 'checkbox', name: 'My day' } });
  assert.equal((await r.computer.act({ ref: 'e4', action: 'invoke' })).exists, true, 'a named node is no dead one');
});

test('expect.window: the window list is read again until the window shows, within what is left of the same 2 s', async () => {
  const r = rig();
  await r.computer.uiTree({ window: 77 });
  let lists = 0;
  r.helper.answers.windows = () => (++lists < 2 ? [{ hwnd: 77, title: 'WhatsApp' }] : [{ hwnd: 77, title: 'WhatsApp' }, { hwnd: 78, title: 'Speichern unter' }]);
  r.helper.answers.act = () => ({ exists: true, element: { rid: '1.2', role: 'edit', name: 'Suchen' }, waitedMs: 0 });
  const shown = await r.computer.act({ ref: 'e2', action: 'invoke', expect: { window: 'speichern' } });
  assert.deepEqual([shown.verified, lists], [true, 2]);
  lists = 0;
  r.helper.answers.windows = () => { lists++; return [{ hwnd: 77, title: 'WhatsApp' }]; };
  r.helper.answers.act = () => ({ exists: true, element: { rid: '1.2', role: 'edit', name: 'Suchen' }, waitedMs: 2000 });
  const missing = await r.computer.act({ ref: 'e2', action: 'invoke', expect: { window: 'speichern' } });
  assert.deepEqual([missing.verified, lists], [false, 1], 'the helper used the 2 s: one look');
  assert.match(missing.checks.join('\n'), /FAILED: a window "speichern" is open/);
});

test('inFront: a window start holds my pointer lease while it runs; another agent holding the lease is refused', async () => {
  const r = rig();
  const ada = { key: 'ag_ada', id: 'ag_ada', name: 'Ada' };
  const lena = { key: 'ag_lena', id: 'ag_lena', name: 'Lena' };
  assert.equal(await r.computer.inFront(ada, async () => r.computer.lease.current()?.caller.key), 'ag_ada');
  let started = false;
  await assert.rejects(r.computer.inFront(lena, async () => { started = true; }), /Ada \(agent\) is using the mouse and keyboard on this PC/);
  assert.equal(started, false, 'refused before anything starts');
  assert.equal(await r.computer.inFront(undefined, async () => 'internal'), 'internal', 'an internal call is never refused');
});

test('a picture of a window behind another one or off the screen says that a click by coordinates lands on what is in front', async () => {
  const r = rig();
  const shot = (covered?: boolean) => () => ({ data: Buffer.from('x').toString('base64'), mime: 'image/jpeg', width: 4, height: 2, x: 0, y: 0, srcWidth: 4, ...(covered ? { covered } : {}) });
  r.helper.answers.screenshot = shot(true);
  const covered = r.textOf(await r.run('computer.screenshot', { window: 77 }));
  assert.match(covered, /\nThis window is behind another one or off the screen: the picture is the window itself, and a click by coordinates lands on what is in front there – I bring it forward first with computer\.act focus_window\./);
  r.helper.answers.screenshot = shot();
  assert.doesNotMatch(r.textOf(await r.run('computer.screenshot', { window: 77 })), /behind another one/);
});
