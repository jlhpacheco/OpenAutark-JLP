// Umzug 21.11.2026 – going on when an agent's PC is gone (devices/sync/takeover.ts, agents/move.ts): with a due wake and its
// PC out of reach here for 2 minutes, the online PC with the smallest id among those the agent is at home on (Agent.homes)
// writes itself as the agent's PC through the org service (the row travels), logs one line and the agent reads one line;
// not under 2 minutes, not without homes, not on a PC that is none of them, and (part 2) only where the agent's record was
// complete and settled when the contact broke – else she waits for her PC (one info line, no note, the wake goes to her
// PC when it is back); a PC holding the wake that is not the smallest hands it to that one, which takes her (review H3);
// her schedule alone is armed on that PC once her PC is away 2 minutes (review M4). The old PC learns the new
// PC from the row when it is back and ends what it runs; the agent hears once that it stays.
// Owns: these assertions only. Never: real timers, network or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agent, FakeTimers } from '../chat/harness.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { awake, homeElsewhere, linkMark, SETTLED_NS, TAKEOVER_MS } from '../../../src/runtime/devices/sync/home.ts';
import { standing } from '../../../src/runtime/devices/sync/settled-state.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { placeSchedules } from '../../../src/runtime/devices/sync/tables.ts';
import { startMoves } from '../../../src/runtime/agents/move.ts';
import { homeOnOwnPcs } from '../../../src/runtime/agents/own-homes.ts';
import { takeRepairNotes } from '../../../src/runtime/agents/turn-finish.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { MemoryLogger } from '../fakes.ts';
import { RESOURCES } from '../store/helpers.ts';
import { link, makePc, Net, settle, type Pc } from './sync-net.ts';

const MARA = 'ag_mara';

/** A fake PC with the real org (its agents rows travel), a log, a dispatcher whose leave is recorded, and the moves on fake timers. */
function pcOf(net: Net, id: string, home: string, extra: Partial<Agent> = {}) {
  const pc = makePc(net, id);
  pc.h.services.org = new Org({ db: pc.h.db, bus: pc.h.bus, clock: pc.h.clock, templatesDir: path.join(RESOURCES, 'agents') });
  const log = new MemoryLogger();
  pc.h.services.log = log;
  const left: string[] = [];
  pc.h.services.dispatcher = { ...pc.h.services.dispatcher, leave: async (agentId: string) => { left.push(agentId); return true; } } as RuntimeServices['dispatcher'];
  new AgentRepo(pc.h.db).save(agent(MARA, 'Mara', { ...(home === id ? {} : { deviceId: home }), ...extra }));
  const timers = new FakeTimers();
  return Object.assign(pc, { log, left, timers, start: () => startMoves(pc.h.services, { timers }) });
}

const taken = (pc: Pc & { log: MemoryLogger }) => pc.log.entries.filter((entry) => entry.message === 'agent taken over');
const stays = (pc: Pc & { log: MemoryLogger }) => pc.log.entries.filter((entry) => entry.message === 'agent waits for its PC, its record was not complete here');
/** Mara is at home on these PCs. */
const HOMES = { homes: ['dev_h', 'dev_b', 'dev_c'] };
/** `pc` holds what dev_h last announced: Mara's record is complete and settled here (ledger-settled.ts keeps it; sync-ledger-settled.test.ts). */
const settled = (pc: Pc) => {
  const now = pc.h.clock.now();
  awake(pc.h.db, now);
  new KvRepo(pc.h.db).set(SETTLED_NS, `dev_h/${MARA}`, { head: 0, state: standing(pc.h.db, MARA), mark: linkMark(pc.h.db, 'dev_h', now), held: true }, now);
};
/** `ms` pass on `pc` while its runtime stays awake (the record sync's heartbeat every 10 s; one jump would be a PC that slept). */
const pass = (pc: Pc, ms: number) => { for (let left = ms; left > 0; left -= 10_000) { pc.h.clock.advance(Math.min(left, 10_000)); awake(pc.h.db, pc.h.clock.now()); } };
const away = (net: Net, id: string) => net.pcs.delete(id);

test('takeover: after 2 minutes out of reach with a due wake, the smallest online PC she is at home on goes on with her from her settled record; not before', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h', { homes: ['dev_c'] });
  const c = pcOf(net, 'dev_c', 'dev_h', { homes: ['dev_c'] });
  link(h, c);
  const offs = [h.start(), c.start()];
  settled(c);
  away(net, 'dev_h');
  c.h.wakes.wake({ agentId: MARA, reason: 'manual', note: 'the weekly report' });
  await settle();
  assert.equal(c.h.wakes.pending(MARA), 1, 'it waits here');
  pass(c, TAKEOVER_MS - 1_000);
  c.timers.fire();
  assert.equal(taken(c).length, 0, 'under 2 minutes: nobody takes it');
  assert.equal(homeElsewhere(c.h.services, MARA), 'dev_h');

  pass(c, 1_000);
  c.timers.fire();
  await settle();
  assert.equal(homeElsewhere(c.h.services, MARA), undefined, 'it runs here now');
  assert.deepEqual(taken(c).map((entry) => entry.data), [{ agentId: MARA, from: 'dev_h' }]);
  assert.equal(c.h.wakes.pending(MARA), 1, 'its wake runs here');
  assert.equal(c.timers.pending.length, 0, 'nothing waits any more: no timer');
  const notes = takeRepairNotes(c.h.services, MARA, 'main');
  assert.equal(notes.length, 1, 'one line, the arrival\'s replaced');
  assert.match(notes[0], /^My PC dev_h has not been reachable since \d\d:\d\d; my record was complete here, so I go on on dev_c\. Files and programs that only dev_h has are out of reach until it is back\.$/);
  assert.deepEqual(c.h.services.org.get(MARA)?.homes, ['dev_c', 'dev_h'], 'the PC she left stays one of her homes');
  for (const off of offs) off();
});

test('0.3.20: a NEW agent set at home on the person\'s own PCs (agents/own-homes.ts) is taken over by the other PC with no one naming homes', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h');
  const c = pcOf(net, 'dev_c', 'dev_h');
  link(h, c);
  const offs = [h.start(), c.start()];
  assert.equal(h.h.services.org.get(MARA)?.homes, undefined, 'no homes named: before 0.3.20 she would wait for her PC');
  const made = homeOnOwnPcs(h.h.services, h.h.services.org.get(MARA)!, { by: 'system', reason: 'new agent' });
  assert.deepEqual(made.homes, ['dev_h', 'dev_c'], 'this PC and the linked own PC');
  c.h.services.org.update(MARA, { homes: made.homes }); // the row as it reaches dev_c
  settled(c);
  away(net, 'dev_h');
  c.h.wakes.wake({ agentId: MARA, reason: 'manual', note: 'the weekly report' });
  await settle();
  pass(c, TAKEOVER_MS);
  c.timers.fire();
  await settle();
  assert.deepEqual(taken(c).map((entry) => entry.data), [{ agentId: MARA, from: 'dev_h' }], 'dev_c goes on with her');
  assert.equal(homeElsewhere(c.h.services, MARA), undefined);
  assert.deepEqual(c.h.services.org.get(MARA)?.homes, ['dev_h', 'dev_c'], 'the PC she left stays one of her homes');
  for (const off of offs) off();
});

test('0.3.20: an agent that exists keeps what it has – homeOnOwnPcs leaves one with homes alone; a PC alone writes nothing', () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h', { homes: ['dev_x'] });
  assert.deepEqual(homeOnOwnPcs(h.h.services, h.h.services.org.get(MARA)!, { by: 'system' }).homes, ['dev_x']);
  const alone = pcOf(new Net(), 'dev_a', 'dev_a');
  assert.equal(homeOnOwnPcs(alone.h.services, alone.h.services.org.get(MARA)!, { by: 'system' }).homes, undefined, 'no other own PC: homes stay empty');
});

test('part 2: the contact broke while she was at work there or rows were owed – nobody takes her, one info line, no note; her PC back takes the wake', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h', HOMES);
  const c = pcOf(net, 'dev_c', 'dev_h', HOMES);
  link(h, c);
  const offs = [h.start(), c.start()];
  away(net, 'dev_h'); // nothing settled is held here: 'busy' or a newer row cleared it, or it was never announced
  pass(c, TAKEOVER_MS * 2);
  c.h.wakes.wake({ agentId: MARA, reason: 'manual', note: 'while her PC is gone' });
  await settle();
  c.sync.resume(); // her wake is looked at again
  await settle();
  assert.equal(taken(c).length, 0, 'she waits for her PC');
  assert.equal(homeElsewhere(c.h.services, MARA), 'dev_h');
  assert.deepEqual(stays(c).map((entry) => entry.data), [{ agentId: MARA, pc: 'dev_h' }], 'one info line');
  assert.equal(c.h.wakes.pending(MARA), 1, 'her wake waits here');
  assert.deepEqual(takeRepairNotes(c.h.services, MARA, 'main'), [], 'no note');
  assert.equal(c.timers.pending.length, 0, 'and nothing looks again for her');

  net.pcs.set('dev_h', h); // back: the normal path
  c.sync.resume('dev_h');
  await settle();
  assert.equal(c.h.wakes.pending(MARA), 0, 'the wake went to her PC');
  assert.ok(h.h.wakeRows().some((wake) => wake.agent_id === MARA && wake.note === 'while her PC is gone'));
  assert.equal(taken(c).length, 0);
  for (const off of offs) off();
});

test('part 2: a PC she is not at home on never takes her, even with her whole record', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h', { homes: ['dev_h', 'dev_x'] });
  const c = pcOf(net, 'dev_c', 'dev_h', { homes: ['dev_h', 'dev_x'] });
  link(h, c);
  const off = c.start();
  settled(c);
  away(net, 'dev_h');
  pass(c, TAKEOVER_MS * 2);
  c.h.wakes.wake({ agentId: MARA, reason: 'manual' });
  await settle();
  assert.equal(taken(c).length, 0);
  assert.equal(stays(c).length, 0, 'not a matter of her record');
  assert.equal(c.h.wakes.pending(MARA), 1);
  assert.equal(c.timers.pending.length, 0);
  off();
});

test('takeover (review H3): the wake sits on C, B has the smaller id – C hands it to B, which goes on with her; never without homes', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h', HOMES);
  const b = pcOf(net, 'dev_b', 'dev_h', HOMES);
  const c = pcOf(net, 'dev_c', 'dev_h', HOMES);
  link(h, b); link(h, c); link(b, c);
  const offs = [b.start(), c.start()];
  settled(b);
  away(net, 'dev_h');
  c.h.wakes.wake({ agentId: MARA, reason: 'manual', note: 'the person wrote on C' });
  await settle();
  assert.equal(c.h.wakes.pending(MARA), 1, 'under 2 minutes it waits on C');
  pass(b, TAKEOVER_MS);
  pass(c, TAKEOVER_MS);
  c.timers.fire();
  await settle();
  assert.equal(taken(c).length, 0, 'C does not take her: B has the smaller id and is online');
  assert.equal(c.h.wakes.pending(MARA), 0, 'C handed the wake to B');
  assert.deepEqual(taken(b).map((entry) => entry.data), [{ agentId: MARA, from: 'dev_h' }], 'B goes on with her');
  assert.ok(b.h.wakeRows().some((wake) => wake.agent_id === MARA && wake.note === 'the person wrote on C'), 'with the wake');
  assert.equal(homeElsewhere(b.h.services, MARA), undefined);
  assert.equal(homeElsewhere(c.h.services, MARA), 'dev_b', 'the row reached C');
  assert.equal(c.timers.pending.length, 0, 'C waits for nothing any more');
  for (const off of offs) off();

  const net2 = new Net(); // no homes (the default)
  const h2 = pcOf(net2, 'dev_h', 'dev_h');
  const c2 = pcOf(net2, 'dev_c', 'dev_h');
  link(h2, c2);
  const off2 = c2.start();
  settled(c2);
  away(net2, 'dev_h');
  pass(c2, TAKEOVER_MS * 2);
  c2.h.wakes.wake({ agentId: MARA, reason: 'manual' });
  await settle();
  assert.equal(taken(c2).length, 0, 'at home on no other PC: she waits for her PC');
  assert.equal(c2.h.wakes.pending(MARA), 1);
  assert.equal(c2.timers.pending.length, 0, 'and nothing looks again for her');
  off2();
});

test('takeover (review M4): her schedule alone – armed on the PC that goes on with her once her PC is away 2 minutes, not before, not after it is back', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h', HOMES);
  const c = pcOf(net, 'dev_c', 'dev_h', HOMES);
  link(h, c);
  const off = c.start();
  settled(c);
  const daily = c.h.scheduler.create({ ownerId: MARA, kind: 'reminder', title: 'Daily report', spec: { everyMs: 86_400_000 }, payload: {} });
  await settle();
  placeSchedules(c.h.services);
  const due = () => c.h.db.get<{ next_at: number | null }>('SELECT next_at FROM schedules WHERE id = ?', [daily.id])?.next_at ?? null;
  assert.equal(due(), null, 'it fires on H while H is there');

  away(net, 'dev_h');
  const repo = new DevicesRepo(c.h.db);
  repo.patch('dev_h', { status: 'offline', lastSeenAt: c.h.clock.now() });
  c.h.bus.emit('device.upserted', { ...repo.get('dev_h')!, status: 'offline' });
  assert.equal(due(), null, 'under 2 minutes: not yet');
  pass(c, TAKEOVER_MS);
  c.timers.fire();
  assert.notEqual(due(), null, 'C fires it now: its wake makes C go on with her');
  assert.equal(c.timers.pending.length, 0, 'placed once, nothing more to look at');

  net.pcs.set('dev_h', h);
  repo.patch('dev_h', { status: 'online', lastSeenAt: c.h.clock.now() });
  placeSchedules(c.h.services); // a link that comes up places them again (service.ts)
  assert.equal(due(), null, 'H is back: it fires there again');
  off();
});

test('the old PC back: it learns the new PC from the row and ends what it runs; the agent hears once that it stays', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h', HOMES);
  const c = pcOf(net, 'dev_c', 'dev_h', HOMES);
  link(h, c);
  const offs = [h.start(), c.start()];
  settled(c);
  away(net, 'dev_h');
  pass(c, TAKEOVER_MS);
  c.h.wakes.wake({ agentId: MARA, reason: 'manual' });
  await settle();
  assert.equal(taken(c).length, 1);

  net.pcs.set('dev_h', h); // back
  assert.ok(await c.sync.catchUp('dev_h', undefined));
  await settle();
  assert.equal(homeElsewhere(h.h.services, MARA), 'dev_c', 'H knows she runs on C now');
  assert.deepEqual(h.left, [MARA], 'H ends what it runs of her');
  const record = new DevicesRepo(c.h.db).get('dev_h')!;
  c.h.bus.emit('device.upserted', { ...record, status: 'online' });
  const notes = takeRepairNotes(c.h.services, MARA, 'main');
  assert.equal(notes.length, 2, 'the takeover line and the back line stand together (two kinds)');
  assert.match(notes[0], /^My PC dev_h has not been reachable since/);
  assert.equal(notes[1], 'dev_h is reachable again; I stay on dev_c.');
  c.h.bus.emit('device.upserted', { ...record, status: 'online' });
  assert.deepEqual(takeRepairNotes(c.h.services, MARA, 'main'), [], 'once');
  for (const off of offs) off();
});

test('one spelling for "this PC": an agents row that names this PC\'s own id is stored without one', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h');
  const c = pcOf(net, 'dev_c', 'dev_h');
  link(h, c);
  h.h.services.org.update(MARA, { deviceId: 'dev_c' }); // the move is made on H
  await settle();
  assert.equal(c.h.db.get<{ device_id: string | null }>('SELECT device_id FROM agents WHERE id = ?', [MARA])?.device_id, null, 'C stores it as itself (NULL)');
  assert.equal(homeElsewhere(c.h.services, MARA), undefined);
  assert.equal(homeElsewhere(h.h.services, MARA), 'dev_c');
  await settle();
  assert.equal(net.calls.filter((call) => call.from === 'dev_c' && call.method === 'sync.rows' && JSON.stringify(call.params).includes(MARA)).length, 0, 'no echo back to H');
});

test('part 2: an agent with homes that moves keeps the PC it left as one of them; one without homes gets none', async () => {
  const net = new Net();
  const h = pcOf(net, 'dev_h', 'dev_h', { homes: ['dev_c'] });
  const c = pcOf(net, 'dev_c', 'dev_h', { homes: ['dev_c'] });
  link(h, c);
  const off = h.start();
  h.h.services.org.update(MARA, { deviceId: 'dev_c' }); // the app's "Works on", made on H
  await settle();
  assert.deepEqual(h.left, [MARA]);
  assert.deepEqual(h.h.services.org.get(MARA)?.homes, ['dev_c', 'dev_h'], 'the set of her homes stays the same');
  await settle();
  assert.deepEqual(c.h.services.org.get(MARA)?.homes, ['dev_c', 'dev_h'], 'and it travels');
  off();

  const net2 = new Net();
  const h2 = pcOf(net2, 'dev_h', 'dev_h');
  const c2 = pcOf(net2, 'dev_c', 'dev_h');
  link(h2, c2);
  const off2 = h2.start();
  h2.h.services.org.update(MARA, { deviceId: 'dev_c' });
  await settle();
  assert.equal(h2.h.services.org.get(MARA)?.homes, undefined);
  off2();
});
