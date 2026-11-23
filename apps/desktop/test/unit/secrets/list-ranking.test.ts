// F19 (owner 15.11.2026: the AI finds a password by a word search, the most used ones offered directly, tags as words):
// secrets.list ranks by the catalog's word index (secrets/metadata.ts rankSecrets) – a name hit above a description-only hit,
// a tag word finds its entry, "twitter x" no longer floods (a short word counts whole), an id named in the query first, at most
// LIST_MAX with the count of all and the "more" line, ties and the listing without a query led by use; never a value.
// Owns: these assertions only. Never: a real keychain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../fakes.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { rankSecrets } from '../../../src/runtime/secrets/metadata.ts';
import { LIST_MAX, secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const vault = new SecretVault({ db, host, clock });
  const services = { db, secrets: vault, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as RuntimeServices;
  const ctx: ToolContext = { agent: { id: 'ag_mira', name: 'Mira' } as ToolContext['agent'], runId: 'run_1', mode: 'general', services, signal: new AbortController().signal, status() {} };
  type Listed = { count: number; more?: string; found?: string; secrets: Array<{ id: string; name: string; used?: number; fields?: Array<{ handle: string }> }> };
  const list = async (args: { query?: string; route?: string } = {}) => (await secretTools.find((tool) => tool.name === 'secrets.list')!.run(args, ctx)).structured as Listed;
  return { db, clock, vault, services, list };
}

const names = (listed: { secrets: Array<{ name: string }> }) => listed.secrets.map((entry) => entry.name);

test('a name hit ranks above a description-only hit; a word only in a tag finds its entry', async () => {
  const t = setup();
  await t.vault.save({ label: 'Shop admin login', kind: 'password', value: 'pw-shop-admin-1', description: 'Signs in to the Stripe dashboard of the shop.' });
  await t.vault.save({ label: 'Stripe live key', kind: 'api_key', value: 'sk-live-stripe-1', description: 'Payments of the shop.' });
  await t.vault.save({ label: 'Mailchimp key', kind: 'api_key', value: 'mc-key-1', description: 'Sends mails.', tags: ['newsletter'] });
  assert.deepEqual(names(await t.list({ query: 'stripe' })), ['Stripe live key', 'Shop admin login']);
  assert.deepEqual(names(await t.list({ query: 'newsletter' })), ['Mailchimp key'], 'a tag is a word of the entry');
  assert.deepEqual(names(await t.list({ query: 'passwords' })), ['Shop admin login'], 'a word by its stem, the kind is a word too');
});

test('"twitter x" no longer floods: a word under three letters counts only as a whole word', async () => {
  const t = setup();
  await t.vault.saveGroup({ label: 'Twitter/X login', kind: 'login', fields: [{ field: 'username', kind: 'text', value: 'team@x.example' }, { field: 'password', kind: 'password', value: 'pw-x-1' }] });
  for (const label of ['Xero accounting', 'Box storage token', 'Max mailbox', 'Postgres DB']) await t.vault.save({ label, kind: 'api_key', value: `v-${label}` });
  assert.deepEqual(names(await t.list({ query: 'twitter x' })), ['Twitter/X login']);
  assert.deepEqual(names(await t.list({ query: 'x' })), ['Twitter/X login'], 'one letter alone: the whole word');
  assert.deepEqual(names(await t.list({ query: 'db' })), ['Postgres DB']);
  assert.equal((await t.list({ query: 'the' })).count, 0, 'nothing searchable: nothing fits (not the whole catalog)');
});

test('an id named in the query comes first – an entry\'s or a field\'s handle', async () => {
  const t = setup();
  const github = await t.vault.save({ label: 'GitHub CI token', kind: 'token', value: 'ghp-ci-1', description: 'Releases.' });
  await t.vault.save({ label: 'GitHub deploy token', kind: 'token', value: 'ghp-deploy-1', description: 'GitHub deploy token for GitHub pages.' });
  const login = await t.vault.saveGroup({ label: 'Forum login', kind: 'login', fields: [{ field: 'password', kind: 'password', value: 'pw-forum-9' }] });
  assert.deepEqual(names(await t.list({ query: `github ${github.id}` })), ['GitHub CI token', 'GitHub deploy token']);
  assert.deepEqual(names(await t.list({ query: `secret://${login.fields[0].id}` })), ['Forum login'], 'a field\'s handle finds its login');
});

test(`at most ${LIST_MAX} entries, the count of all that fit and the line that more words narrow it`, async () => {
  const t = setup();
  for (let index = 1; index <= 25; index++) await t.vault.save({ label: `Mail account ${String(index).padStart(2, '0')}`, kind: 'password', value: `pw-mail-${index}` });
  const listed = await t.list({ query: 'mail' });
  assert.equal(listed.secrets.length, LIST_MAX);
  assert.equal(listed.count, 25);
  assert.equal(listed.more, '5 more fit; more words or a route narrow it.');
  const all = await t.list();
  assert.equal(all.more, '5 more are in the catalog; words or a route find them.');
  assert.equal((await t.list({ query: 'account 07' })).secrets[0].name, 'Mail account 07', 'a number counts as a whole word');
});

test('the ones in use lead: without a query by how often, then how lately, then the rest by name; a tie of a query goes to use', async () => {
  const t = setup();
  const a = await t.vault.save({ label: 'Alpha key', kind: 'api_key', value: 'v-alpha-1' });
  const b = await t.vault.save({ label: 'Mail login B', kind: 'password', value: 'v-mail-b-1' });
  const c = await t.vault.save({ label: 'Mail login C', kind: 'password', value: 'v-mail-c-1' });
  await t.vault.save({ label: 'Zulu key', kind: 'api_key', value: 'v-zulu-1' });
  await t.vault.use(c.id, 'ag_mira');
  t.clock.advance(1000);
  await t.vault.use(c.id, 'ag_mira');
  await t.vault.use(a.id, 'ag_mira');
  t.clock.advance(1000);
  await t.vault.use(b.id, 'ag_mira');
  const listed = await t.list();
  assert.deepEqual(names(listed), ['Mail login C', 'Mail login B', 'Alpha key', 'Zulu key'], 'two uses, then the later of one use each, then by name');
  assert.deepEqual(listed.secrets.map((entry) => entry.used), [2, 1, 1, undefined]);
  assert.deepEqual(names(await t.list({ query: 'mail login' })), ['Mail login C', 'Mail login B'], 'an even fit: the one used more');
  assert.deepEqual(rankSecrets(t.services, 'mail').map((hit) => hit.entry.uses), [2, 1]);
});

test('the index and the listing hold metadata only: a value is no word of the catalog', async () => {
  const t = setup();
  await t.vault.save({ label: 'Shop key', kind: 'api_key', value: 'sk-unique-value-4711' });
  const listed = await t.list({ query: 'shop' });
  assert.ok(!JSON.stringify(listed).includes('sk-unique-value-4711'));
  assert.equal((await t.list({ query: 'sk-unique-value-4711' })).count, 0);
  assert.equal((await t.list({ query: 'unique' })).count, 0);
});
