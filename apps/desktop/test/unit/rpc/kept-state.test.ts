// Fest round 22.11.2026 (state, not messages): update.state – main's updater, which no method reads – is kept by the RPC
// server (runtime/rpc/server.ts KEPT) from its start, with or without a connection (review: a restarted runtime hears
// main's replay before any port connects), and a phone's or browser's connection that joins the 'system' topic gets the
// last one at once, so it knows after every (re)connect whether an update waits. Only the newest is kept; joining a topic
// it already has sends nothing again; the owner's clients (the window, a CLI's `wf events system`) and a connection that
// may not see it get nothing kept. The rhythm's internal 'sync.round' never reaches any client (scopes.ts BUS_ONLY).
// Owns: these assertions only. Never: a real transport or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../../../src/runtime/bus.ts';
import { RpcServer } from '../../../src/runtime/rpc/server.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { mayReceive } from '../../../src/runtime/rpc/scopes.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { EventName } from '../../../src/shared/api/events.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { UpdateState } from '../../../src/shared/model/system.ts';
import { register as system } from '../../../src/runtime/rpc/handlers/system.ts';
import { nullLogger } from '../fakes.ts';
import { OWNER, PHONE, TestClient, fakeExtras, settle } from './s1-helpers.ts';

const EXTERNAL: ClientScope = { kind: 'external', memberId: 'ext:api:k1:Bot', conversationId: 'ch_a', tokenId: 'tok_1' };
const CLI: ClientScope = { kind: 'owner' };

function state(status: UpdateState['status'], availableVersion?: string): UpdateState {
  return { status, version: '0.3.17', percent: 0, automaticInstall: false, ...(availableVersion ? { availableVersion } : {}) };
}

function setup() {
  const bus = new Bus((error) => { throw error; });
  const services = { bus, log: nullLogger, clock: { now: () => 1000 } } as unknown as RuntimeServices;
  const table = new HandlerTable();
  system(table);
  const server = new RpcServer({ services: () => services, extras: () => fakeExtras(), table, log: nullLogger });
  return { bus, server };
}

test('kept from the start: main\'s replay before any connection reaches the first phone at once, the newest only, once', async () => {
  const { bus, server } = setup();
  bus.emit('update.state', state('checking')); // a restarted runtime: main replays its sticky state before any port connects
  bus.emit('update.state', state('available', '0.3.18'));

  const phone = new TestClient(server, PHONE);
  await phone.call('events.subscribe', { topics: ['system'] });
  await settle();
  assert.deepEqual(phone.events('update.state').map((e) => e.data), [state('available', '0.3.18')], 'only the newest, right after the subscribe');

  await phone.call('events.subscribe', { topics: ['system', 'chats'] });
  await settle();
  assert.equal(phone.events('update.state').length, 1, 'a topic it already has sends nothing again');

  bus.emit('update.state', state('downloaded', '0.3.18'));
  await settle();
  assert.deepEqual(phone.events('update.state').map((e) => (e.data as UpdateState).status), ['available', 'downloaded'], 'later changes arrive as before');
});

test('every new connection gets it again (a reconnect is a new connection); before any update state nothing is sent', async () => {
  const { bus, server } = setup();
  const first = new TestClient(server, PHONE);
  await first.call('events.subscribe', { topics: ['system'] });
  await settle();
  assert.equal(first.events().length, 0, 'nothing kept yet');

  first.detach();
  bus.emit('update.state', state('available', '0.3.18')); // while no connection is attached
  const again = new TestClient(server, PHONE);
  await again.call('events.subscribe', { topics: ['system'] });
  await settle();
  assert.deepEqual(again.events('update.state').map((e) => (e.data as UpdateState).availableVersion), ['0.3.18']);
});

test('the owner\'s clients (the window, a CLI\'s `wf events system`) and a connection that may not see it get nothing kept', async () => {
  const { bus, server } = setup();
  bus.emit('update.state', state('available', '0.3.18'));
  for (const scope of [OWNER, CLI]) {
    const owner = new TestClient(server, scope);
    await owner.call('events.subscribe', { topics: ['system'] });
    await settle();
    assert.equal(owner.events('update.state').length, 0, `${JSON.stringify(scope)}: only news`);
  }
  const external = new TestClient(server, EXTERNAL);
  await external.request('events.subscribe', { topics: ['system'] }); // refused or allowed – either way no update state reaches it
  await settle();
  assert.equal(external.events('update.state').length, 0);
});

test('the rhythm\'s sync.round stays on the bus: no client hears it, the owner\'s neither', async () => {
  const round = 'sync.round' as EventName;
  for (const scope of [OWNER, CLI, PHONE]) assert.equal(mayReceive(scope, 'system', round, { peer: 'dev_pc' }), false, JSON.stringify(scope));
  const { bus, server } = setup();
  const cli = new TestClient(server, CLI);
  await cli.call('events.subscribe', { topics: ['system'] });
  bus.emit(round, { peer: 'dev_pc' } as never);
  await settle();
  assert.equal(cli.events().length, 0);
});
