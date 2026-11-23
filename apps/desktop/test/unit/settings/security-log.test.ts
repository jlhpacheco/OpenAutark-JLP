// Owns: Settings › Security's change log (runtime/settings/security-log.ts): who changed the security mode, a switch or a
// list (19.11.2026), sharing in the public library (17.11.2026) or a topic text, when, old → new – by an agent's wf, the
// person's window, a phone, and by no caller at all (settings.json); the caller counts only for what its own patch
// carries, and a change made while Autark was off is noticed at the start.
// Never: the page or the RPC server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../../../src/runtime/bus.ts';
import { actingAs, actorOf, noteSecurityChanges, readSecurityChanges, startSecurityLog, type LogKv } from '../../../src/runtime/settings/security-log.ts';
import { SECURITY_LOG_MAX, SECURITY_LOG_TEXT } from '../../../src/shared/model/security-log.ts';
import { securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { Settings } from '../../../src/shared/model/system.ts';

function memoryKv(store: Map<string, unknown>): LogKv {
  return { get: <T>(ns: string, key: string) => store.get(`${ns}/${key}`) as T | undefined, set: (ns, key, value) => { store.set(`${ns}/${key}`, value); } };
}

function world(store = new Map<string, unknown>(), security: Partial<SecuritySettings> = {}) {
  const kv = memoryKv(store);
  const bus = new Bus();
  let settings = { profile: { name: 'Stan' }, security: { ...securityDefaults('trust'), ...security } } as unknown as Settings;
  let clock = 1000;
  const change = (next: Partial<SecuritySettings>) => { settings = { ...settings, security: { ...settings.security!, ...next } } as Settings; bus.emit('settings.updated', settings); };
  const stop = startSecurityLog({ bus: bus as never, settings: { get: () => settings }, kv, now: () => (clock += 10) });
  return { kv, store, change, stop };
}
const lookup = { person: () => 'Stan', agent: (id: string) => (id === 'ag_1' ? 'Felix' : undefined) };
const STAN = { kind: 'person', name: 'Stan' } as const;

test('the person switching to Secure mode is written down with their name, time and both values', () => {
  const { kv, change } = world();
  const patch = { security: { mode: 'secure' as const } };
  actingAs(STAN, patch, () => change(patch.security));
  assert.deepEqual(readSecurityChanges(kv), [{ at: 1020, field: 'security.mode', by: STAN, from: 'trust', to: 'secure' }]);
});

test('the person is the window or main; the launch token alone names nobody; a phone and an unknown agent are named', () => {
  assert.deepEqual(actorOf({ kind: 'owner', person: true }, lookup), STAN);
  assert.deepEqual(actorOf({ kind: 'owner', main: true, person: true }, lookup), STAN);
  const token = actorOf({ kind: 'owner' }, lookup); // wf outside an agent's turn, a script, POST /rpc with the launch token
  assert.equal(token.kind, 'other');
  assert.match(token.name, /no agent named/);
  assert.deepEqual(actorOf({ kind: 'owner', person: true, agentId: 'ag_1' }, lookup), { kind: 'agent', id: 'ag_1', name: 'Felix' }, 'a named agent wins');
  assert.deepEqual(actorOf({ kind: 'device', deviceId: 'd1', capabilities: ['settings'], secure: true } as ClientScope, lookup), { kind: 'phone', id: 'd1', name: "Stan's phone" });
  assert.deepEqual(actorOf({ kind: 'owner', agentId: 'ag_x' }, lookup), { kind: 'agent', id: 'ag_x', name: 'An agent' });
});

test('a change with no caller is "other"; a list reads as its items', () => {
  const { kv, change } = world();
  change({ readFolders: ['C:\\Docs', 'D:\\Work'] });
  const [entry] = readSecurityChanges(kv);
  assert.deepEqual([entry?.field, entry?.by.kind, entry?.from, entry?.to], ['security.readFolders', 'other', '', 'C:\\Docs, D:\\Work']);
});

test('a caller is named only for what its own patch carries (an edit of settings.json taken over by the same update is not its change)', () => {
  const { kv, change } = world();
  actingAs(STAN, { security: { commands: 'ask' } }, () => change({ commands: 'ask', money: 'ask' }));
  const byField = new Map(readSecurityChanges(kv).map((entry) => [entry.field, entry.by.kind]));
  assert.deepEqual([byField.get('security.commands'), byField.get('security.money')], ['person', 'other']);
  actingAs(STAN, { voice: {} }, () => change({ commands: 'yes' }));
  assert.equal(readSecurityChanges(kv)[0]?.by.kind, 'other');
  actingAs(STAN, { security: null }, () => change({ commands: 'ask' }));
  assert.equal(readSecurityChanges(kv)[0]?.by.kind, 'person', 'a whole-section reset names the caller');
});

test('a save that changes nothing writes nothing; the log keeps SECURITY_LOG_MAX entries, newest first', () => {
  const { kv, change } = world();
  change({});
  assert.deepEqual(readSecurityChanges(kv), []);
  for (let i = 0; i < SECURITY_LOG_MAX + 5; i++) change({ computerApps: [`app${i}`] });
  const log = readSecurityChanges(kv);
  assert.equal(log.length, SECURITY_LOG_MAX);
  assert.equal(log[0]?.to, `app${SECURITY_LOG_MAX + 4}`);
  assert.equal(log[0]?.evictedTotal, 5);
  noteSecurityChanges(kv, [{ at: 3000, field: 'security/trust/money.md', by: STAN, from: 'old', to: 'new' }]);
  assert.equal(readSecurityChanges(kv)[0]?.evictedTotal, 6, 'topic and settings entries share the counter');
});

test('a topic text\'s change is added with noteSecurityChanges, cut like every value', () => {
  const store = new Map<string, unknown>();
  const kv = memoryKv(store);
  noteSecurityChanges(kv, [{ at: 5, field: 'security/trust/money.md', by: STAN, from: '(default) Money spent is gone.', to: 'y'.repeat(SECURITY_LOG_TEXT + 100) }]);
  noteSecurityChanges(kv, []);
  const [entry] = readSecurityChanges(kv);
  assert.equal(entry?.field, 'security/trust/money.md');
  assert.equal(entry?.to.length, SECURITY_LOG_TEXT + 1);
  assert.equal(entry?.toLength, SECURITY_LOG_TEXT + 100);
  assert.equal(entry?.fromLength, undefined);
});

test('a change made while Autark was not running gets its entry at the next start; a first start only remembers', () => {
  const first = world();
  assert.deepEqual(readSecurityChanges(first.kv), [], 'nothing known before: no entry');
  assert.equal((first.store.get('security/last') as Record<string, string>)['security.mode'], 'trust');
  first.change({ money: 'ask' });
  first.stop();
  const second = world(first.store, { money: 'ask', mode: 'secure' });
  const [entry, earlier] = readSecurityChanges(second.kv);
  assert.deepEqual([entry?.field, entry?.by.name, entry?.from, entry?.to], ['security.mode', 'While Autark was not running', 'trust', 'secure']);
  assert.equal(earlier?.field, 'security.money', 'the entry of the running time stays');
  second.stop();
  const third = world(first.store, { money: 'ask', mode: 'secure' });
  assert.equal(readSecurityChanges(third.kv).length, 2, 'the same values again: nothing new');
});

test('19.11.2026: values stored before the security section (pcAccess, forEveryAgent) write no entry; the new fields are remembered', () => {
  const store = new Map<string, unknown>([['security/last', { pcAccess: 'careful', forEveryAgent: 'No captchas.', libraryPublish: 'on' }]]);
  const first = world(store, { mode: 'secure' });
  assert.deepEqual(readSecurityChanges(first.kv), [], 'an update of the app is not a change of the setting');
  assert.equal((store.get('security/last') as Record<string, string>)['security.mode'], 'secure');
  first.stop();
});

test('a settings file without the section reads as Trust AI mode', () => {
  const store = new Map<string, unknown>();
  const kv = memoryKv(store);
  const bus = new Bus();
  let settings = { profile: { name: 'Stan' } } as unknown as Settings;
  startSecurityLog({ bus: bus as never, settings: { get: () => settings }, kv, now: () => 1 });
  settings = { ...settings, security: securityDefaults('secure') } as Settings;
  bus.emit('settings.updated', settings);
  assert.ok(readSecurityChanges(kv).some((entry) => entry.field === 'security.mode' && entry.from === 'trust' && entry.to === 'secure'));
});

test('17.11.2026: turning sharing in the public library off or on is written down, named for the patch that carries it', () => {
  const store = new Map<string, unknown>();
  const kv = memoryKv(store);
  const bus = new Bus();
  let settings = { profile: { name: 'Stan' } } as unknown as Settings; // no library section: sharing counts as on
  const set = (library: unknown) => { settings = { ...settings, library } as Settings; bus.emit('settings.updated', settings); };
  let clock = 0;
  startSecurityLog({ bus: bus as never, settings: { get: () => settings }, kv, now: () => (clock += 10) });
  actingAs(STAN, { library: { publish: false } }, () => set({ publish: false }));
  actingAs({ kind: 'agent', id: 'ag_1', name: 'Felix' }, { profile: { name: 'x' } }, () => set({ publish: true })); // its patch carries no library key
  actingAs(STAN, { library: null }, () => set({ publish: false })); // a whole-section reset names the caller too
  assert.deepEqual(readSecurityChanges(kv).map((entry) => [entry.field, entry.by.name, entry.from, entry.to]), [
    ['libraryPublish', 'Stan', 'on', 'off'],
    ['libraryPublish', 'settings.json or a linked PC', 'off', 'on'],
    ['libraryPublish', 'Stan', 'on', 'off'],
  ]);
});

test('a same-length edit beyond the retained prefix remains visibly incomplete', () => {
  const kv = memoryKv(new Map<string, unknown>());
  const prefix = 'a'.repeat(SECURITY_LOG_TEXT);
  noteSecurityChanges(kv, [{ at: 5, field: 'security/trust/money.md', by: STAN, from: prefix + 'x', to: prefix + 'y' }]);
  const [entry] = readSecurityChanges(kv);
  assert.equal(entry?.from, entry?.to);
  assert.equal(entry?.fromLength, SECURITY_LOG_TEXT + 1);
  assert.equal(entry?.toLength, SECURITY_LOG_TEXT + 1);
});
