// FX2 of the Sicher-Runde (19.11.2026): "once" is per agent and goes to exactly one waiting call; a request made with only
// the run finds the run's chat; paths are judged as real paths (\\?\, case, trailing separator, a junction out of the
// workspace); the tool map covers shared skills, devices.send_file, file: URLs and unknown path arguments by category;
// fingerprints leave free text out; every built-in and device tool of a changing category maps to a need or is named
// here as internal.
// Owns: these assertions only. Never: a real engine, the person's data or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agent, harness } from '../chat/harness.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { Security } from '../../../src/runtime/security/service.ts';
import { Approvals } from '../../../src/runtime/security/approvals.ts';
import { decide, opened, realPath, samePath, type Places } from '../../../src/runtime/security/policy.ts';
import { needFingerprint, needsOf, type NeedContext } from '../../../src/runtime/security/tool-gate.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { deviceTools } from '../../../src/runtime/devices/tools.ts';
import { securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { SkillInfo } from '../../../src/shared/model/knowledge.ts';

const root = path.resolve('fx2-root');

function setup(waitMs = 30) {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  settings.update({ profile: { name: 'Mia' }, security: securityDefaults('secure') } as never);
  const services = h.services as RuntimeServices;
  services.settings = settings;
  services.paths = { data: path.join(root, 'data'), workspace: path.join(root, 'Workforce'), resources: path.join(root, 'res'), temp: path.join(root, 'data', 'tmp') } as RuntimeServices['paths'];
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_ida', 'Ida'));
  const sec = new Security({ services: () => services, waitMs });
  services.security = sec;
  return { ...h, services, sec };
}

const step = (agentId: string, extra: Record<string, unknown> = {}) => ({ agentId, capability: 'commands' as const, summary: 'Run: npm install', fingerprint: 'fp_same', ...extra });

test('a "once" answered while nobody waits is that agent\'s: another agent\'s identical call asks for itself', async () => {
  const h = setup();
  assert.equal((await h.sec.gate(step('ag_tom'))).ok, false, 'the call gave up waiting; the request stays');
  h.sec.answer(h.sec.requests()[0].id, 'once');
  assert.equal((await h.sec.gate(step('ag_ida'))).ok, false, 'Ida never uses Tom\'s grant');
  assert.equal(h.sec.requests().length, 1, 'Ida has a request of her own');
  assert.deepEqual(await h.sec.gate(step('ag_tom')), { ok: true }, 'Tom\'s next identical call goes through once');
  assert.equal((await h.sec.gate(step('ag_tom'))).ok, false, 'and only once');
});

test('"once" goes to exactly one of the calls waiting on a request; the other hears that it did not run', async () => {
  const h = setup(5_000);
  const first = h.sec.gate(step('ag_tom'));
  const second = h.sec.gate(step('ag_tom'));
  assert.equal(h.sec.requests().length, 1, 'the same step waits on one request');
  h.sec.answer(h.sec.requests()[0].id, 'once');
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], { ok: true });
  assert.equal(results[1].ok, false);
  assert.match(results[1].ok ? '' : results[1].text, /Mia allowed "Run: npm install" once, and that one time went to the same step/);
});

test('Approvals: grants are keyed by agent and fingerprint; "decline" reaches every waiter', async () => {
  const store = new Approvals({ now: () => 1 });
  store.grant('ag_a', 'fp');
  assert.equal(store.take('ag_b', 'fp'), false);
  assert.equal(store.take('ag_a', 'fp'), true);
  store.add({ id: 'apr_1', agentId: 'ag_a', agentName: 'A', at: 1, capability: 'commands', summary: 'x', fingerprint: 'fp' });
  const waits = [store.wait('apr_1', 5_000), store.wait('apr_1', 5_000)];
  store.settle('apr_1', 'decline');
  assert.deepEqual(await Promise.all(waits), ['decline', 'decline']);
});

test('a request made with only its run (an engine\'s own tool) carries the run\'s chat and task, so the late answer wakes there', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.services.runs = { get: (id: string) => (id === 'run_7' ? { id, agentId: 'ag_tom', conversationId: chat.id, taskId: 'tsk_1', trigger: 'message', status: 'running' } : undefined) } as unknown as RuntimeServices['runs'];
  await h.sec.gate(step('ag_tom', { runId: 'run_7' }));
  assert.equal(h.sec.requests()[0].chatId, chat.id);
  await h.sec.gate(step('ag_ida', { runId: 'run_7', fingerprint: 'fp_ida' }));
  assert.equal(h.sec.requests()[1].chatId, undefined, 'another agent\'s run is not taken');
});

test('a call from another company names its agent in the request', async () => {
  const h = setup();
  await h.sec.gate(step('ag_far', { agentName: 'Lena (Company B)' }));
  assert.equal(h.sec.requests()[0].agentName, 'Lena (Company B)');
});

// ---------------------------------------------------------------- real paths (M2)

function tree() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'fx2-paths-'));
  const places: Places = { data: path.join(base, 'data'), workspace: path.join(base, 'Workforce'), resources: path.join(base, 'res'), temp: [path.join(base, 'tmpdir')] };
  for (const dir of [places.data, places.workspace, path.join(places.data, 'security'), path.join(base, 'outside')]) mkdirSync(dir, { recursive: true });
  return { base, places, done: () => rmSync(base, { recursive: true, force: true }) };
}
const secure = (patch: Partial<SecuritySettings> = {}): SecuritySettings => ({ ...securityDefaults('secure'), write: 'all', ...patch });

test('the \\\\?\\ spelling, another case and a trailing separator do not change a verdict', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
  const t = tree();
  try {
    const long = (file: string) => `\\\\?\\${file}`;
    assert.deepEqual(decide(secure(), t.places, { agentId: 'ag_a', capability: 'write', path: long(path.join(t.places.data, 'settings.json')) }), { verdict: 'ask', capability: 'setup' }, 'Autark\'s settings stay setup');
    assert.equal(decide(secure(), t.places, { agentId: 'ag_a', capability: 'write', path: long(path.join(t.places.data, 'security', 'secure', 'money.md')) }).verdict, 'closed');
    assert.equal(decide(secure(), t.places, { agentId: 'ag_a', capability: 'write', path: path.join(t.places.data, 'SECURITY', 'x.md').toUpperCase() }).verdict, 'closed');
    const listed = secure({ write: 'chosen', writeFolders: [`${path.join(t.base, 'outside')}\\`] });
    assert.equal(decide(listed, t.places, { agentId: 'ag_a', capability: 'write', path: path.join(t.base, 'OUTSIDE', 'a.txt') }).verdict, 'open');
    assert.equal(realPath('\\\\?\\C:\\Windows'), realPath('C:\\Windows'));
  } finally { t.done(); }
});

test('a junction inside the workspace that leads elsewhere is judged where it leads', () => {
  const t = tree();
  try {
    const link = path.join(t.places.workspace, 'shortcut');
    symlinkSync(path.join(t.base, 'outside'), link, 'junction');
    const chosen = secure({ write: 'chosen' });
    assert.equal(decide(chosen, t.places, { agentId: 'ag_a', capability: 'write', path: path.join(link, 'x.txt') }).verdict, 'ask', 'not an own folder');
    assert.equal(decide(chosen, t.places, { agentId: 'ag_a', capability: 'write', path: path.join(t.places.workspace, 'real.txt') }).verdict, 'open');
    const security = path.join(t.places.workspace, 'sec');
    symlinkSync(path.join(t.places.data, 'security'), security, 'junction');
    assert.equal(decide(secure(), t.places, { agentId: 'ag_a', capability: 'write', path: path.join(security, 'x.md') }).verdict, 'closed', 'the security folder by another name');
  } finally { t.done(); }
});

test('"always this folder" is not added twice under another spelling', () => {
  const t = tree();
  try {
    const folder = path.join(t.base, 'outside');
    const once = opened(secure({ write: 'chosen' }), 'write', { kind: 'folder', value: folder });
    const again = opened(once, 'write', { kind: 'folder', value: `${folder}${path.sep}` });
    assert.deepEqual(again.writeFolders, [folder]);
    assert.ok(samePath(folder, path.join(folder, '.')));
  } finally { t.done(); }
});

// ---------------------------------------------------------------- the tool map (H3) and fingerprints (M3)

const action = (resource?: string) => ({ summary: 'x', external: false, ...(resource ? { resource } : {}) });
const shared: SkillInfo = { name: 'reports', description: '', modes: [], source: 'user', path: path.join(root, 'Workforce', 'skills', 'reports') } as unknown as SkillInfo;
const mine: SkillInfo = { ...shared, source: 'agent', ownerAgentId: 'ag_a', path: path.join(root, 'data', 'agents', 'ag_a', 'skills', 'reports') } as unknown as SkillInfo;
const ctx = (skill?: SkillInfo): NeedContext => ({ agentId: 'ag_a', skill: () => skill });
const caps = (needs: ReturnType<typeof needsOf>) => needs.map((need) => [need.capability, need.path ?? need.app ?? null]);

test('skills.save over a shared skill is setup; my own skill, a new one or a main skill need nothing', () => {
  const save = { name: 'skills.save', category: 'write_local' as const };
  assert.deepEqual(caps(needsOf(save, { name: 'reports', body: 'x' }, action(), ctx(shared))), [['setup', shared.path]]);
  assert.deepEqual(needsOf(save, { name: 'reports', body: 'x' }, action(), ctx(mine)), []);
  assert.deepEqual(needsOf(save, { name: 'reports', body: 'x' }, action(), ctx(undefined)), [], 'a new skill is my own copy');
  assert.deepEqual(needsOf(save, { name: 'reports', body: 'x', main: true }, action(), ctx(shared)), [], 'a main skill is in my folder');
  assert.deepEqual(needsOf(save, { name: 'reports', body: 'x' }, action(), ctx({ ...shared, readOnly: true } as SkillInfo)), [], 'a built-in one becomes my copy');
});

test('files the map did not know: send_file and secrets.import read, secrets.export writes, file: URLs read, other path arguments by category', () => {
  const file = path.join(root, 'elsewhere', 'a.pdf');
  assert.deepEqual(caps(needsOf({ name: 'devices.send_file', category: 'write_local' }, { to: 'Tower', path: file }, action(), ctx())), [['read', file]]);
  assert.deepEqual(caps(needsOf({ name: 'secrets.import', category: 'write_local' }, { path: file }, action(), ctx())), [['accounts', null], ['read', file]]);
  assert.deepEqual(caps(needsOf({ name: 'secrets.export', category: 'secret' }, { path: file }, action(), ctx())), [['accounts', null], ['write', file]]);
  const url = pathToFileURL(file).href;
  assert.deepEqual(caps(needsOf({ name: 'browser.open', category: 'read' }, { url }, action(), ctx())), [['web', null], ['read', file]]);
  assert.deepEqual(caps(needsOf({ name: 'web.fetch', category: 'read' }, { url }, action(), ctx())), [['web', null], ['read', file]]);
  assert.deepEqual(caps(needsOf({ name: 'browser.batch', category: 'device' }, { steps: [{ action: 'open', url }] }, action(), ctx())), [['web', null], ['read', file]], 'nested too');
  assert.deepEqual(caps(needsOf({ name: 'browser.act', category: 'device' }, { files: [file] }, action(), ctx())), [['web', null], ['read', file]], 'an upload reads the file');
  assert.deepEqual(caps(needsOf({ name: 'media.view', category: 'read' }, { path: file }, action(), ctx())), [['read', file]]);
  assert.deepEqual(caps(needsOf({ name: 'some.tool', category: 'write_local' }, { path: file }, action(), ctx())), [['write', file]]);
  assert.deepEqual(needsOf({ name: 'memory.read', category: 'read' }, { path: 'people/anna.md' }, action(), ctx()), [], 'memory paths are the store\'s, not files');
  assert.deepEqual(caps(needsOf({ name: 'browser.open', category: 'read' }, { url: 'https://example.test/a' }, action(), ctx())), [['web', null]]);
});

test('fingerprints hold what a step does, not its free text', () => {
  const shell = (args: Record<string, unknown>) => needFingerprint('shell.exec', { capability: 'commands' }, args);
  assert.equal(shell({ command: 'npm i', cwd: 'C:/w', timeoutSeconds: 30 }), shell({ command: 'npm i', cwd: 'C:/w', timeoutSeconds: 90 }));
  assert.notEqual(shell({ command: 'npm i', cwd: 'C:/w' }), shell({ command: 'npm ci', cwd: 'C:/w' }));
  const team = (args: Record<string, unknown>) => needFingerprint('agents.archive', { capability: 'team' }, args);
  assert.equal(team({ agentId: 'ag_b', reason: 'done' }), team({ agentId: 'ag_b', reason: 'finished its work' }));
  assert.notEqual(team({ agentId: 'ag_b' }), team({ agentId: 'ag_c' }));
  const write = (args: Record<string, unknown>) => needFingerprint('files.write', { capability: 'write', path: 'C:/x/a.md' }, args);
  assert.equal(write({ path: 'C:/x/a.md', content: 'one' }), write({ path: 'C:/x/a.md', content: 'two' }), 'the file is the step');
  assert.notEqual(needFingerprint('files.write', { capability: 'write', path: 'C:/x/a.md' }, {}), needFingerprint('files.read', { capability: 'read', path: 'C:/x/a.md' }, {}));
});

/** Tools of a changing category that need no switch: they change only the company's own data. */
const INTERNAL: ReadonlySet<string> = new Set([
  'agents.split_merge', // merges an agent's own parts
  'media.describe', 'media.image', 'media.music', 'media.segments', 'media.sound', 'media.speak', 'media.video', // into the company's file store
  'skills.save', // my own skill (a shared one: setup, tested above)
]);
const CHANGING = new Set(['write_local', 'write_system', 'delete', 'account', 'secret', 'agents', 'publish', 'communicate', 'spend']);
/** A value for each argument the tool's schema requires (as a real call has them). */
const required = (tool: { inputSchema: Record<string, unknown> }): Record<string, unknown> =>
  Object.fromEntries((Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required as string[] : []).map((key) => [key, path.join(root, 'x')]));

test('every built-in and device tool of a changing category maps to a switch, or is named here as internal', () => {
  const fake = new Proxy({}, { get: () => () => undefined }) as never;
  const devices = deviceTools({ computer: { activity: fake, platform: 'win32', canControl: () => false } as never, browser: fake, phone: fake, link: fake });
  const unmapped = [...builtinTools(), ...devices]
    .filter((tool) => CHANGING.has(tool.category) && !INTERNAL.has(tool.name))
    .filter((tool) => needsOf(tool, { ...required(tool), agentId: 'ag_other' }, action(), { agentId: 'ag_a' }).length === 0)
    .map((tool) => `${tool.name} (${tool.category})`);
  assert.deepEqual(unmapped, []);
});
