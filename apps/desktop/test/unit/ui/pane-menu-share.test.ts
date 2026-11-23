// "Open on ›" and "Share with ›" of the three-dots menu (src/ui/workspace/share-tab.ts, pane-targets.ts; owner 21.11.2026
// "drei Punkte … auf welchem PC vom User … mit anderen Mitgliedern teilen"): the PCs per person (mine first, an offline
// one marked and still choosable, the tab's own PC ticked), a person without a PC only under Share with; the entry sent
// for a website, a path, an agent's browser and a chat's notes; a path tab on my own PC keeps the same path in place;
// Share with ticks from pane.share's answer; nothing where this connection has no pane.targets; one pane.targets, again
// on device/person events and a reconnect, no burst.
// Owns: these assertions only. Never: a real PC, a socket or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import type { PanePerson } from '../../../src/shared/model/pane.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';
import type { MenuSection } from '../../../src/ui/lib/ui.tsx';
import { openPanel, tabsOf } from '../../../src/ui/workspace/pages.ts';
import { paneTargets, watchPaneTargets } from '../../../src/ui/workspace/pane-targets.ts';
import { openOnSections, originOf, paneEntry, sharesOf, readShares, shareWithSection } from '../../../src/ui/workspace/share-tab.ts';

const SPACE = 'global';
const people: PanePerson[] = [
  { id: 'human', name: 'Me', me: true, pcs: [{ id: 'pc_here', name: 'Desk', online: true, self: true }, { id: 'pc_tower', name: 'Tower', online: false }] },
  { id: 'per_ana', name: 'Ana', me: false, pcs: [{ id: 'pc_ana', name: 'Ana laptop', online: true }] },
  { id: 'per_bo', name: 'Bo', me: false, pcs: [] },
];
const calls: Array<{ method: string; params: unknown }> = [];
const heard = new Map<string, (data: unknown) => void>();
const opened: Array<() => void> = [];
let answer: (method: string, params: unknown) => unknown = () => ({ ok: true });
Object.assign(rpc, {
  call: async (method: string, params?: unknown) => { calls.push({ method, params }); return answer(method, params); },
  on: (event: string, fn: (data: unknown) => void) => { heard.set(event, fn); return () => undefined; },
  onOpen: (fn: () => void) => { opened.push(fn); return () => undefined; },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const rows = (sections: MenuSection[]) => sections.map((section) => [section.title, section.items.map((item) => [item.label, item.hint, item.checked])]);
const pick = (sections: MenuSection[], label: string) => sections.flatMap((section) => section.items).find((item) => item.label === label)!;
const asOwner = () => { session.value = { kind: 'owner', allowedMethods: [], capabilities: [] } as unknown as SessionInfo; };

test('without pane.targets (a person\'s device): no call and no rows', () => {
  session.value = { kind: 'device', secure: true, allowedMethods: [], capabilities: [] } as unknown as SessionInfo;
  watchPaneTargets();
  assert.equal(calls.length, 0);
  assert.deepEqual(openOnSections({ id: 'web-1', url: 'https://a.example/' }, people, SPACE), []);
  assert.deepEqual(shareWithSection({ id: 'web-1', url: 'https://a.example/' }, people, []), []);
});

test('pane.targets once, again on device and person events and a reconnect; a burst asks once more, not per event', async () => {
  asOwner();
  answer = (method) => (method === 'pane.targets' ? people : { ok: true });
  watchPaneTargets();
  watchPaneTargets();
  await settle();
  assert.equal(calls.filter((call) => call.method === 'pane.targets').length, 1);
  assert.deepEqual(paneTargets.value, people);
  for (const event of ['device.upserted', 'device.removed', 'person.upserted', 'person.removed']) assert.ok(heard.has(event), event);
  heard.get('device.upserted')!({});
  heard.get('device.upserted')!({});
  heard.get('person.upserted')!({});
  await settle(); await settle();
  assert.equal(calls.filter((call) => call.method === 'pane.targets').length, 3, 'the first event asks, the burst behind it once more');
  opened[0]!();
  await settle();
  assert.equal(calls.filter((call) => call.method === 'pane.targets').length, 4);
});

test('the entry each kind sends: a website with its address, a path with its PC, an agent\'s browser, a chat\'s notes; a blank tab none', () => {
  assert.deepEqual(paneEntry({ id: 'web-1', kind: 'website' }, 'https://a.example/x'), { id: 'web-1', url: 'https://a.example/x' });
  assert.deepEqual(paneEntry({ id: 'file@pc_tower:/n/a.md', kind: 'file', path: '/n/a.md', device: 'pc_tower' }), { id: 'file@pc_tower:/n/a.md', panel: 'file', path: '/n/a.md', device: 'pc_tower' });
  assert.deepEqual(paneEntry({ id: 'agent:ag_1', kind: 'agent', agentId: 'ag_1' }), { id: 'agent:ag_1', panel: 'agent', agentId: 'ag_1' });
  assert.deepEqual(paneEntry({ id: 'notes:c1', kind: 'notes', conversationId: 'c1' }), { id: 'notes:c1', panel: 'notes', conversationId: 'c1' });
  assert.equal(paneEntry({ id: 'new-1', kind: 'new' }), undefined);
  assert.equal(originOf({ id: 'web-1' }, 'pc_here'), 'pc_here');
  assert.equal(originOf({ id: 'remote:pc_tower:web-2', panel: 'remote', device: 'pc_tower', tab: 'web-2', url: 'u' }, 'pc_here'), 'pc_tower');
  assert.equal(originOf({ id: 'folder:/n', panel: 'folder', path: '/n' }, 'pc_here'), 'pc_here');
  assert.equal(originOf({ id: 'tasks', panel: 'tasks' }, 'pc_here'), undefined);
});

test('Open on: my PCs first, then each person with a PC; the tab\'s PC ticked, an offline one marked; a person without a PC not listed', () => {
  asOwner();
  const website = openOnSections({ id: 'web-1', url: 'https://a.example/' }, people, SPACE);
  assert.deepEqual(rows(website), [
    ['My PCs', [['Desk', 'This PC', true], ['Tower', 'Offline', false]]],
    ['Ana', [['Ana laptop', undefined, false]]],
  ]);
  const notes = openOnSections({ id: 'notes:c1', panel: 'notes', conversationId: 'c1' }, people, SPACE);
  assert.ok(notes.flatMap((section) => section.items).every((item) => !item.checked), 'an app tab: nothing ticked');
  const alone: PanePerson[] = [{ id: 'human', name: 'Me', me: true, pcs: [{ id: 'pc_here', name: 'Desk', online: true, self: true }] }];
  assert.deepEqual(openOnSections({ id: 'web-1' }, alone, SPACE), [], 'only the PC it already runs on: no Open on');
});

test('Open on another person\'s PC or another of mine calls pane.open with the entry; the ticked PC does nothing', async () => {
  asOwner();
  calls.length = 0;
  const entry = { id: 'web-1', url: 'https://a.example/' };
  const sections = openOnSections(entry, people, SPACE);
  pick(sections, 'Ana laptop').onSelect();
  pick(sections, 'Tower').onSelect(); // offline, still choosable
  pick(sections, 'Desk').onSelect();
  await settle();
  assert.deepEqual(calls, [
    { method: 'pane.open', params: { person: 'per_ana', pc: 'pc_ana', entry } },
    { method: 'pane.open', params: { person: 'human', pc: 'pc_tower', entry } },
  ]);
});

test('a path tab on my own PC shows that PC\'s path in its place; to another person it goes by pane.open with its PC', async () => {
  asOwner();
  calls.length = 0;
  openPanel({ kind: 'tasks' }, undefined, SPACE);
  openPanel({ kind: 'file', path: '/n/a.md' }, undefined, SPACE);
  const before = tabsOf(SPACE).map((tab) => tab.id);
  const at = before.indexOf('file:/n/a.md');
  const entry = paneEntry(tabsOf(SPACE)[at])!;
  const sections = openOnSections(entry, people, SPACE);
  assert.equal(pick(sections, 'Desk').checked, true, 'this PC\'s file: Desk ticked');
  pick(sections, 'Tower').onSelect();
  assert.equal(tabsOf(SPACE)[at]!.id, 'file@pc_tower:/n/a.md', 'same place, Tower\'s path');
  assert.equal(calls.length, 0);
  const there = paneEntry(tabsOf(SPACE)[at])!;
  assert.equal(pick(openOnSections(there, people, SPACE), 'Tower').checked, true);
  pick(openOnSections(there, people, SPACE), 'Ana laptop').onSelect();
  await settle();
  assert.deepEqual(calls, [{ method: 'pane.open', params: { person: 'per_ana', pc: 'pc_ana', entry: { id: 'file@pc_tower:/n/a.md', panel: 'file', path: '/n/a.md', device: 'pc_tower' } } }]);
});

test('Share with: the other people (one without a PC too), Everyone, Stop sharing – only for a tab with a share key', () => {
  asOwner();
  const web = { id: 'web-1', url: 'https://a.example/' };
  assert.deepEqual(rows(shareWithSection(web, people, ['per_ana'])), [
    [undefined, [['Ana', undefined, true], ['Bo', undefined, false], ['Everyone', undefined, false]]],
    [undefined, [['Stop sharing', undefined, undefined]]],
  ]);
  assert.equal(pick(shareWithSection(web, people, []), 'Stop sharing').disabled, true, 'nothing shared: nothing to stop');
  assert.equal(pick(shareWithSection(web, people, ['per_ana', 'per_bo']), 'Everyone').checked, true);
  assert.ok(shareWithSection({ id: 'agent:ag_1', panel: 'agent', agentId: 'ag_1' }, people, []).length, 'an agent\'s browser');
  assert.ok(shareWithSection({ id: 'folder:/n', panel: 'folder', path: '/n' }, people, []).length, 'a folder');
  assert.deepEqual(shareWithSection({ id: 'notes:c1', panel: 'notes', conversationId: 'c1' }, people, []), [], 'a chat\'s notes: no share key');
  assert.deepEqual(shareWithSection(web, [people[0]!], []), [], 'nobody else: no Share with');
});

test('review 21.11.: picking a person adds or removes only them (never a stale whole set); the answer ticks the rows; opening the row reads who has it; Stop sharing sends []', async () => {
  asOwner();
  calls.length = 0;
  let held: string[] = ['per_bo']; // shared by an agent or another window: this window never saw it
  answer = (method, params) => {
    if (method !== 'pane.share') return { ok: true };
    const p = params as { people?: string[]; add?: string[]; remove?: string[] };
    held = p.people ?? [...new Set([...held, ...(p.add ?? [])])].filter((id) => !(p.remove ?? []).includes(id));
    return { ok: true, people: held };
  };
  const web = { id: 'web-7', url: 'https://a.example/' };
  await readShares(web);
  assert.deepEqual(sharesOf.value['web-7'], ['per_bo'], 'read from where it runs');
  pick(shareWithSection(web, people), 'Ana').onSelect();
  await settle();
  assert.deepEqual(sharesOf.value['web-7'], ['per_bo', 'per_ana'], 'Bo keeps it');
  assert.equal(pick(shareWithSection(web, people), 'Ana').checked, true, 'ticked from the answer');
  pick(shareWithSection(web, people), 'Ana').onSelect(); // ticked: off again
  await settle();
  pick(shareWithSection(web, people), 'Everyone').onSelect();
  await settle();
  pick(shareWithSection(web, people), 'Stop sharing').onSelect();
  await settle();
  const sent = calls.map((call) => { const { entry: _entry, ...change } = call.params as Record<string, unknown>; return change; });
  assert.deepEqual(sent, [{}, { add: ['per_ana'] }, { remove: ['per_ana'] }, { add: ['per_ana', 'per_bo'] }, { people: [] }]);
  assert.ok(calls.every((call) => call.method === 'pane.share' && (call.params as { entry: unknown }).entry === web));
  assert.deepEqual(sharesOf.value['web-7'], []);
});
