// F19 (owner 15.11.2026: secrets "wie als Memories" in the subconscious's word search, handed to the AI when it needs them):
// secrets are one kind of the single find (find/secrets.ts) – a find naming a stored login gives a 'secret' candidate with its
// fields' handles, at most three, none when other kinds are asked; knowledge.find shows the handles in its line; opening one
// gives its catalog line and where a handle becomes the value, never a value; the look before a turn offers it and opens it
// as the main AI's own knowledge.open.
// Owns: these assertions. Never: a real keychain, model or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../fakes.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { FindService } from '../../../src/runtime/find/service.ts';
import { findTools } from '../../../src/runtime/tools/builtin/find.ts';
import { routeTurn } from '../../../src/runtime/subconscious/route-turn.ts';
import { ROUTE_WAIT_MS } from '../../../src/runtime/subconscious/service.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { agent } from '../chat/harness.ts';
import { fixture } from '../context/fixture.ts';

const host = {
  encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
  decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
};
const PASSWORD = 'pw-larsen-portal-7731';
const tom = { id: 'ag_tom', name: 'Tom', mode: 'general', skills: [] } as unknown as Agent;
const mode = { key: 'general', name: 'General', description: '', skills: [], tools: ['*'], category: 'general' } as unknown as ModeInfo;
const caller = { agent: tom, via: 'agent' as const, mode: 'general' };

async function world() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock(Date.UTC(2026, 10, 16));
  const vault = new SecretVault({ db, host, clock });
  const services = {
    db, secrets: vault, clock, modes: { get: () => mode, list: () => [mode] }, settings: { get: () => ({ profile: { timezone: 'UTC' } }) },
    knowledge: { search: async () => [], get: () => undefined }, log: { warn() {}, info() {}, error() {}, debug() {} },
  } as unknown as RuntimeServices;
  const login = await vault.saveGroup({ label: 'Larsen Marine Portal', kind: 'login', description: 'The supplier portal where the invoices are downloaded.', fields: [
    { field: 'username', kind: 'text', value: 'lars.aune' }, { field: 'password', kind: 'password', value: PASSWORD },
  ] });
  return { db, vault, services, login, find: new FindService(() => services) };
}

test('a find naming a stored login gives a secret candidate with its fields\' handles; opening it gives the handles, never the value', async () => {
  const w = await world();
  const found = await w.find.find(caller, { query: 'Log in to the Larsen Marine Portal and download the invoices.' });
  const hit = found.find((candidate) => candidate.kind === 'secret');
  assert.ok(hit, JSON.stringify(found));
  assert.equal(hit.id, `secret:${w.login.group.id}`);
  assert.deepEqual([hit.authority, hit.title, hit.route], ['document', 'Larsen Marine Portal', 'secrets/logins.md']);
  for (const field of w.login.fields) assert.match(hit.handles ?? '', new RegExp(`${field.field} secret://${field.id}`));
  assert.ok(!JSON.stringify(found).includes(PASSWORD));
  const opened = await w.find.open(caller, { id: hit.id, version: hit.version });
  assert.match(opened.text, /^sgr_\S+ "Larsen Marine Portal" \(route logins\) – The supplier portal where the invoices are downloaded\. fields: username secret:\/\/\S+, password secret:\/\/\S+/);
  assert.match(opened.text, /becomes the value in browser\.act/);
  assert.equal(opened.changed, undefined);
  assert.ok(!opened.text.includes(PASSWORD) && !opened.text.includes('lars.aune'), 'no value, not even the username');
  assert.equal(w.vault.groups()[0].uses, undefined, 'opening is no use');
  await w.vault.saveGroup({ id: w.login.group.id, description: 'The portal of Larsen Marine (invoices, orders).' });
  assert.match((await w.find.open(caller, { id: hit.id, version: hit.version })).changed ?? '', /changed since I found it/);
  await assert.rejects(w.find.open(caller, { id: 'secret:sgr_gone' }), /does not exist/);
});

test('at most three secrets in a find, none when other kinds are asked; the tool\'s line ends with the handles', async () => {
  const w = await world();
  for (const name of ['Larsen orders API key', 'Larsen invoices API key', 'Larsen backup key', 'Larsen staging key']) await w.vault.save({ label: name, kind: 'api_key', value: `v-${name}` });
  const found = await w.find.find(caller, { query: 'larsen' });
  assert.equal(found.filter((candidate) => candidate.kind === 'secret').length, 3);
  assert.equal((await w.find.find(caller, { query: 'larsen', kinds: ['note'] })).length, 0);
  const tool = findTools.find((entry) => entry.name === 'knowledge.find')!;
  const ctx = { agent: tom, runId: 'r', mode: 'general', services: w.services, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
  const output = await tool.run({ query: 'Larsen Marine Portal login' }, ctx);
  const text = output.content[0].type === 'text' ? output.content[0].text : '';
  assert.match(text, new RegExp(`^- \\[secret:${w.login.group.id}\\] secret "Larsen Marine Portal" \\(The supplier portal .*\\) – secrets/logins\\.md @\\w+ · authority document · .* · username secret://\\S+, password secret://\\S+$`, 'm'));
  assert.ok(!text.includes(PASSWORD));
  assert.match(tool.description, /secrets \(names with their handles\)/);
});

/** A decision model whose answer is made from the call it gets (the ids it was offered). */
function answering(answer: (call: Parameters<StructuredRunner>[0]) => Record<string, unknown>) {
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const structured = answer(call);
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  return { runner, calls };
}

test('the look before a turn offers a fitting login and hints it with its handles – never the value, never an open call', async () => {
  const f = fixture();
  const vault = new SecretVault({ db: f.db, host, clock: f.clock });
  (f.services as unknown as { secrets: SecretVault }).secrets = vault;
  const login = await vault.saveGroup({ label: 'Larsen Marine Portal', kind: 'login', description: 'The supplier portal where the invoices are downloaded.', fields: [
    { field: 'username', kind: 'text', value: 'lars.aune' }, { field: 'password', kind: 'password', value: PASSWORD },
  ] });
  const ida = f.org.add(agent('ag_ida', 'Ida', { role: 'Assistant' }));
  const id = `secret:${login.group.id}`;
  type Schema = { properties: Record<string, { items?: { properties?: { id?: { enum?: string[] } } } }> };
  const brain = answering((call) => ({ hints: ((call.schema as Schema).properties.hints?.items?.properties?.id?.enum ?? []).filter((entry) => entry === id).map((entry) => ({ id: entry, line: `The portal login it signs in with (password ${PASSWORD}).` })) }));
  const look = await routeTurn(f.services, brain.runner, { agent: ida, said: 'Log in to the Larsen Marine Portal and download the invoices.', held: true, deadlineMs: ROUTE_WAIT_MS });
  const [call] = brain.calls;
  assert.match(call.prompt, new RegExp(`- ${id} · secret · Larsen Marine Portal – The supplier portal`));
  assert.match(call.system, /the secrets catalog \(names and handles, never values\)/);
  assert.equal(look?.hints.length, 1);
  const [hint] = look!.hints;
  assert.equal(hint.id, id);
  assert.match(hint.open, /username secret:\/\/\S+, password secret:\/\/\S+/, 'its handles instead of the open call');
  assert.doesNotMatch(hint.open, /knowledge\.open/);
  assert.ok(!hint.line.includes(PASSWORD) && !hint.open.includes(PASSWORD) && !call.prompt.includes(PASSWORD));
});
