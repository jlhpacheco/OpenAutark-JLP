// W2-PH (owner 11.11.2026: "dass man manche Einstellungen nicht machen kann und die am PC machen muss, das geht überhaupt
// nicht"; 16.11.2026 build): the owner's paired phone on a secure transport reaches every Settings page. Each method opened
// for it has its rule, is allowed for that phone, refused over plain LAN http, without its capability, for an employee's
// phone (person scope), an external agent, a linked PC and an agent. Every RPC method the Settings pages name is allowed
// for the phone except what opens a window on the PC's own screen. side.open puts a page into the PC's pane (a sign-in
// that returns to the PC's own address); a managing phone gets an app's sign-in page, adds a command server and removes a
// mailbox, while a Settings-only device keeps the old refusals (connected-apps.test.ts).
// Owns: these assertions only. Never: a window, a socket or a real PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { PANE_MISSING } from '../../../src/runtime/rpc/handlers/side-view.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { scopeDenial, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { mayReceive } from '../../../src/runtime/rpc/scopes.ts';
import { FULL_ACCESS } from '../../../src/runtime/pwa/tokens.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { SideBrowserCall } from '../../../src/shared/model/side-browser.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');
const table = createHandlerTable();

const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_phone0000001', capabilities: [...FULL_ACCESS], secure: true };
const LAN: ClientScope = { ...PHONE, secure: false };
const PERSON = { kind: 'person', personId: 'per_anna000000', deviceId: 'dev_anna00000001', tokenId: 'tok_1', secure: true } as unknown as ClientScope;
const EXTERNAL = { kind: 'external', memberId: 'ext:api:key:x', conversationId: 'ch_x', tokenId: 'tok_x' } as unknown as ClientScope;
const PEER: ClientScope = { kind: 'peer', deviceId: 'dev_pc2' };
const AGENT = { kind: 'agent', agentId: 'ag_x', runId: 'run_x' } as unknown as ClientScope;
/** Typed here, outside the loops: an array literal of these union consts inside a loop with assert calls is circular (TS7022). */
const OTHERS: readonly ClientScope[] = [EXTERNAL, PEER, AGENT];
const without = (capability: DeviceCapability): ClientScope => ({ ...PHONE, capabilities: FULL_ACCESS.filter((held) => held !== capability) });

const SETTINGS = { capability: 'settings', secure: true };
const MANAGE = { capability: 'manage', secure: true };
const PERMISSIONS = { capability: 'permissions', secure: true };

/** Every method this package opened for the owner's phone, with its rule. */
const OPENED: Record<string, typeof SETTINGS> = {
  // Settings › Calendar
  'calendar.addIcs': SETTINGS, 'calendar.updateSource': SETTINGS, 'calendar.removeSource': SETTINGS, 'calendar.sync': SETTINGS,
  'calendar.google': SETTINGS, 'calendar.connectGoogle': SETTINGS,
  // Settings › About (backup, restore, restart, data folder, chat export)
  'system.backup': SETTINGS, 'system.restore': SETTINGS, 'system.restoreStatus': SETTINGS, 'system.restartRuntime': SETTINGS,
  'system.root': MANAGE, 'chats.export': MANAGE,
  // Settings › Models (a Claude Code account's stored sessions)
  'privacy.providerHistories': SETTINGS, 'privacy.purgeProviderHistory': SETTINGS,
  // Settings › Feedback › Inbox
  'feedback.inboxList': SETTINGS, 'feedback.inboxFetch': SETTINGS, 'feedback.inboxRemove': SETTINGS, 'feedback.inboxMark': SETTINGS,
  'feedback.inboxImage': SETTINGS,
  // Settings › Skills & memory
  'skills.delete': MANAGE, 'modes.save': MANAGE, 'modes.delete': MANAGE,
  // Settings › Secrets
  'secrets.export': PERMISSIONS,
  // a sign-in page in the PC's pane (Calendar's Google, an app's OAuth)
  'side.open': MANAGE,
};
/** People of the organisation keep their own variants of these (their own calendars, people/rpc-calendar.ts). */
const PERSON_VARIANTS = new Set(['calendar.addIcs', 'calendar.removeSource']);
/** What opens a window on the PC's own screen stays with the PC (the phone opens the same file in its pane, files.readPath). */
const PC_SCREEN = ['files.open', 'files.openPath', 'secrets.openFolder', 'modes.openFolder', 'agents.openHome', 'system.install', 'computer.preview'];
/** Methods the Settings pages name that stay off the phone, and why (each one's page says what happens instead). */
const PAGE_EXCEPTIONS: Record<string, string> = {
  'files.openPath': "the PC's file manager; on the phone the same folder opens in the pane (open-file.ts openPathHere)",
  // Settings › General › Companies (CompaniesGroup.tsx, desktop window only): each company is its own runtime and window
  // on the PC, export and import go through the PC's folder picker, and removal through main (host op company.remove).
  'companies.list': 'the companies of the PC (desktop window only)',
  'companies.export': "into a folder chosen with the PC's folder picker",
  'companies.import': "from a folder chosen with the PC's folder picker",
  'companies.remove': "main stops the company's window and moves its folder",
};

const base = (rule: unknown): unknown => (rule && typeof rule === 'object' && 'person' in rule ? (rule as unknown as { base: unknown }).base : rule);

test('each opened method: its rule, the owner\'s secure phone may, plain LAN http, a missing capability and every other kind may not', () => {
  for (const [method, expected] of Object.entries(OPENED)) {
    const rule = table.get(method)?.scope;
    assert.ok(rule, `${method} is registered`);
    assert.deepEqual(base(rule), expected, method);
    assert.equal(scopeDenial(rule!, { kind: 'owner' }), undefined, `${method}: the owner`);
    assert.equal(scopeDenial(rule!, PHONE), undefined, `${method}: the owner's phone on its secure tunnel`);
    assert.equal(scopeDenial(rule!, LAN), 'insecure', `${method}: never over plain LAN http`);
    assert.equal(scopeDenial(rule!, without(expected.capability as DeviceCapability)), 'scope', `${method}: needs ${expected.capability}`);
    if (!PERSON_VARIANTS.has(method)) assert.equal(scopeDenial(rule!, PERSON), 'scope', `${method}: an employee's phone stays refused`);
    for (const other of OTHERS) assert.equal(scopeDenial(rule!, other), 'scope', `${method}: ${other.kind}`);
  }
});

test("an employee's phone: none of the opened methods but its own calendars' variants; session.info says the same", () => {
  const allowed = (scope: ClientScope): string[] => sessionInfo(table, scope).allowedMethods;
  const person = allowed(PERSON);
  for (const method of Object.keys(OPENED)) assert.equal(person.includes(method), PERSON_VARIANTS.has(method), method);
  const phone = allowed(PHONE);
  for (const method of Object.keys(OPENED)) assert.ok(phone.includes(method), method);
  const lan = allowed(LAN);
  for (const method of Object.keys(OPENED)) assert.ok(!lan.includes(method), `${method} not over LAN`);
});

test("what opens a window on the PC's own screen stays with the PC", () => {
  for (const method of PC_SCREEN) {
    assert.equal(base(table.get(method)?.scope), 'owner', method);
    assert.equal(scopeDenial(table.get(method)!.scope, PHONE), 'scope', method);
  }
});

/** Every quoted method name in the Settings pages' sources (and the feedback inbox they open). */
function pageMethods(): Map<string, string[]> {
  const known = new Set(table.methods());
  const dir = path.join(SRC, 'ui/settings');
  const files = [...readdirSync(dir).filter((name) => /\.tsx?$/.test(name)).map((name) => path.join(dir, name)), path.join(SRC, 'ui/feedback/FeedbackInbox.tsx')];
  const found = new Map<string, string[]>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/'([a-zA-Z]+\.[a-zA-Z]+)'/g)) {
      if (known.has(match[1])) found.set(match[1], [...new Set([...(found.get(match[1]) ?? []), path.basename(file)])]);
    }
  }
  return found;
}

test('every RPC method the Settings pages call is allowed for the owner\'s phone, but the PC-screen ones', () => {
  const methods = pageMethods();
  assert.ok(methods.size > 60, `the scan found the pages' methods (${methods.size})`);
  const refused = [...methods].filter(([method]) => scopeDenial(table.get(method)!.scope, PHONE) !== undefined && !(method in PAGE_EXCEPTIONS));
  assert.deepEqual(refused, [], 'a page method the phone may not call');
  for (const method of Object.keys(PAGE_EXCEPTIONS)) assert.notEqual(scopeDenial(table.get(method)!.scope, PHONE), undefined, `${method} is still an exception`);
});

test('calendar source changes reach the secure settings phone (its Calendar page reloads), not LAN, not an employee', () => {
  const data = { ownerId: 'human' };
  assert.ok(mayReceive(PHONE, 'system', 'calendar.sources', data));
  assert.ok(!mayReceive(LAN, 'system', 'calendar.sources', data));
  assert.ok(!mayReceive(without('settings'), 'system', 'calendar.sources', data));
  assert.ok(!mayReceive(PERSON, 'system', 'calendar.sources', data));
});

function ctxFor(scope: ClientScope, services: Record<string, unknown>): HandlerContext {
  return { scope, services, extras: {}, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) } as unknown as HandlerContext;
}

test('side.open: a new tab of the PC\'s global pane, shown at once, opened by the person; no pane says so; addresses are checked', async () => {
  const entry = table.get('side.open')!;
  const calls: SideBrowserCall[] = [];
  const host = { sideBrowser: async (call: SideBrowserCall) => { calls.push(call); return { ok: true, tab: 'web-1', text: 'the page look stays on the PC' }; } };
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s1&code_challenge=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2F';
  assert.deepEqual(await entry.handler({ url } as never, ctxFor(PHONE, { host })), { ok: true, tab: 'web-1' });
  assert.deepEqual(calls, [{ action: 'open', url, newTab: true, show: true, space: 'global', agent: { id: 'human', name: 'You' } }], 'the whole address, with its state');
  await assert.rejects(Promise.resolve().then(() => entry.handler({ url: 'file:///C:/x' } as never, ctxFor(PHONE, { host }))), (error: Error & { code?: string }) => error.code === 'bad_request');
  await assert.rejects(Promise.resolve().then(() => entry.handler({ url, extra: 1 } as never, ctxFor(PHONE, { host }))), (error: Error & { code?: string }) => error.code === 'bad_request');
  await assert.rejects(Promise.resolve().then(() => entry.handler({ url } as never, ctxFor(PHONE, { host: {} }))), (error: Error) => error.message === PANE_MISSING);
  const full = { sideBrowser: async () => ({ ok: false, error: 'Close a browser tab before opening another.' }) };
  await assert.rejects(Promise.resolve().then(() => entry.handler({ url } as never, ctxFor(PHONE, { host: full }))), /Close a browser tab/);
  assert.equal(calls.length, 1, 'nothing else reached the PC');
});

test('Apps: a managing phone gets the sign-in page, adds a command server and removes a mailbox; a Settings-only device does not', async () => {
  const mutations: Array<Record<string, unknown>> = [];
  const apps = {
    list: () => [{ id: 'app-a', signInUrl: 'https://auth.example.test/continue' }],
    validateAdd: () => undefined,
    mutate: (mutation: Record<string, unknown>) => { mutations.push(mutation); },
    reconnect: async () => ({ id: 'app-a', signInUrl: 'https://auth.example.test/continue' }),
  };
  const run = (method: string, params: unknown, scope: ClientScope) => Promise.resolve().then(() => {
    const entry = table.get(method)!;
    if (scopeDenial(entry.scope, scope)) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    return entry.handler(params as never, ctxFor(scope, { apps }));
  });
  const listed = await run('apps.list', undefined, PHONE) as Array<{ signInUrl?: string }>;
  assert.equal(listed[0].signInUrl, 'https://auth.example.test/continue', 'the phone opens it in the PC\'s pane');
  const commands = { entries: [{ name: 'local', entry: { command: 'node', args: ['server.js'] } }] };
  await run('apps.validateAdd', commands, PHONE);
  await run('apps.add', commands, PHONE);
  await run('apps.remove', { id: 'mail', name: 'Mailbox', transport: 'mail' }, PHONE);
  assert.deepEqual(mutations.map((mutation) => [mutation.kind, mutation.allowMailRemoval ?? null]), [['add', null], ['remove', true]]);
  const settingsOnly: ClientScope = { ...PHONE, capabilities: ['settings'] };
  assert.equal((await run('apps.list', undefined, settingsOnly) as Array<{ signInUrl?: string }>)[0].signInUrl, undefined);
  await assert.rejects(run('apps.add', commands, settingsOnly), (error: Error & { code?: string }) => error.code === 'forbidden');
  await assert.rejects(run('apps.remove', { id: 'mail', name: 'Mailbox', transport: 'mail' }, settingsOnly), (error: Error & { code?: string }) => error.code === 'conflict');
  await assert.rejects(run('apps.list', undefined, PERSON), /forbidden/);
  assert.equal(mutations.length, 2, 'nothing more was changed');
});
