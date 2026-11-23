// A quest or to-do whole as the agent reads it (context/task-text.ts, Quests round 20.11.2026): its chat, its owner,
// "Done when: not set yet." as a plain fact, a wait with its why, and a time only on the person's to-dos – work among
// agents starts now (VERGESSEN.md finding 1); times in the one absolute form – a day without a time by its day alone.
// Owns: these assertions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { renderTask } from '../../../src/runtime/context/task-text.ts';
import { agent, harness } from '../chat/harness.ts';

test('a to-do whole: its chat and owner, done-when as a fact, no time on agent work', () => {
  const h = harness();
  h.org.add(agent('ag_ida', 'Ida'));
  const chat = h.chats.create({ agentIds: ['ag_ida'], createdBy: HUMAN_ID });
  const todo = h.tasks.create({ conversationId: chat.id, title: 'QR-Code mit Link erzeugen', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID, at: h.clock.now() + 86_400_000 });
  const text = renderTask(h.services as RuntimeServices, h.tasks.get(todo.id)!, 'UTC', '## Current to-do');
  const head = text.split('\n')[1];
  assert.equal(head, `${todo.id} · open · handed over in ${chat.id}`, 'no time on my own work');
  assert.ok(text.includes('Owner: Ida'), text);
  assert.ok(text.includes('Done when: not set yet.'), text);
});

test('the person\'s to-do carries its time and length; a wait keeps its why, since in the one absolute form', () => {
  const h = harness();
  h.org.add(agent('ag_ida', 'Ida'));
  const call = h.tasks.create({ title: 'Anruf Gerlinde', assigneeKind: 'human', createdBy: 'ag_ida', at: Date.UTC(2026, 9, 20, 11, 0), minutes: 30 });
  assert.match(renderTask(h.services as RuntimeServices, h.tasks.get(call.id)!, 'UTC', '## To-do').split('\n')[1], /· at Tue 20 Oct 11:00 for 30 min$/);
  const work = h.tasks.create({ title: 'Montagstest', assigneeKind: 'agent', assigneeId: 'ag_ida', createdBy: HUMAN_ID });
  h.tasks.update(work.id, { status: 'waiting', waitingOn: { on: 'outside', why: 'Warte auf Felix: Handy Mo 7:30 oder nachmittags?' } }, 'ag_ida');
  const text = renderTask(h.services as RuntimeServices, h.tasks.get(work.id)!, 'UTC', '## To-do');
  assert.ok(text.includes('Waiting on something outside since Sat 17 Oct 09:00: Warte auf Felix: Handy Mo 7:30 oder nachmittags?'), text);
});

test('a day without a time reads as its day, never as 00:00', () => {
  const h = harness();
  h.org.add(agent('ag_ida', 'Ida'));
  const day = h.tasks.create({ title: 'Steuerberater anrufen', assigneeKind: 'human', createdBy: 'ag_ida', at: Date.UTC(2026, 9, 21) });
  assert.match(renderTask(h.services as RuntimeServices, h.tasks.get(day.id)!, 'UTC', '## To-do').split('\n')[1], /· at Wed 21 Oct, no time$/);
});
