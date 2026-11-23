// Owns: the RPC of the security texts (runtime/rpc/handlers/security-mode.ts): security.topics for every session that
// reads settings, security.saveTopic for the person (owner marked `person`, their secure phone; FX1: never runtime.json's token) – an agent's wf
// hears in its own words that the texts are the person's – and the person's save is logged with their name.
// Never: the files themselves (topics.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HandlerTable, scopeDenial, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register, SAVE_TOPIC_PERSON_ONLY } from '../../../src/runtime/rpc/handlers/security-mode.ts';
import { isPersonScope } from '../../../src/runtime/security/rpc-guard.ts';
import { readSecurityChanges } from '../../../src/runtime/settings/security-log.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { harness } from '../chat/harness.ts';
import { tempDir } from '../store/helpers.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
const PHONE: ClientScope = { kind: 'device', deviceId: 'd1', capabilities: ['settings'], secure: true };

function rig() {
  const temp = tempDir('wf-sec-rpc-');
  const h = harness();
  Object.assign(h.services, { paths: { data: temp.dir, resources: RESOURCES, workspace: temp.dir, temp: temp.dir }, settings: { get: () => ({ profile: { name: 'Ada' } }) } });
  const table = new HandlerTable();
  register(table);
  const call = async (method: string, params: unknown, scope: ClientScope): Promise<unknown> => {
    const entry = table.get(method as never)!;
    const denied = scopeDenial(entry.scope, scope);
    if (denied) throw new Error(`scope: ${denied}`);
    return await entry.handler(params as never, { services: h.services as RuntimeServices, scope, topics: new Set() } as unknown as HandlerContext);
  };
  return { h, table, call, done: temp.cleanup };
}

test('who saves: the person\'s marked owner sessions (not runtime.json\'s token) and the person\'s phone; agents and everyone else are refused', () => {
  assert.equal(isPersonScope({ kind: 'owner', person: true }), true);
  assert.equal(isPersonScope({ kind: 'owner', main: true, person: true }), true);
  assert.equal(isPersonScope({ kind: 'owner' }), false, 'FX1: the launch token in runtime.json names nobody');
  assert.equal(isPersonScope({ kind: 'owner', person: true, agentId: 'ag_1' }), false, 'an agent\'s wf');
  assert.equal(isPersonScope(PHONE), true);
  assert.equal(isPersonScope({ kind: 'agent', agentId: 'ag_1', runId: 'r' }), false);
  assert.equal(isPersonScope({ kind: 'peer', deviceId: 'pc2' }), false);
});

test('security.topics reads for the window and the phone; saveTopic writes for the person and refuses an agent\'s wf in its own words', async () => {
  const r = rig();
  try {
    const listed = await r.call('security.topics', { mode: 'trust' }, PHONE) as Array<{ topic: string; text: string; isDefault: boolean }>;
    assert.equal(listed.find((entry) => entry.topic === 'money')?.isDefault, true);
    await assert.rejects(() => r.call('security.topics', { mode: 'other' }, { kind: 'owner', person: true }), /mode/);
    await assert.rejects(() => r.call('security.topics', { mode: 'trust' }, { kind: 'device', deviceId: 'd2', capabilities: ['todo'], secure: true }), /scope/);
    const saved = await r.call('security.saveTopic', { mode: 'trust', topic: 'money', text: 'Up to 50 EUR.' }, { kind: 'owner', person: true });
    assert.deepEqual(saved, { topic: 'money', text: 'Up to 50 EUR.', isDefault: false });
    assert.deepEqual(readSecurityChanges(new KvRepo(r.h.db))[0]?.by, { kind: 'person', name: 'Ada' });
    await assert.rejects(() => r.call('security.saveTopic', { mode: 'trust', topic: 'money', text: 'All of it.' }, { kind: 'owner', agentId: 'ag_1' }), (error: Error) => (error.message === SAVE_TOPIC_PERSON_ONLY || /security texts/.test(error.message)) && /Trust AI mode/.test(error.message), 'in its own words (rpc-guard.ts or this handler)');
    await assert.rejects(() => r.call('security.saveTopic', { mode: 'trust', topic: 'money', text: 'x' }, { kind: 'device', deviceId: 'd1', capabilities: ['settings'], secure: false }), /scope: insecure/);
    const back = await r.call('security.saveTopic', { mode: 'trust', topic: 'money', text: null }, PHONE) as { isDefault: boolean };
    assert.equal(back.isDefault, true);
    await assert.rejects(() => r.call('security.saveTopic', { mode: 'trust', topic: 'nonsense', text: 'x' }, PHONE), /topic/);
    await assert.rejects(() => r.call('security.saveTopic', { mode: 'trust', topic: 'money', text: 'x', extra: 1 }, PHONE), /extra|params/);
  } finally { r.done(); }
});
