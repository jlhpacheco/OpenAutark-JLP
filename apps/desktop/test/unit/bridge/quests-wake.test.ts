// The Quests bridge (bridge/quests-wake.ts, 20.11.2026): once, the learned tools and every SYSTEM.md take the new tool names;
// once per agent, an agent with open work gets one wake to sort it into quests – its note lists the work as "## My quests"
// shows it –, an agent without open work is marked and never woken; a second start does nothing. The wake runs only where
// migration 110 converted existing task rows (kv quests/converted) and only for agents hired before that (R1.11).
// Owns: these assertions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { LEARNED_NS } from '../../../src/runtime/tools/learned.ts';
import { CONVERTED, QUESTS_WAKE_NOTE, runQuestsWake, withQuestTools } from '../../../src/runtime/bridge/quests-wake.ts';
import { agent, harness } from '../chat/harness.ts';

function setup() {
  const h = harness();
  Object.assign(h.org, { update: (id: string, patch: Partial<Agent>) => { const next = { ...h.org.require(id), ...patch }; h.org.agents.set(id, next); return next; } });
  h.org.add(agent('ag_ida', 'Ida', { instructions: '# How I work\nMy follow-ups are schedules.remind notes; I give work with tasks.create and close it with tasks.finish.' }));
  h.org.add(agent('ag_jonas', 'Jonas', { instructions: '# How I work\nI keep tasks.listing words as they are.' }));
  return { ...h, s: h.services as RuntimeServices };
}

test('tool names: learned tools and SYSTEM.md texts take the tool that does it now; other words stay', () => {
  assert.equal(withQuestTools('calendar.find_free then calendar.add; tasks.give or tasks.get'), 'calendar.list then tasks.add; tasks.update or tasks.list');
  assert.equal(withQuestTools('my tasks.created file and calendar.list stay'), 'my tasks.created file and calendar.list stay');
  const h = setup();
  new KvRepo(h.db).set(LEARNED_NS, 'ag_ida', { core: ['tasks.get', 'shell.exec', 'tasks.list'], used: ['schedules.remind'] }, 1);
  runQuestsWake(h.s);
  assert.deepEqual(new KvRepo(h.db).get(LEARNED_NS, 'ag_ida'), { core: ['tasks.list', 'shell.exec'], used: ['tasks.remind'] });
  assert.equal(h.org.get('ag_ida')!.instructions, '# How I work\nMy follow-ups are tasks.remind notes; I give work with tasks.add and close it with tasks.update.');
  assert.equal(h.org.get('ag_jonas')!.instructions, '# How I work\nI keep tasks.listing words as they are.');
});

test('R1.11: no wake on a fresh install or where nothing was converted; never for an agent hired after the update', () => {
  const h = setup();
  h.tasks.create({ kind: 'quest', title: 'Windows signing', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.db.run('DELETE FROM wakes');
  runQuestsWake(h.s);
  assert.equal(h.wakeRows().length, 0, 'no conversion mark: nothing from before');
  new KvRepo(h.db).set(CONVERTED.ns, CONVERTED.key, true, h.clock.now());
  h.org.add(agent('ag_nova', 'Nova', { createdAt: h.clock.now() + 60_000 }));
  h.tasks.create({ title: 'First work', assigneeKind: 'agent', assigneeId: 'ag_nova', createdBy: HUMAN_ID });
  h.db.run('DELETE FROM wakes');
  runQuestsWake(h.s);
  assert.deepEqual(h.wakeRows().map((row) => row.agent_id), ['ag_ida'], 'Ida had work before the update; Nova was hired after it');
});

test('one wake per agent with open work, its note listing the work; none without; never twice', () => {
  const h = setup();
  new KvRepo(h.db).set(CONVERTED.ns, CONVERTED.key, true, h.clock.now()); // migration 110 converted this PC's tasks
  const quest = h.tasks.create({ kind: 'quest', title: 'Windows signing', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.db.run('DELETE FROM wakes');
  runQuestsWake(h.s);
  const wakes = h.wakeRows();
  assert.deepEqual(wakes.map((row) => [row.agent_id, row.reason]), [['ag_ida', 'schedule']]);
  assert.ok(wakes[0].note!.startsWith(`${QUESTS_WAKE_NOTE}\n- Windows signing · ${quest.id} · `), wakes[0].note!);
  h.db.run('DELETE FROM wakes');
  h.tasks.create({ title: 'Later work', assigneeKind: 'agent', assigneeId: 'ag_jonas', createdBy: HUMAN_ID });
  h.db.run('DELETE FROM wakes');
  runQuestsWake(h.s);
  assert.equal(h.wakeRows().length, 0, 'every agent was marked at the first start');
  assert.doesNotMatch(QUESTS_WAKE_NOTE, /\b(you|your|must|may|allowed|only if)\b/i);
});
