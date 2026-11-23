// The secrets catalog for agents (owner 29.10.2026, a catalog like skills):
// secrets.save adds an entry with a description – the route chosen automatically (or named), the id generated (or
// suggested), for every agent, the value straight into the vault and never in the result or the journal; entries are
// found like skills (knowledge.find's catalog lines – single secrets and logins, never a value);
// a stored value never lands anywhere else: every tool argument passes the leak redactor before the tool runs (the
// registry guard), so a note, memory, file or message gets the handle; the agent guidance says so.
// Owns: these assertions only. Never: a real keychain, model or network.

import { test } from 'node:test';

import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../fakes.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { newEntryId, slugOf } from '../../../src/runtime/secrets/entry-id.ts';
import { withoutSecretValues } from '../../../src/runtime/secrets/guard.ts';
import { findSecretLines } from '../../../src/runtime/secrets/metadata.ts';
import { NOTE, secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import { HIDDEN_ARGS, Registry } from '../../../src/runtime/tools/registry.ts';
import { journalArgs } from '../../../src/runtime/tools/journal.ts';
import { autoSecretRoute } from '../../../src/shared/model/security.ts';
import { setup as permissionsSetup } from '../tools/helpers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../../../src/runtime/tools/types.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};
const TOKEN = 'ghp_catalog_test_token_0000111122';

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const vault = new SecretVault({ db, host, clock: new ManualClock() });
  const services = { db, secrets: vault, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as RuntimeServices;
  const ctx = (agentId = 'ag_mira'): ToolContext => ({
    agent: { id: agentId, name: 'Mira' } as ToolContext['agent'], runId: 'run_1', mode: 'general', services, signal: new AbortController().signal, status() {},
  });
  return { db, vault, services, ctx };
}

const tool = (name: string) => secretTools.find((entry) => entry.name === name)!;
const all = (out: ToolOutput) => JSON.stringify(out);

test('secrets.save: the route is chosen and the id generated (or named and suggested); for every agent; only the handle comes back', async () => {
  const t = setup();
  const out = await tool('secrets.save').run({ name: 'GitHub CI token', description: 'Releases from the CI pipeline.', value: TOKEN, kind: 'token' }, t.ctx());
  assert.equal(out.isError, undefined, all(out));
  const saved = out.structured as { id: string; handle: string; route: string };
  assert.deepEqual([saved.id, saved.handle, saved.route], ['sec_github-ci-token', 'secret://sec_github-ci-token', 'keys']);
  assert.ok(!all(out).includes(TOKEN), 'the value never comes back');
  const info = t.vault.list()[0];
  assert.deepEqual([info.createdBy, info.description], ['ag_mira', 'Releases from the CI pipeline.']);
  assert.equal(await t.vault.use(info.id, 'ag_ben', 'api.github.com'), TOKEN, 'every agent may use it, anywhere');
  const named = await tool('secrets.save').run({ name: 'Build box', description: 'Root login', value: 'pw-build-root-1', kind: 'password', route: 'Home Lab', id: 'Build Box Root', tags: ['ssh build.local'] }, t.ctx());
  assert.deepEqual([(named.structured as { id: string }).id, (named.structured as { route: string }).route], ['build-box-root', 'home-lab'], 'a suggested id and a named route');
  const again = await tool('secrets.save').run({ name: 'Same token', description: 'x', value: TOKEN }, t.ctx());
  assert.match(all(again), /already stored/);
  assert.equal(t.vault.list().length, 2, 'no duplicate');
  const handle = await tool('secrets.save').run({ name: 'x', description: 'x', value: `secret://${info.id}` }, t.ctx());
  assert.match(all(handle), /already stored/, 'the registry guard turns a known value into its handle first – the same answer');
  assert.deepEqual(HIDDEN_ARGS.get('secrets.save'), ['value']);
  assert.equal(JSON.stringify(journalArgs({ name: 'x', value: TOKEN }, HIDDEN_ARGS.get('secrets.save'))).includes(TOKEN), false, 'the journal shows [hidden]');
});

test('automatic routes and ids', () => {
  assert.deepEqual([
    autoSecretRoute('card'), autoSecretRoute('password', 'SSH login of the build server'), autoSecretRoute('api_key'), autoSecretRoute('token'),
    autoSecretRoute('password'), autoSecretRoute('totp'), autoSecretRoute('note'), autoSecretRoute('other', '', 'login'), autoSecretRoute('text', '', 'card'),
  ], ['payment', 'servers', 'keys', 'keys', 'logins', 'logins', 'notes', 'logins', 'payment']);
  assert.equal(slugOf('Stripe – live Käy!'), 'stripe-live-kay');
  assert.equal(newEntryId([{ id: 'sec_stripe' }], [], 'Stripe'), 'sec_stripe-2');
  assert.equal(newEntryId([], [{ id: 'my-key' }], 'x', 'My Key'), 'my-key-2', 'a suggestion is made unique');
  assert.equal(newEntryId([], [], '!!!'), 'sec_secret');
});

test('found like skills: the catalog lines name single secrets and logins with their handles – never a value', async () => {
  const t = setup();
  await t.vault.save({ label: 'GitHub CI token', kind: 'token', value: TOKEN, description: 'Releases from the CI pipeline.' });
  const login = await t.vault.saveGroup({ label: 'Support mailbox login', kind: 'login', description: 'Customer support inbox at mail.example', fields: [
    { field: 'username', kind: 'text', value: 'support@mail.example' }, { field: 'password', kind: 'password', value: 'pw-support-inbox-9' },
  ] });
  await t.vault.save({ label: 'Ben\'s mailbox', kind: 'password', value: 'pw-ben-mailbox-1', description: 'Support inbox of Ben' });
  const lines = findSecretLines(t.services, 'answer the customer support inbox mail.example');
  assert.equal(lines.length, 1, 'a find gives the entries the text names – Ben\'s mailbox holds the words only in its purpose');
  const listed = (await tool('secrets.list').run({ query: 'support inbox' }, t.ctx())).structured as { secrets: Array<{ name: string }> };
  assert.deepEqual(listed.secrets.map((entry) => entry.name), ['Support mailbox login', 'Ben\'s mailbox'], 'secrets.list searches the purposes too');
  // a login's line starts with its id (no value stands behind it), each field with its handle
  assert.match(lines[0], new RegExp(`^- ${login.group.id} "Support mailbox login" \\(route logins\\) – Customer support inbox at mail\\.example fields: `));
  assert.match(lines[0], /username secret:\/\/\S+/);
  assert.match(lines[0], /password secret:\/\/\S+/);
  assert.ok(!lines.join('').includes('pw-support') && !lines.join('').includes('pw-ben'), 'no value');
  assert.deepEqual(findSecretLines(t.services, 'ci releases token').map((line) => /secret:\/\/(\S+)/.exec(line)![1]), ['sec_github-ci-token']);
});

test('F19: use() counts the field and its login; an edit – the person\'s, an agent\'s or the device sync\'s save – leaves the count', async () => {
  const t = setup();
  const key = await t.vault.save({ label: 'Shop key', kind: 'api_key', value: 'sk-shop-count-1' });
  const login = await t.vault.saveGroup({ label: 'Shop login', kind: 'login', fields: [
    { field: 'username', kind: 'text', value: 'shop@example.com' }, { field: 'password', kind: 'password', value: 'pw-shop-count-2' },
  ] });
  const password = login.fields.find((field) => field.field === 'password')!;
  const username = login.fields.find((field) => field.field === 'username')!;
  assert.equal(t.vault.list().find((info) => info.id === key.id)!.uses, undefined, 'never used: no count');
  await t.vault.use(key.id, 'ag_mira');
  await t.vault.use(key.id, 'ag_ben');
  await t.vault.use(password.id, 'ag_mira');
  await t.vault.use(username.id, 'ag_mira');
  const count = (id: string) => t.vault.list().find((info) => info.id === id)!.uses;
  assert.deepEqual([count(key.id), count(password.id), count(username.id)], [2, 1, 1]);
  assert.equal(t.vault.groups().find((group) => group.id === login.group.id)!.uses, 2, 'the login counts each of its fields\' uses');
  // what the device sync writes (devices/sync/secrets.ts apply → save / saveGroup with the other PC's metadata and value)
  await t.vault.save({ id: key.id, label: 'Shop key (renamed)', kind: 'api_key', value: 'sk-shop-count-3', description: 'Synced' });
  await t.vault.saveGroup({ id: login.group.id, label: 'Shop login', description: 'Synced', tags: ['shop'], fields: [{ id: password.id, field: 'password', kind: 'password', value: 'pw-shop-count-4' }] });
  assert.equal(count(key.id), 2, 'a save leaves the count');
  assert.equal(t.vault.groups().find((group) => group.id === login.group.id)!.uses, 2, 'a group save leaves the count');
  assert.equal(count(password.id), 1);
});

test('a stored value never lands anywhere else: every tool argument passes the leak redactor before the tool runs', async () => {
  const t = setup();
  const info = await t.vault.save({ label: 'Token', kind: 'token', value: TOKEN });
  const args = { title: 'Notes', body: `deploy with ${TOKEN}`, nested: [{ text: Buffer.from(TOKEN).toString('base64') }], count: 3 };
  const clean = withoutSecretValues(t.vault, args);
  assert.deepEqual(clean, { title: 'Notes', body: `deploy with secret://${info.id}`, nested: [{ text: `secret://${info.id}` }], count: 3 });
  assert.equal(withoutSecretValues(t.vault, { a: 'plain' }).a, 'plain');

  // Through the real registry: a note, memory, file or message tool gets the handle, never the value.
  const h = permissionsSetup();
  const services = h.services as RuntimeServices;
  const registry = new Registry({ services: () => services });
  services.tools = registry;
  const seen: unknown[] = [];
  const note: ToolDef = {
    name: 'memory.note_test', description: 'test', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }, category: 'read',
    describe: () => ({ summary: 'Note', reversible: true, external: false }),
    async run(input) { seen.push(input); return { content: [{ type: 'text', text: 'ok' }] }; },
  };
  registry.register(note);
  const ctx: Omit<ToolContext, 'services'> = { agent: h.tom, runId: 'run_guard', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} };
  await registry.call('memory.note_test', { text: 'the key is sk-abc123 – keep it' }, ctx, 'call_1');
  assert.deepEqual(seen, [{ text: 'the key is secret://sec_1 – keep it' }], 'the helpers\' vault knows sk-… values');
  assert.ok(!JSON.stringify(h.runItems).includes('sk-abc123'), 'nor in the journal');
});

test('the agent guidance: save a secret straight into the catalog and use its id – never copy it elsewhere', () => {
  assert.match(NOTE, /values stay out of my notes, memory, rules, files and messages/);
  assert.match(tool('secrets.save').description, /the moment I get one .*I keep the value here, nowhere else/);
});
