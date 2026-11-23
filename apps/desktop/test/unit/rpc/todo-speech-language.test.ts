import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../../src/runtime/rpc/handlers/system.ts';
import { HandlerTable, scopeDenial, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';

const table = new HandlerTable();
register(table);
const entry = table.get('todos.speechLanguage')!;
const device: ClientScope = { kind: 'device', deviceId: 'dev_test', capabilities: ['todo'], secure: true };
const project = (language: unknown) => entry.handler(undefined, {
  scope: device,
  services: { settings: { get: () => ({ profile: { language, name: 'Example' }, unrelated: 'not for the Bubble' }) } } as unknown as RuntimeServices,
  extras: {} as HandlerContext['extras'],
  topics: new Set(),
  signal: new AbortController().signal,
});

test('the To-do Bubble gets only the locale base tag', async () => {
  assert.deepEqual(await project('de_AT'), { language: 'de-AT' });
  assert.deepEqual(await project('en'), { language: 'en' });
  assert.deepEqual(await project('en-US-x-example'), { language: 'en-US' });
});
test('a missing or invalid locale requests the phone default', async () => {
  for (const bad of ['und', 'de--AT', 'de/AT', ' ', 'en-' + 'q'.repeat(70), undefined, {}]) {
    assert.deepEqual(await project(bad), { language: null });
  }
});
test('the narrow endpoint keeps the To-do capability and is closed to other callers', () => {
  assert.equal(scopeDenial(entry.scope, device), undefined);
  assert.equal(scopeDenial(entry.scope, { kind: 'owner', person: true }), undefined);
  assert.equal(scopeDenial(entry.scope, { ...device, capabilities: ['chat'] }), 'scope');
  assert.equal(scopeDenial(entry.scope, { kind: 'person', personId: 'p', deviceId: 'd', tokenId: 't', role: 'ceo' }), 'scope');
  assert.equal(scopeDenial(entry.scope, { kind: 'external', memberId: 'm', conversationId: 'c', tokenId: 't' }), 'scope');
});
