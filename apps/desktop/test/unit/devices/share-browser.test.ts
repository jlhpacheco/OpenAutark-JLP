// An agent's browser sign-ins between the PCs it is at home on (devices/sync/share-browser.ts, the profile hooks of
// browser/sessions.ts): a closing profile's state is read through the browser, kept encrypted and sent to the other
// home PC, which puts it into the profile before the next page – on top of what that profile holds; the newer state
// wins by the time of use; an agent at home on one PC shares nothing; a PC that is no home is refused; a link-up
// sends what is owed; a leave sends the open profile's state; nothing of it reaches a log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../../../src/runtime/contracts.ts';
import type { ContextLike, StorageStateLike } from '../../../src/runtime/browser/page.ts';
import { BrowserSessions, profileHooks } from '../../../src/runtime/browser/sessions.ts';
import { mergeStates, putIn, removals, without } from '../../../src/runtime/devices/sync/share-state.ts';
import { SHARE_METHOD, shareNow } from '../../../src/runtime/devices/sync/share.ts';
import { agent } from '../chat/harness.ts';
import { MARA, cookie, profile, sessionOf, sharePc, tmp, until, type SharePc } from './share-rig.ts';
import { Net, link } from './sync-net.ts';

const SECRET = 'session-token-4711';
const state = (...cookies: Array<Record<string, unknown>>): StorageStateLike => ({ cookies, origins: [] });
const shareCalls = (net: Net) => net.calls.filter((call) => call.method === SHARE_METHOD && (call.params as { op: string }).op === 'browser');

async function pair(homes = ['B']): Promise<{ net: Net; a: SharePc; b: SharePc; logged: string[] }> {
  const net = new Net();
  const a = await sharePc(net, 'A', 'A', homes, false);
  const b = await sharePc(net, 'B', 'A', homes, false);
  link(a, b);
  const logged: string[] = [];
  const log = (...parts: unknown[]) => { logged.push(JSON.stringify(parts)); };
  for (const pc of [a, b]) (pc.h.services as { log: Logger }).log = { debug: log, info: log, warn: log, error: log };
  return { net, a, b, logged };
}

test('a state on top of another: a cookie or a site both hold is the newer one, what only the profile has stays', () => {
  const mine = { cookies: [cookie('sid', 'old'), cookie('only-here', 'x', 'b.example')], origins: [{ origin: 'https://a.example', localStorage: [{ name: 'k', value: 'old' }] }, { origin: 'https://b.example', localStorage: [] }] };
  const theirs = { cookies: [cookie('sid', 'new'), cookie('sid', 'other-site', 'c.example')], origins: [{ origin: 'https://a.example', localStorage: [{ name: 'k', value: 'new' }] }] };
  const merged = mergeStates(mine, theirs);
  assert.deepEqual(merged.cookies, [cookie('sid', 'new'), cookie('only-here', 'x', 'b.example'), cookie('sid', 'other-site', 'c.example')]);
  assert.deepEqual(merged.origins.map((origin) => origin.origin), ['https://a.example', 'https://b.example']);
  assert.deepEqual((merged.origins[0] as { localStorage: unknown }).localStorage, [{ name: 'k', value: 'new' }]);
});

test('my closing browser leaves its sign-ins for my other home PC, which puts them in before my next page there', async () => {
  const { net, a, b, logged } = await pair();
  const onA = profile(state(cookie('sid', SECRET)));
  const hooksA = a.share.browser.hooks();
  await hooksA.opened(sessionOf(onA, 1000));
  await hooksA.closing(sessionOf(onA, 5000));
  assert.equal(shareCalls(net).length, 1);
  assert.deepEqual([shareCalls(net)[0].from, shareCalls(net)[0].to], ['A', 'B']);
  const kept = await readFile(path.join(a.data, 'share', `browser-${MARA}.bin`), 'utf8');
  assert.ok(kept.startsWith('enc:') && !kept.includes(SECRET), 'kept with the keychain, never plain');
  const onB = profile(state(cookie('local', 'stays', 'b.example')));
  await b.share.browser.hooks().opened(sessionOf(onB, 0));
  assert.deepEqual(onB.state.cookies, [cookie('local', 'stays', 'b.example'), cookie('sid', SECRET)]);
  assert.equal(onB.sets, 1);
  await b.share.browser.hooks().opened(sessionOf(onB, 0));
  assert.equal(onB.sets, 1, 'put in once');
  assert.ok(!logged.some((line) => line.includes(SECRET)), 'no value in a log');
  assert.deepEqual(await readdir(path.join(b.data, 'share')), [`browser-${MARA}.bin`]);
});

test('the same state is not sent twice; a changed one is', async () => {
  const { net, a } = await pair();
  const onA = profile(state(cookie('sid', 'one')));
  const hooks = a.share.browser.hooks();
  await hooks.closing(sessionOf(onA, 1000));
  await hooks.closing(sessionOf(onA, 2000));
  assert.equal(shareCalls(net).length, 1);
  onA.state = state(cookie('sid', 'two'));
  await hooks.closing(sessionOf(onA, 3000));
  assert.equal(shareCalls(net).length, 2);
});

test('what I changed here since the last shared state stays when a state of my other PC comes; what I did not touch takes it, at once', async () => {
  const { a, b } = await pair();
  const onA = profile(state(cookie('sid', 'a1'), cookie('shop', 's1', 'shop.example')));
  const onB = profile(state());
  await a.share.browser.hooks().closing(sessionOf(onA, 1000));
  await b.share.browser.hooks().opened(sessionOf(onB, 0));
  assert.deepEqual(onB.state.cookies, [cookie('sid', 'a1'), cookie('shop', 's1', 'shop.example')]);
  onB.state.cookies[0] = cookie('sid', 'fresh sign-in on B');
  onA.state = state(cookie('sid', 'a2, refreshed in the background on A'), cookie('shop', 's2', 'shop.example'));
  await a.share.browser.hooks().closing(sessionOf(onA, 2000));
  await until(() => onB.sets === 2, 'the state put into the open profile');
  assert.deepEqual(onB.state.cookies, [cookie('sid', 'fresh sign-in on B'), cookie('shop', 's2', 'shop.example')]);
});

test('no clock of one PC is compared with another: a state is taken when it is later than the last one of that same PC', async () => {
  const { a, b } = await pair();
  const onB = profile(state());
  await b.share.browser.hooks().opened(sessionOf(onB, 9_000_000_000_000)); // B's clock is far ahead
  const onA = profile(state(cookie('sid', 'from A')));
  await a.share.browser.hooks().closing(sessionOf(onA, 5000));
  await until(() => onB.sets === 1, 'the state of A in the profile on B');
  assert.deepEqual(onB.state.cookies, [cookie('sid', 'from A')]);
  const piece = (at: number, text: string) => ({ op: 'browser', agentId: MARA, at, id: `id-${at}`, offset: 0, total: Buffer.byteLength(text), data: Buffer.from(text).toString('base64') });
  assert.deepEqual(await b.share.receive(piece(5000, JSON.stringify(state(cookie('sid', 'again')))), 'A'), { ok: true, taken: false }, 'not later than the last of A');
  assert.deepEqual(await b.share.receive(piece(4000, JSON.stringify(state(cookie('sid', 'older')))), 'A'), { ok: true, taken: false });
  assert.deepEqual(onB.state.cookies, [cookie('sid', 'from A')]);
});

test('a state that cannot be put in never keeps this PC from sending its own, and goes after three tries', async () => {
  const { net, a, b } = await pair();
  await a.share.browser.hooks().closing(sessionOf(profile(state(cookie('sid', 'from A'))), 1000));
  const onB = profile(state(cookie('own', 'signed in on B', 'b.example')));
  (onB as { setStorageState: unknown }).setStorageState = async () => { throw new Error(`refused ${SECRET}`); };
  const hooks = b.share.browser.hooks();
  await hooks.opened(sessionOf(onB, 100));
  await hooks.closing(sessionOf(onB, 200));
  assert.deepEqual(shareCalls(net).map((call) => `${call.from}>${call.to}`), ['A>B', 'B>A'], 'B shared its own state');
  const onA = profile(state(cookie('sid', 'from A')));
  await a.share.browser.hooks().opened(sessionOf(onA, 0));
  assert.deepEqual(onA.state.cookies, [cookie('sid', 'from A'), cookie('own', 'signed in on B', 'b.example')]);
  assert.ok((await readdir(path.join(b.data, 'share'))).includes(`browser-${MARA}.in.bin`), 'it still waits');
  await hooks.opened(sessionOf(onB, 300));
  await hooks.opened(sessionOf(onB, 400));
  assert.deepEqual(await readdir(path.join(b.data, 'share')), [`browser-${MARA}.bin`], 'dropped after the third try');
});

test('two sends of one state at the same time both arrive whole', async () => {
  const { b } = await pair();
  const text = JSON.stringify(state(cookie('sid', 'x')));
  const bytes = Buffer.from(text);
  const piece = (id: string, at: number, from: number, to: number) => ({ op: 'browser', agentId: MARA, at, id, offset: from, total: bytes.length, data: bytes.subarray(from, to).toString('base64') });
  assert.deepEqual(await b.share.receive(piece('one', 10, 0, 5), 'A'), { ok: true });
  assert.deepEqual(await b.share.receive(piece('two', 11, 0, 7), 'A'), { ok: true });
  assert.deepEqual(await b.share.receive(piece('one', 10, 5, bytes.length), 'A'), { ok: true, taken: true });
  assert.deepEqual(await b.share.receive(piece('two', 11, 7, bytes.length), 'A'), { ok: true, taken: true });
});

test('what came from my other PC goes back with my next state here, and my use after it is the newer one', async () => {
  const { net, a, b } = await pair();
  await a.share.browser.hooks().closing(sessionOf(profile(state(cookie('sid', 'from A'))), 50_000));
  const onB = profile(state());
  const hooksB = b.share.browser.hooks();
  await hooksB.opened(sessionOf(onB, 100)); // B's clock is behind
  onB.state.cookies.push(cookie('second', 'signed in on B'));
  await hooksB.closing(sessionOf(onB, 200));
  const onA = profile(state(cookie('sid', 'from A')));
  await a.share.browser.hooks().opened(sessionOf(onA, 0));
  assert.deepEqual(onA.state.cookies, [cookie('sid', 'from A'), cookie('second', 'signed in on B')]);
  assert.deepEqual(shareCalls(net).map((call) => `${call.from}>${call.to}`), ['A>B', 'B>A']);
});

test('at home on one PC: nothing is read, kept or sent', async () => {
  const { net, a } = await pair([]);
  const onA = profile(state(cookie('sid', SECRET)));
  await a.share.browser.hooks().closing(sessionOf(onA, 1000));
  assert.equal(onA.reads, 0);
  assert.equal(shareCalls(net).length, 0);
  assert.deepEqual(await readdir(a.data), []);
});

test('a link-up sends the state the other home PC has not got; homes cleared: what was kept goes', async () => {
  const { net, a, b } = await pair();
  net.up = false;
  await a.share.browser.hooks().closing(sessionOf(profile(state(cookie('sid', 'kept while B was off'))), 1000));
  assert.equal(shareCalls(net).length, 0);
  net.up = true;
  await a.share.catchUp('B');
  await a.share.catchUp('B');
  assert.equal(shareCalls(net).length, 1, 'once');
  const onB = profile(state());
  await b.share.browser.hooks().opened(sessionOf(onB, 0));
  assert.deepEqual(onB.state.cookies, [cookie('sid', 'kept while B was off')]);
  a.h.org.add(agent(MARA, 'Mara', { deviceId: 'A' }));
  a.share.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await readdir(path.join(a.data, 'share')), []);
  assert.deepEqual(a.share.browser.agents(), []);
});

test('a leave sends the open browser\'s state now', async () => {
  const { net, a, b } = await pair();
  const onA = profile(state(cookie('sid', 'mid-work')));
  await a.share.browser.hooks().opened(sessionOf(onA, 1000));
  await shareNow(a.h.services, MARA);
  assert.equal(shareCalls(net).length, 1);
  const onB = profile(state());
  await b.share.browser.hooks().opened(sessionOf(onB, 0));
  assert.deepEqual(onB.state.cookies, [cookie('sid', 'mid-work')]);
});

test('a state comes only from one of my home PCs, whole and in order', async () => {
  const net = new Net();
  const a = await sharePc(net, 'A', 'A', ['B'], false);
  const b = await sharePc(net, 'B', 'A', ['B'], false);
  const c = await sharePc(net, 'C', 'A', ['B'], false);
  link(a, b); link(a, c); link(b, c);
  const piece = { op: 'browser', agentId: MARA, at: 1, id: 'x', offset: 0, total: 2, data: Buffer.from('{}').toString('base64') };
  await assert.rejects(() => b.share.receive(piece, 'C'), /at home on/);
  await assert.rejects(() => b.share.receive(piece, 'X'), /my own PCs/);
  await assert.rejects(() => b.share.receive(piece, 'A'), /no browser state/);
  const bad = JSON.stringify({ cookies: [{ name: 1 }], origins: [] });
  await assert.rejects(() => b.share.receive({ ...piece, id: 'y', total: Buffer.byteLength(bad), data: Buffer.from(bad).toString('base64') }, 'A'), /no browser state/, 'a malformed entry');
  await assert.rejects(() => b.share.receive({ ...piece, offset: 5 }, 'A'), /out of order/);
  await assert.rejects(() => b.share.receive({ ...piece, agentId: '../x' }, 'A'), /at home on/);
  await a.share.browser.hooks().closing(sessionOf(profile(state(cookie('sid', 'x'))), 1000));
  assert.ok(net.calls.every((call) => call.to !== 'C'), 'nothing to a PC that is no home');
});

test('the browser tells a profile\'s opening before its first page and its closing before the window goes', async () => {
  const data = await tmp('share-hooks-');
  const paths = { data, workspace: data };
  const order: string[] = [];
  const context = { ...profile(state()), close: async () => { order.push('context closed'); } } as unknown as ContextLike;
  profileHooks.set(paths, {
    opened: async (session) => { order.push(`opened ${session.agentId} at ${typeof session.usedAt}`); },
    closing: async (session) => { order.push(`closing ${session.agentId}`); throw new Error('a failing hook never keeps a browser open'); },
  });
  const sessions = new BrowserSessions({ paths, log: { debug() {}, info() {}, warn() {}, error() {} }, launcher: async () => { order.push('launched'); return context; }, channel: () => 'chrome', closed: () => order.push('dropped') });
  const session = await sessions.session('ag_1');
  order.push('session handed out');
  assert.ok(Date.now() - session.usedAt < 5000);
  await sessions.close('ag_1');
  assert.deepEqual(order, ['launched', 'opened ag_1 at number', 'session handed out', 'closing ag_1', 'dropped', 'context closed']);
});

// ---- round 2: a sign-out travels, and never comes back

const site = (origin: string, ...items: Array<[string, string]>) => ({ origin, localStorage: items.map(([name, value]) => ({ name, value })) });

test('what went since the last shared state is a removal – a cookie, and a storage key of a site that was open; it is carried on until it is there again', () => {
  const shared = { cookies: [cookie('sid', 'v1'), cookie('keep', 'k')], origins: [site('https://a.example', ['token', 't1'], ['theme', 'dark']), site('https://closed.example', ['token', 'c1'])] };
  const now = { cookies: [cookie('keep', 'k')], origins: [site('https://a.example', ['theme', 'dark'])] };
  const first = removals(shared, now);
  assert.deepEqual(first.cookies.map((entry) => entry.k), ['sid\nexample.com\n/']);
  assert.deepEqual(first.keys.map((entry) => `${entry.o} ${entry.n}`), ['https://a.example token'], 'a site that was not open says nothing about its keys');
  assert.ok(!JSON.stringify(first).includes('v1') && !JSON.stringify(first).includes('t1'), 'a removal names no value');
  assert.deepEqual(removals({ ...now, removed: first }, now), first, 'carried on with the next state');
  const back = removals({ ...now, removed: first }, { cookies: [cookie('keep', 'k'), cookie('sid', 'v2')], origins: [site('https://a.example', ['token', 't2'])] });
  assert.deepEqual(back.cookies, [], 'signed in again: no removal any more');
  assert.deepEqual(back.keys.map((entry) => entry.n), ['theme']);
  assert.deepEqual(removals(undefined, now), { cookies: [], keys: [] });
  const mine = { cookies: [cookie('sid', 'v1'), cookie('other', 'x')], origins: [site('https://a.example', ['token', 't1'], ['own', 'o'])] };
  assert.deepEqual(without(mine, first), { cookies: [cookie('other', 'x')], origins: [site('https://a.example', ['own', 'o'])] });
  const later = { cookies: [cookie('sid', 'set here later')], origins: [site('https://a.example', ['token', 'set here later'])] };
  assert.deepEqual(without(later, first), later, 'a copy with another value was set here later: it stays');
  assert.deepEqual(without(mine, { cookies: 'x', keys: [{ o: 1 }] } as never), mine, 'a malformed list removes nothing');
});

test('a sign-in only on A stays on B; a sign-out on A removes it on B; a cookie B set itself after the last share stays', async () => {
  const { a, b } = await pair();
  const onA = profile(state(cookie('sid', 'signed in on A'), cookie('shop', 'cart-1', 'shop.example')));
  const onB = profile(state());
  const [hooksA, hooksB] = [a.share.browser.hooks(), b.share.browser.hooks()];
  await hooksA.closing(sessionOf(onA, 1000));
  await hooksB.opened(sessionOf(onB, 0));
  assert.deepEqual(onB.state.cookies, [cookie('sid', 'signed in on A'), cookie('shop', 'cart-1', 'shop.example')], 'the sign-in of A is on B');
  onB.state.cookies = [cookie('sid', 'signed in on A'), cookie('shop', 'cart-2 set on B', 'shop.example'), cookie('own', 'only B', 'b.example')];
  // A signs out of both sites; B has not shared since
  onA.state = state();
  await hooksA.closing(sessionOf(onA, 2000));
  await until(() => onB.sets === 2, 'the sign-out on B');
  assert.deepEqual(onB.state.cookies, [cookie('shop', 'cart-2 set on B', 'shop.example'), cookie('own', 'only B', 'b.example')],
    'the sign-out came; what B set itself after the last share stays, and what only B has stays');
  // B's next state does not bring the sign-in back to A
  await hooksB.closing(sessionOf(onB, 500));
  await hooksA.opened(sessionOf(onA, 0));
  assert.deepEqual(onA.state.cookies, [cookie('shop', 'cart-2 set on B', 'shop.example'), cookie('own', 'only B', 'b.example')]);
  assert.ok(!onA.state.cookies.some((entry) => entry.name === 'sid'), 'the sign-out did not come back');
});

test('a home PC that was off for several states still hears the sign-out', async () => {
  const net = new Net();
  const homes = ['B', 'C'];
  const a = await sharePc(net, 'A', 'A', homes, false);
  const b = await sharePc(net, 'B', 'A', homes, false);
  const c = await sharePc(net, 'C', 'A', homes, false);
  link(a, b); link(a, c); link(b, c);
  const onA = profile(state(cookie('sid', 'x'), cookie('a', '1')));
  const hooks = a.share.browser.hooks();
  await hooks.closing(sessionOf(onA, 1000));
  const onC = profile(state());
  await c.share.browser.hooks().opened(sessionOf(onC, 0));
  await c.share.browser.hooks().closing(sessionOf(onC, 0));
  assert.equal(onC.state.cookies.length, 2);
  net.pcs.delete('C'); // C goes off
  onA.state = state(cookie('a', '1'));
  await hooks.closing(sessionOf(onA, 2000)); // the sign-out
  onA.state = state(cookie('a', '2'));
  await hooks.closing(sessionOf(onA, 3000)); // one more state after it
  net.pcs.set('C', c);
  await a.share.catchUp('C');
  await c.share.browser.hooks().opened(sessionOf(onC, 0));
  assert.deepEqual(onC.state.cookies, [cookie('a', '2')]);
});

test('with a base, only what is unchanged here takes the incoming state; a sign-out here does not come back; partitioned cookies stay apart', () => {
  const site = (origin: string, ...items: Array<[string, string]>) => ({ origin, localStorage: items.map(([name, value]) => ({ name, value })) });
  const base = { cookies: [cookie('a', '1'), cookie('b', '1')], origins: [site('https://s.example', ['k', '1']), site('https://t.example', ['k', '1'])], removed: { cookies: [{ k: 'gone\nexample.com\n/', h: '' }], keys: [] } };
  const mine = { cookies: [cookie('a', '1'), cookie('b', 'changed here')], origins: [site('https://s.example', ['k', '1']), site('https://t.example', ['k', 'changed here'])] };
  const incoming = { cookies: [cookie('a', '2'), cookie('b', '2'), cookie('new', 'n')], origins: [site('https://s.example', ['k', '2']), site('https://t.example', ['k', '2']), site('https://closed.example', ['k', '2'])] };
  const out = putIn(mine, incoming, base);
  assert.deepEqual(out.cookies, [cookie('a', '2'), cookie('b', 'changed here'), cookie('new', 'n')]);
  assert.deepEqual(out.origins, [site('https://s.example', ['k', '2']), site('https://t.example', ['k', 'changed here']), site('https://closed.example', ['k', '2'])]);
  assert.deepEqual(putIn(mine, incoming).cookies, [cookie('a', '2'), cookie('b', '2'), cookie('new', 'n')], 'no base yet: the incoming state goes on top');
  const signedOut = removals({ cookies: [cookie('sid', 'v1')], origins: [] }, { cookies: [], origins: [] });
  assert.deepEqual(putIn({ cookies: [], origins: [] }, { cookies: [cookie('sid', 'v1')], origins: [] }, { cookies: [], origins: [], removed: signedOut }).cookies, [], 'the value I signed out of');
  assert.deepEqual(putIn({ cookies: [], origins: [] }, { cookies: [cookie('sid', 'v2')], origins: [] }, { cookies: [], origins: [], removed: signedOut }).cookies, [cookie('sid', 'v2')], 'a new sign-in there');
  const parted = (top: string) => ({ ...cookie('p', top, 'cdn.example'), partitionKey: top });
  assert.equal(mergeStates({ cookies: [parted('https://one.example')], origins: [] }, { cookies: [parted('https://two.example')], origins: [] }).cookies.length, 2);
});
