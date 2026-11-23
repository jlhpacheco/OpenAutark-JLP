// The security decision (Sicher-Runde 19.11.2026, runtime/security/policy.ts): the table of open / ask / closed per
// mode and switch, the company's own folders, Autark's setup and security folder, the place an answer adds, the helper's
// guard and the vault's card refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { effective, securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import { decide, fingerprintOf, guardConfig, opened, placeOf, vaultRefusal, type Places } from '../../../src/runtime/security/policy.ts';
import { needsOf } from '../../../src/runtime/security/tool-gate.ts';

const root = path.resolve('policy-root');
const places: Places = {
  data: path.join(root, 'data'), workspace: path.join(root, 'Workforce'), resources: path.join(root, 'res'), temp: [path.join(root, 'data', 'tmp'), path.join(root, 'ostmp')], ownApp: 'autark',
};
const secure = (patch: Partial<SecuritySettings> = {}): SecuritySettings => ({ ...securityDefaults('secure'), ...patch });
const trust = (patch: Partial<SecuritySettings> = {}): SecuritySettings => effective({ ...securityDefaults('trust'), ...patch });
const verdict = (settings: SecuritySettings, input: Parameters<typeof decide>[2]) => decide(settings, places, input).verdict;
const outside = path.join(root, 'elsewhere', 'taxes.pdf');

test('Trust AI mode: everything open except its three switches set to ask; nothing is closed', () => {
  const open = trust();
  for (const capability of ['read', 'write', 'commands', 'web', 'computer', 'phone', 'message', 'publish', 'accounts', 'setup', 'team', 'money'] as const) {
    assert.equal(verdict(open, { agentId: 'ag_a', capability, path: capability === 'write' ? outside : undefined }), 'open', capability);
  }
  const asking = trust({ money: 'ask', publish: 'ask', message: 'ask', commands: 'ask', read: 'chosen' });
  assert.equal(verdict(asking, { agentId: 'ag_a', capability: 'money' }), 'ask');
  assert.equal(verdict(asking, { agentId: 'ag_a', capability: 'publish' }), 'ask');
  assert.equal(verdict(asking, { agentId: 'ag_a', capability: 'message' }), 'ask');
  assert.equal(verdict(asking, { agentId: 'ag_a', capability: 'commands' }), 'open', 'Trust mode reads only money, publish, message');
  assert.equal(verdict(asking, { agentId: 'ag_a', capability: 'read', path: outside }), 'open');
  assert.equal(verdict(trust(), { agentId: 'ag_a', capability: 'write', path: path.join(places.data, 'security', 'trust', 'general.md') }), 'open', 'agents may edit agreements in Trust mode');
});

test('Secure mode defaults: own folders open, elsewhere ask; commands, apps, phone, messages, posts, accounts, setup ask; team and web open', () => {
  const s = secure();
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'read', path: path.join(places.workspace, 'notes.md') }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'read', path: 'relative/inside.md' }), 'open', 'relative counts from the workspace');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'read', path: path.join(places.resources, 'skills', 'x.md') }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'read', path: path.join(places.data, 'settings.json') }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'read', path: outside }), 'ask');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'write', path: path.join(places.workspace, 'a.ts') }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'write', path: path.join(root, 'ostmp', 'x') }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'write', path: outside }), 'ask');
  for (const capability of ['commands', 'computer', 'phone', 'message', 'publish', 'accounts', 'setup'] as const) assert.equal(verdict(s, { agentId: 'ag_a', capability }), 'ask', capability);
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'team' }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'web' }), 'open');
});

test('Secure mode hard closes: money whatever it says, <data>/security, Autark\'s own window', () => {
  const s = secure({ money: 'yes', setup: 'yes', computer: 'yes' });
  assert.deepEqual(decide(s, places, { agentId: 'ag_a', capability: 'money' }), { verdict: 'closed', capability: 'money', why: 'money' });
  assert.deepEqual(decide(s, places, { agentId: 'ag_a', capability: 'write', path: path.join(places.data, 'security', 'secure', 'money.md') }), { verdict: 'closed', capability: 'setup', why: 'security' });
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'read', path: path.join(places.data, 'security', 'secure', 'money.md') }), 'open', 'reading the agreements is fine');
  assert.deepEqual(decide(s, places, { agentId: 'ag_a', capability: 'computer', app: 'Autark.exe' }), { verdict: 'closed', capability: 'computer', why: 'own-window' });
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'computer', app: 'excel' }), 'open');
});

test('Secure mode: writes into Autark\'s setup are the setup switch; the agent\'s own home and memory stay open', () => {
  const s = secure({ write: 'all' });
  assert.deepEqual(decide(s, places, { agentId: 'ag_a', capability: 'write', path: path.join(places.data, 'settings.json') }), { verdict: 'ask', capability: 'setup' });
  assert.deepEqual(decide(s, places, { agentId: 'ag_a', capability: 'write', path: path.join(places.data, 'agents', 'ag_b', 'SYSTEM.md') }), { verdict: 'ask', capability: 'setup' });
  assert.deepEqual(decide(s, places, { agentId: 'ag_a', capability: 'write', path: path.join(places.workspace, 'skills', 'x', 'SKILL.md') }), { verdict: 'ask', capability: 'setup' });
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'write', path: path.join(places.data, 'agents', 'ag_a', 'SYSTEM.md') }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'write', path: path.join(places.data, 'memory', 'facts.md') }), 'open');
  assert.equal(verdict({ ...s, setup: 'yes' }, { agentId: 'ag_a', capability: 'write', path: path.join(places.data, 'modes', 'x.md') }), 'open');
});

test('chosen folders and apps: listed ones are open, the rest asks; an unknown app is left to the helper', () => {
  const s = secure({ readFolders: [path.join(root, 'Docs')], writeFolders: [path.join(root, 'Out')], computer: 'chosen', computerApps: ['excel'] });
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'read', path: path.join(root, 'Docs', 'a', 'b.pdf') }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'write', path: path.join(root, 'Docs', 'b.pdf') }), 'ask');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'write', path: path.join(root, 'Out', 'b.pdf') }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'computer', app: 'EXCEL.EXE' }), 'open');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'computer', app: 'chrome' }), 'ask');
  assert.equal(verdict(s, { agentId: 'ag_a', capability: 'computer' }), 'open');
  assert.equal(verdict({ ...s, computer: 'ask' }, { agentId: 'ag_a', capability: 'computer', app: 'excel' }), 'ask');
});

test('the offered place and what "always" changes', () => {
  assert.deepEqual(placeOf('read', { path: outside }, places.workspace), { kind: 'folder', value: path.dirname(outside) });
  assert.deepEqual(placeOf('write', { path: path.join(root, 'dir'), isFolder: true }, places.workspace), { kind: 'folder', value: path.join(root, 'dir') });
  assert.deepEqual(placeOf('computer', { app: 'Chrome.exe' }, places.workspace), { kind: 'app', value: 'chrome' });
  assert.equal(placeOf('commands', {}, places.workspace), undefined);
  assert.equal(placeOf('read', { path: path.parse(root).root + 'x.txt' }, places.workspace), undefined, 'never a whole drive');
  const s = secure();
  assert.equal(opened(s, 'commands').commands, 'yes');
  assert.equal(opened(s, 'read').read, 'all');
  assert.equal(opened(s, 'computer').computer, 'yes');
  const app = opened(s, 'computer', { kind: 'app', value: 'chrome' });
  assert.equal(app.computer, 'chosen');
  assert.deepEqual(app.computerApps, ['chrome']);
  const folder = opened(s, 'write', { kind: 'folder', value: path.join(root, 'Out') });
  assert.deepEqual(folder.writeFolders, [path.join(root, 'Out')]);
  assert.deepEqual(folder.readFolders, [path.join(root, 'Out')], 'what I may change I may read');
  assert.equal(s.commands, 'ask', 'the input stays as it was');
});

test('the helper guard: open in Trust mode, Autark\'s pids in Secure mode, the app list only for chosen apps', () => {
  assert.deepEqual(guardConfig(trust(), [10, 20]), { appPids: [], apps: null });
  assert.deepEqual(guardConfig(secure({ computer: 'yes' }), [20, 10, 10, 0]), { appPids: [10, 20], apps: null });
  assert.deepEqual(guardConfig(secure({ computer: 'chosen', computerApps: ['Excel'] }), [1], ['chrome']), { appPids: [1], apps: ['chrome', 'excel'] });
});

test('the vault refuses card data to agents in Secure mode only', () => {
  const card = { kind: 'text', groupKind: 'card', route: 'payment' };
  assert.match(vaultRefusal(secure(), card, 'ag_a', 'Mia') ?? '', /Spending money is closed .*Mia/);
  assert.equal(vaultRefusal(secure(), { kind: 'password', route: 'logins' }, 'ag_a'), undefined);
  assert.equal(vaultRefusal(secure(), card, 'human'), undefined);
  assert.equal(vaultRefusal(secure(), card, 'system'), undefined);
  assert.equal(vaultRefusal(trust(), card, 'ag_a'), undefined);
});

test('a fingerprint ignores key order and tells arguments apart', () => {
  assert.equal(fingerprintOf('files.read', { path: 'a', lines: 2 }), fingerprintOf('files.read', { lines: 2, path: 'a' }));
  assert.notEqual(fingerprintOf('files.read', { path: 'a' }), fingerprintOf('files.read', { path: 'b' }));
  assert.notEqual(fingerprintOf('files.read', { path: 'a' }), fingerprintOf('files.list', { path: 'a' }));
});

test('tool calls map to switches', () => {
  const action = (resource?: string) => ({ summary: 'x', external: false, ...(resource ? { resource } : {}) });
  const ctx = { agentId: 'ag_a' };
  assert.deepEqual(needsOf({ name: 'files.read', category: 'read' }, { path: 'a' }, action(), ctx), [{ capability: 'read', path: 'a' }]);
  assert.deepEqual(needsOf({ name: 'files.write', category: 'write_local' }, { path: 'a' }, action(), ctx), [{ capability: 'write', path: 'a' }]);
  assert.deepEqual(needsOf({ name: 'shell.exec', category: 'write_system' }, { command: 'ls', cwd: 'C:/x' }, action(), ctx), [{ capability: 'commands' }, { capability: 'write', path: 'C:/x' }]);
  assert.deepEqual(needsOf({ name: 'computer.click', category: 'device' }, {}, action('excel'), ctx), [{ capability: 'computer', app: 'excel' }]);
  assert.deepEqual(needsOf({ name: 'computer.click', category: 'device' }, {}, action('this PC'), ctx), [{ capability: 'computer' }]);
  assert.deepEqual(needsOf({ name: 'phone.tap', category: 'device' }, {}, action(), ctx), [{ capability: 'phone' }]);
  assert.deepEqual(needsOf({ name: 'web.fetch', category: 'read' }, {}, action(), ctx), [{ capability: 'web' }]);
  assert.deepEqual(needsOf({ name: 'agents.update', category: 'agents' }, { name: 'Me' }, action(), ctx), [], 'its own SYSTEM.md is its own');
  assert.deepEqual(needsOf({ name: 'agents.update', category: 'agents' }, { agentId: 'ag_b' }, action(), ctx), [{ capability: 'team' }]);
  assert.deepEqual(needsOf({ name: 'agents.create', category: 'agents' }, {}, action(), ctx), [{ capability: 'team' }]);
  assert.deepEqual(needsOf({ name: 'modes.save', category: 'agents' }, {}, action(), ctx), [{ capability: 'setup' }]);
  assert.deepEqual(needsOf({ name: 'secrets.save', category: 'write_local' }, {}, action(), ctx), [{ capability: 'accounts' }]);
  assert.deepEqual(needsOf({ name: 'library.publish', category: 'publish' }, {}, action(), ctx), [{ capability: 'publish' }]);
  assert.deepEqual(needsOf({ name: 'telegram.connect', category: 'communicate' }, {}, action(), ctx), [{ capability: 'message' }]);
  assert.deepEqual(needsOf({ name: 'gmail.send', category: 'write_system' }, {}, action('app://gmail'), ctx), [{ capability: 'message' }]);
  assert.deepEqual(needsOf({ name: 'tasks.create', category: 'think' }, {}, action(), ctx), []);
  const secrets = () => [{ id: 'sec_card', label: 'Visa', kind: 'text', route: 'payment', group: { id: 'g', label: 'Visa', kind: 'card' }, createdAt: 0 }, { id: 'sec_pw', label: 'pw', kind: 'password', createdAt: 0 }] as never;
  assert.deepEqual(needsOf({ name: 'browser.act', category: 'device' }, { text: 'secret://sec_card' }, action(), ctx, secrets), [{ capability: 'money' }, { capability: 'web' }, { capability: 'accounts' }]);
  assert.deepEqual(needsOf({ name: 'shell.exec', category: 'write_system' }, { command: 'x', env: { P: 'secret://sec_pw' } }, action(), ctx, secrets), [{ capability: 'commands' }, { capability: 'accounts' }]);
});
