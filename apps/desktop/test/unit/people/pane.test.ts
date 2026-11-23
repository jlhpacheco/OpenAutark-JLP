// 18.11.2026: tabs shared with a person (src/runtime/people/rpc-pane.ts). A tab is shared by being in a chat's area
// (chat:<id> of side-tabs.json): tabs.get gives a person only the websites of the areas of their chats, side.pull /
// side.nav work only on such a tab (another one is 'not found'), and tabs.changed reaches them filtered the same way;
// nothing else of the 'system' topic does. 21.11.2026 (pane between people): a person's own space 'person:<id>' on this PC
// is their global pane (every panel), and a tab or agent's browser of this PC shared with them (pane/shares.ts) passes.
// Owns: these assertions only. Never: Electron, a real pane or a linked PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PaneTabs } from '../../../src/shared/api/methods-tabs.ts';
import type { HostOps } from '../../../src/shared/api/host-bridge.ts';
import { writeSideTabs, sideTabsFile } from '../../../src/runtime/root/side-tabs.ts';
import { announcePane } from '../../../src/runtime/devices/sync/tabs.ts';
import { addShare } from '../../../src/runtime/pane/shares.ts';
import { peopleRig, settle } from './rig.ts';

const code = (error: unknown) => (error as { code?: string }).code;

test('a person sees and works in the tabs of their chats\' areas, nothing else', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const navs: Array<HostOps['sideNav']['args']> = [];
  r.services.host = { ...r.services.host, sideView: {
    cast: async () => ({ ok: true as const, page: { url: 'https://shared.example/', title: 'Shared', back: false, forward: false, loading: false } }),
    input: async () => ({ ok: true as const }),
    nav: async (args: HostOps['sideNav']['args']) => { navs.push(args); return { ok: true as const }; },
  } } as never;
  const anna = await r.join('Anna Berg');
  const mine = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human', title: 'Mine' });
  const other = r.chats.create({ agentIds: ['ag_research'], createdBy: 'human', title: 'Not mine' });
  writeSideTabs(sideTabsFile(r.services.paths.data), {
    global: { tabs: [{ id: 'web-0000', url: 'https://owner.example/' }] },
    [`chat:${mine.id}`]: { shown: 'web-1111', tabs: [{ id: 'web-1111', url: 'https://shared.example/' }, { id: 'notes:x', panel: 'notes', conversationId: mine.id }] },
    [`chat:${other.id}`]: { tabs: [{ id: 'web-2222', url: 'https://other.example/' }] },
  });

  const pane = await anna.client.call<PaneTabs>('tabs.get');
  assert.deepEqual(Object.keys(pane.spaces), [`chat:${mine.id}`], 'only her chat\'s area');
  assert.deepEqual(pane.spaces[`chat:${mine.id}`].tabs.map((tab) => [tab.panel, tab.tab, tab.url]), [['remote', 'web-1111', 'https://shared.example/']], 'its websites only');

  await anna.client.call('side.nav', { tab: 'web-1111', action: 'reload' });
  assert.deepEqual(navs, [{ tab: 'web-1111', action: 'reload' }]);
  const pulled = await anna.client.call<{ state: { url: string } }>('side.pull', { tab: 'web-1111' });
  assert.equal(pulled.state.url, 'https://shared.example/');
  for (const tab of ['web-0000', 'web-2222']) {
    await assert.rejects(anna.client.call('side.nav', { tab, action: 'reload' }), (error: unknown) => code(error) === 'not_found' || /not shared/.test(String(error)), tab);
  }
  await assert.rejects(anna.client.call('side.pull', { tab: 'web-1111', device: 'dev_elsewhere' }), /not shared/);
  await assert.rejects(anna.client.call('tabs.set', { spaces: {} }));
  assert.equal(navs.length, 1, 'nothing ran for the others');

  await anna.client.call('events.subscribe', { topics: ['system'] });
  announcePane(r.services);
  r.services.settings.update({ profile: { name: 'Mara' } });
  await settle();
  const heard = anna.client.events('tabs.changed').map((event) => event.data as PaneTabs);
  assert.equal(heard.length, 1);
  assert.deepEqual(Object.keys(heard[0].spaces), [`chat:${mine.id}`]);
  assert.equal(anna.client.events('settings.updated').length, 0, 'nothing else of the system topic');
});

test("21.11.2026: an agent's own browser put in a chat's area is shared with its people – and only that agent's", async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const mine = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human', title: 'Mine' });
  const browser = { id: 'agent:ag_research', panel: 'agent', agentId: 'ag_research' };
  writeSideTabs(sideTabsFile(r.services.paths.data), {
    global: { tabs: [{ id: 'agent:ag_other', panel: 'agent', agentId: 'ag_other' }] },
    [`chat:${mine.id}`]: { shown: browser.id, tabs: [browser] },
  });
  const pane = await anna.client.call<PaneTabs>('tabs.get');
  assert.deepEqual(pane.spaces[`chat:${mine.id}`], { shown: browser.id, tabs: [browser] });
  // the rig runs no live view: any answer but "not shared" means the share let the call through to the browser
  await assert.rejects(anna.client.call('browser.takeover', { agentId: 'ag_research', on: true }), (error: unknown) => !/not shared/.test(String(error)));
  for (const agentId of ['ag_other', 'ag_nobody']) {
    await assert.rejects(anna.client.call('browser.takeover', { agentId, on: true }), /not shared with you/, agentId);
    await assert.rejects(anna.client.call('browser.pull', { agentId }), /not shared with you/, agentId);
  }
  await assert.rejects(anna.client.call('browser.navigate', { agentId: 'ag_research', window: 'show' }), /window/);
});

test("21.11.2026: a person's own space is their global pane, and what this PC shares with them passes", async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const navs: Array<HostOps['sideNav']['args']> = [];
  r.services.host = { ...r.services.host, sideView: {
    cast: async () => ({ ok: true as const, page: { url: 'https://p.example/', title: 'P', back: false, forward: false, loading: false } }),
    input: async () => ({ ok: true as const }),
    nav: async (args: HostOps['sideNav']['args']) => { navs.push(args); return { ok: true as const }; },
  } } as never;
  const anna = await r.join('Anna Berg');
  const bert = await r.join('Bert Kurz');
  const notes = { id: 'notes:a', panel: 'notes', conversationId: 'c_x' };
  writeSideTabs(sideTabsFile(r.services.paths.data), {
    global: { tabs: [{ id: 'web-0000', url: 'https://owner.example/' }, { id: 'web-3333', url: 'https://private.example/' }] },
    [`person:${anna.person.id}`]: { shown: 'notes:a', tabs: [{ id: 'web-4444', url: 'https://anna.example/' }, notes] },
    [`person:${bert.person.id}`]: { tabs: [{ id: 'web-5555', url: 'https://bert.example/' }] },
  });
  const pane = await anna.client.call<PaneTabs>('tabs.get');
  assert.deepEqual(Object.keys(pane.spaces), ['global'], 'her own space only, as her global pane');
  assert.deepEqual(pane.spaces.global.tabs.map((tab) => [tab.panel, tab.tab ?? tab.id]), [['remote', 'web-4444'], ['notes', 'notes:a']], 'every panel of it');
  assert.equal(pane.spaces.global.shown, 'notes:a');
  await anna.client.call('side.nav', { tab: 'web-4444', action: 'reload' });
  for (const tab of ['web-0000', 'web-3333', 'web-5555']) await assert.rejects(anna.client.call('side.nav', { tab, action: 'reload' }), /not shared/, tab);
  addShare({ db: r.db, clock: r.clock }, 'web-0000', [anna.person.id]);
  await anna.client.call('side.nav', { tab: 'web-0000', action: 'reload' });
  await assert.rejects(bert.client.call('side.nav', { tab: 'web-0000', action: 'reload' }), /not shared/, 'shared with Anna, not Bert');
  assert.deepEqual(navs.map((nav) => nav.tab), ['web-4444', 'web-0000']);

  await assert.rejects(anna.client.call('browser.takeover', { agentId: 'ag_research', on: true }), /not shared with you/);
  addShare({ db: r.db, clock: r.clock }, 'agent:ag_research', [anna.person.id]);
  await assert.rejects(anna.client.call('browser.takeover', { agentId: 'ag_research', on: true }), (error: unknown) => !/not shared/.test(String(error)), 'shared: it reaches the browser');
});
