// 21.11.2026 (owner: a tab goes onto a PC of a chosen person – by default their only PC or the one I am on – shows on
// their other PCs and phones, and can be shared with other people): src/runtime/pane – targets (whose PCs), place (put
// in / take out of side-tabs.json), put (carry, receive, putOn, shareOn), shares (who reaches what) and relay (an
// employee's PC reaches a colleague's PC through the company's PC, once, with the caller's person).
// Owns: these assertions only. Never: a real mesh, Electron or browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPc, paneTargets, pcsOf } from '../../../src/runtime/pane/targets.ts';
import { placeEntry, takeOut, ownBrowser } from '../../../src/runtime/pane/place.ts';
import { carry, localForm, putOn, receive, shareOn } from '../../../src/runtime/pane/put.ts';
import { addShare, callerPerson, reach, shareOf, sharedWith } from '../../../src/runtime/pane/shares.ts';
import { callPc, relayHandler } from '../../../src/runtime/pane/relay.ts';
import { entryOf, registerPane } from '../../../src/runtime/pane/mesh.ts';
import { sideTabsFile, writeSideTabs } from '../../../src/runtime/root/side-tabs.ts';
import { shareKey } from '../../../src/shared/model/pane.ts';
import { paneRig } from './rig.ts';

const code = (error: unknown) => (error as { code?: string }).code;
const CEO_PCS: Array<[string, Record<string, unknown>]> = [
  ['dev_note', { name: 'Notebook' }], ['dev_mac', { name: 'MacBook', personId: 'per_momo1234' }],
];

test('whose PCs: mine (this one first), a colleague\'s by their links, nobody\'s pane without a PC; the default PC', (t) => {
  const r = paneRig({ pcs: CEO_PCS, online: ['dev_mac'] });
  t.after(r.cleanup);
  assert.deepEqual(pcsOf(r.services, 'human').map((pc) => pc.id), ['dev_tower', 'dev_note']);
  assert.deepEqual(pcsOf(r.services, 'per_momo1234'), [{ id: 'dev_mac', name: 'MacBook', online: true }]);
  assert.deepEqual(pcsOf(r.services, 'per_lena1234'), [], 'Lena has a phone only');
  const mine = pcsOf(r.services, 'human');
  assert.equal(defaultPc(mine, 'dev_note')?.id, 'dev_note', 'the PC I am on when it is theirs');
  assert.equal(defaultPc(pcsOf(r.services, 'per_momo1234'), 'dev_tower')?.id, 'dev_mac', 'else their only one');
  assert.deepEqual(paneTargets(r.services).map((person) => [person.id, person.me, person.pcs.length]), [['human', true, 2], ['per_momo1234', false, 1], ['per_lena1234', false, 0]]);
});

test('place: a tab is put in once and shown; taking it out keeps the rest and empties nothing else', () => {
  const web = { id: 'web-1', url: 'https://a.example/' };
  const panel = ownBrowser('ag_ada');
  const placed = placeEntry({ global: { shown: 'web-1', tabs: [web] } }, 'global', panel);
  assert.deepEqual(placed.global, { shown: panel.id, tabs: [web, panel] });
  assert.deepEqual(placeEntry(placed, 'global', panel).global!.tabs.length, 2);
  const out = takeOut(placeEntry(placed, 'chat:ch_1', panel), panel.id);
  assert.deepEqual([out.from, out.spaces.global, out.spaces['chat:ch_1']], [['global', 'chat:ch_1'], { tabs: [web] }, undefined]);
});

test('carry and localForm: open runs a website anew there, share gives a view of this one; a copy naming a PC is that PC\'s own again', () => {
  const web = { id: 'web-1', url: 'https://a.example/', title: 'A' };
  assert.deepEqual(carry(web, 'dev_tower', 'dev_mac', 'open'), { id: '', url: 'https://a.example/' });
  const view = carry(web, 'dev_tower', 'dev_mac', 'share');
  assert.deepEqual(view, { id: 'remote:dev_tower:web-1', panel: 'remote', device: 'dev_tower', tab: 'web-1', url: 'https://a.example/', title: 'A' });
  assert.deepEqual(localForm(view, 'dev_tower'), { id: 'web-1' });
  const file = { id: 'file:C:/x.md', panel: 'file', path: 'C:/x.md' };
  const there = carry(file, 'dev_tower', 'dev_mac', 'share');
  assert.deepEqual(there, { id: 'file@dev_tower:C:/x.md', panel: 'file', path: 'C:/x.md', device: 'dev_tower' });
  assert.deepEqual(localForm(there, 'dev_tower'), file);
  const notes = { id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' };
  assert.equal(carry(notes, 'dev_tower', 'dev_mac', 'open'), notes, 'the same everywhere');
  assert.equal(shareKey(view), 'web-1');
  assert.equal(shareKey(there), 'path:C:/x.md');
  assert.equal(shareKey(notes), undefined);
});

test('receive: a website address opens in the pane here, any other tab is put in and shown; only a person\'s pane takes it', async (t) => {
  const r = paneRig();
  t.after(r.cleanup);
  assert.equal(await receive(r.services, { entry: { id: '', url: 'https://a.example/' }, by: { id: 'ag_ada', name: 'Ada' } }), 'web-new');
  assert.deepEqual(r.opened[0], { action: 'open', url: 'https://a.example/', newTab: true, show: true, space: 'global', agent: { id: 'ag_ada', name: 'Ada' } });
  await receive(r.services, { entry: ownBrowser('ag_ada'), space: 'person:per_lena1234' });
  assert.equal(r.spaces()['person:per_lena1234']!.shown, 'agent:ag_ada');
  await assert.rejects(receive(r.services, { entry: ownBrowser('ag_ada'), space: 'chat:ch_1' }), /person's pane/);
  assert.throws(() => entryOf({ id: 'x', url: 'file:///C:/secret' }), /http\(s\) address/);
});

test('putOn: here, on another PC of the person, or – for a person without a PC – on the company\'s PCs; a PC that is not theirs is named', async (t) => {
  const r = paneRig({ pcs: CEO_PCS });
  t.after(r.cleanup);
  const mine = await putOn(r.services, { entry: ownBrowser('ag_ada'), mode: 'share' });
  assert.deepEqual([mine.pc.id, r.spaces().global!.shown], ['dev_tower', 'agent:ag_ada']);
  const momo = await putOn(r.services, { person: 'per_momo1234', entry: { id: 'web-1', url: 'https://a.example/' }, mode: 'open', by: { id: 'ag_ada', name: 'Ada' } });
  assert.deepEqual([momo.pc.id, momo.id], ['dev_mac', 'web-far']);
  assert.deepEqual(r.calls[0], { device: 'dev_mac', method: 'pane.put', params: { entry: { id: '', url: 'https://a.example/' }, by: { id: 'ag_ada', name: 'Ada' } } });
  const lena = await putOn(r.services, { person: 'per_lena1234', entry: ownBrowser('ag_ada'), mode: 'share' });
  assert.deepEqual([lena.pc.id, lena.space], ['dev_tower', 'person:per_lena1234']);
  await assert.rejects(putOn(r.services, { person: 'per_momo1234', pc: 'dev_note', entry: ownBrowser('ag_ada'), mode: 'share' }), /dev_note is no PC of per_momo1234\. Their PCs: MacBook \(dev_mac\)/);
  await putOn(r.services, { pc: 'notebook', entry: ownBrowser('ag_ada'), mode: 'share' });
  assert.equal(r.calls.at(-1)!.device, 'dev_note', 'a PC by its name');
});

test('shareOn takes the whole set: records it on the origin, puts it in the panes of the new ones, takes it out of the left-out ones; [] ends it', async (t) => {
  const r = paneRig({ pcs: CEO_PCS });
  t.after(r.cleanup);
  const web = { id: 'web-1', url: 'https://a.example/' };
  assert.deepEqual(await shareOn(r.services, { entry: web, people: ['per_momo1234', 'human'] }), ['per_momo1234']);
  assert.deepEqual(r.calls[0]!.params.entry, { id: 'remote:dev_tower:web-1', panel: 'remote', device: 'dev_tower', tab: 'web-1', url: 'https://a.example/' });
  assert.deepEqual(shareOf(r.services, 'web-1'), { people: ['per_momo1234'], places: [{ person: 'per_momo1234', pc: 'dev_mac', space: 'global' }, { person: 'human', pc: 'dev_tower', space: 'global' }] });
  assert.deepEqual(await shareOn(r.services, { entry: web, people: ['per_momo1234', 'per_lena1234'] }), ['per_momo1234', 'per_lena1234']);
  assert.equal(r.calls.length, 1, "Momo had it already: only Lena's pane (on the company's PCs, here) is new");
  assert.equal(r.spaces()['person:per_lena1234']!.shown, 'remote:dev_tower:web-1');
  assert.deepEqual(await shareOn(r.services, { entry: web, people: ['per_momo1234'] }), ['per_momo1234'], 'the whole set: Lena is left out');
  assert.equal(r.spaces()['person:per_lena1234'], undefined, 'and out of her pane');
  assert.deepEqual(await shareOn(r.services, { entry: web, people: [] }), []);
  assert.deepEqual(r.calls.at(-1), { device: 'dev_mac', method: 'pane.remove', params: { id: 'remote:dev_tower:web-1', space: 'global' } });
  assert.equal(shareOf(r.services, 'web-1'), undefined);
  await shareOn(r.services, { entry: { id: 'remote:dev_note:web-9', panel: 'remote', device: 'dev_note', tab: 'web-9', url: 'https://b.example/' }, people: ['per_momo1234'] });
  assert.deepEqual([r.calls.at(-1)!.device, r.calls.at(-1)!.method, (r.calls.at(-1)!.params.entry as { id: string }).id], ['dev_note', 'pane.share', 'web-9'], 'a tab of my other PC is shared there');
  await assert.rejects(shareOn(r.services, { entry: { id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' }, people: ['per_momo1234'] }), /Open on/);
});

test('shares: my own PCs reach everything; an employee\'s PC or the company passing on a colleague only what is shared with that person', (t) => {
  const r = paneRig({ pcs: [...CEO_PCS, ['dev_boss', { joinedAs: 'employee', name: 'Company' }]] });
  t.after(r.cleanup);
  addShare(r.services, 'web-1', ['per_momo1234']);
  addShare(r.services, 'path:C:/Work/Shared', ['owner']);
  assert.deepEqual([callerPerson(r.services, 'dev_note'), callerPerson(r.services, 'dev_mac'), callerPerson(r.services, 'dev_boss'), callerPerson(r.services, 'dev_boss', 'per_lena1234'), callerPerson(r.services, 'dev_x')], ['human', 'per_momo1234', 'owner', 'per_lena1234', undefined]);
  assert.equal(reach(r.services, 'dev_note', 'web-2'), 'human');
  assert.equal(reach(r.services, 'dev_mac', 'web-1'), 'per_momo1234');
  assert.throws(() => reach(r.services, 'dev_mac', 'web-2'), (error: unknown) => code(error) === 'forbidden');
  assert.throws(() => reach(r.services, 'dev_boss', 'web-1', 'per_lena1234'), (error: unknown) => code(error) === 'forbidden');
  assert.equal(sharedWith(r.services, 'path:C:\\Work\\Shared\\plan.md', 'owner'), true, 'inside a shared folder');
  assert.equal(sharedWith(r.services, 'path:C:/Work/SharedNot/plan.md', 'owner'), false);
});

test('relay: a linked PC is called directly; a colleague\'s PC through the company, which passes it on once with the caller\'s person', async (t) => {
  const employee = paneRig({ self: 'dev_mac', pcs: [['dev_boss', { joinedAs: 'employee' }]] });
  t.after(employee.cleanup);
  await callPc(employee.services, 'dev_boss', 'pane.put', { entry: { id: 'x' } });
  await callPc(employee.services, 'dev_lena_pc', 'side.pull', { tab: 'web-1' });
  assert.deepEqual(employee.calls.map((call) => [call.device, call.method]), [['dev_boss', 'pane.put'], ['dev_boss', 'pane.relay']]);
  await assert.rejects(callPc(employee.services, 'dev_lena_pc', 'shell.exec', {}), /cannot be reached/);
  const company = paneRig({ pcs: [['dev_mac', { personId: 'per_momo1234' }], ['dev_lena_pc', { personId: 'per_lena1234' }], ['dev_note', {}]] });
  t.after(company.cleanup);
  const relay = relayHandler(() => company.services);
  const signal = new AbortController().signal;
  await relay({ to: 'dev_lena_pc', method: 'side.pull', params: { tab: 'web-1', for: 'human' } }, 'dev_mac', signal);
  assert.deepEqual(company.calls[0], { device: 'dev_lena_pc', method: 'side.pull', params: { tab: 'web-1', for: 'per_momo1234' } }, 'the company names the caller, never the caller itself');
  for (const [to, method, from] of [['dev_note', 'side.pull', 'dev_mac'], ['dev_lena_pc', 'shell.exec', 'dev_mac'], ['dev_lena_pc', 'side.pull', 'dev_note']]) {
    await assert.rejects(relay({ to, method, params: {} }, from!, signal), (error: unknown) => code(error) === 'forbidden', `${from} → ${to} ${method}`);
  }
});

test('review 21.11.: an employee\'s PC puts and takes out only views of its own tabs; my own PCs and the company anything', async (t) => {
  const r = paneRig({ pcs: [...CEO_PCS, ['dev_boss', { joinedAs: 'employee' }]] });
  t.after(r.cleanup);
  const handlers = new Map<string, (params: unknown, from: string, signal: AbortSignal) => Promise<unknown>>();
  registerPane({ register: (method, handler) => { handlers.set(method, handler); } }, () => r.services);
  const call = (method: string, params: unknown, from: string) => handlers.get(method)!(params, from, new AbortController().signal);
  const forbidden = (error: unknown) => (error as { code?: string }).code === 'forbidden';
  await assert.rejects(call('pane.put', { entry: ownBrowser('ag_ada'), space: 'person:per_lena1234' }, 'dev_mac'), forbidden, "no agent's browser from an employee's PC");
  await assert.rejects(call('pane.put', { entry: { id: 'remote:dev_note:web-1', panel: 'remote', device: 'dev_note', tab: 'web-1', url: 'https://a.example/' } }, 'dev_mac'), forbidden, 'no tab of another PC');
  assert.deepEqual(await call('pane.put', { entry: { id: 'remote:dev_mac:web-7', panel: 'remote', device: 'dev_mac', tab: 'web-7', url: 'https://m.example/' } }, 'dev_mac'), { id: 'remote:dev_mac:web-7' });
  assert.deepEqual(await call('pane.put', { entry: { id: '', url: 'https://m.example/' } }, 'dev_mac'), { id: 'web-new' }, 'a page that opens here anew');
  await call('pane.put', { entry: ownBrowser('ag_ada') }, 'dev_note');
  await assert.rejects(call('pane.remove', { id: 'agent:ag_ada' }, 'dev_mac'), forbidden);
  assert.deepEqual((await call('pane.remove', { id: 'remote:dev_mac:web-7' }, 'dev_mac') as { from: string[] }).from, ['global']);
  assert.equal(r.spaces().global!.tabs.some((tab) => tab.id === 'agent:ag_ada'), true, 'the CEO\'s tab stays');
  await call('pane.put', { entry: ownBrowser('ag_bo') }, 'dev_boss');
  assert.equal(r.spaces().global!.shown, 'agent:ag_bo', 'the company may (on an employee\'s PC)');
});

test('review 21.11.: a share changes by add and remove, ends only that person\'s copy in its space, reads who has it, and records who it reached', async (t) => {
  let offline = false;
  const r = paneRig({ pcs: CEO_PCS, reply: (call) => { if (offline) throw new Error('MacBook is offline'); return call.method === 'pane.put' ? { id: 'x' } : { ok: true }; } });
  t.after(r.cleanup);
  const web = { id: 'web-1', url: 'https://a.example/' };
  writeSideTabs(sideTabsFile(r.data), { global: { tabs: [{ id: 'web-1', url: 'https://a.example/' }] } });
  assert.deepEqual(await shareOn(r.services, { entry: web, add: ['per_lena1234', 'human'] }), ['per_lena1234']);
  assert.deepEqual(Object.keys(r.spaces()).sort(), ['global', 'person:per_lena1234'], 'my own copy is my own tab again, shown where it lives');
  assert.equal(r.spaces().global!.tabs.length, 1, 'never a second entry of the same website');
  assert.deepEqual(await shareOn(r.services, { entry: web }), ['per_lena1234'], 'no change: only reads');
  offline = true;
  await assert.rejects(shareOn(r.services, { entry: web, add: ['per_momo1234'] }), /Not reached now: Momo \(MacBook is offline\)\. The others see it\./);
  assert.deepEqual(shareOf(r.services, 'web-1')!.people, ['per_lena1234'], 'Momo is not recorded');
  assert.deepEqual(await shareOn(r.services, { entry: web, remove: ['per_lena1234'] }), []);
  assert.equal(r.spaces()['person:per_lena1234'], undefined, "Lena's copy left her space");
  assert.equal(r.spaces().global!.tabs[0]!.id, 'web-1', "the CEO's own tab stays");
});

test('review 21.11.: my own PC passing on a colleague\'s device names them; a passed-on call keeps its own wait', async (t) => {
  const r = paneRig({ pcs: CEO_PCS });
  t.after(r.cleanup);
  assert.equal(callerPerson(r.services, 'dev_note', 'per_lena1234'), 'per_lena1234');
  assert.throws(() => reach(r.services, 'dev_note', 'web-1', 'per_lena1234'), (error: unknown) => code(error) === 'forbidden');
  const employee = paneRig({ self: 'dev_mac', pcs: [['dev_boss', { joinedAs: 'employee' }]] });
  t.after(employee.cleanup);
  await callPc(employee.services, 'dev_lena_pc', 'files.path', { op: 'read' }, undefined, 150_000);
  assert.equal(employee.calls[0]!.params.timeoutMs, 150_000);
});
