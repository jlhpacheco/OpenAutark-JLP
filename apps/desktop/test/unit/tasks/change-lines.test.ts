// Every change stands in the to-do's thread (FIXREAL 3, real run 20.11.2026: the assistant set a time and notes on the
// person's to-do and it had no thread at all; tasks/lifecycle.ts changeText): one quiet line per update for its words,
// time, quest, done-when or notes, with who did it – the person's own change too; none for the runtime's own upkeep or a
// change nobody reads (priority, order); a wait keeps its one line, a change line between them notwithstanding; no
// "(by …)" when the line stands as its agent's own in the thread (FIXREAL2 3); a person's to-do its maker closes as done
// says "Done", one its maker drops is withdrawn quietly, an answered ask ends quietly (FIXREAL2 2).
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { agent, harness } from '../chat/harness.ts';

function setup() {
  const h = harness(); // Sat 17 Oct 2026 09:00 UTC
  h.org.add(agent('ag_mgr', 'Manager'));
  (h.services as RuntimeServices).settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  (h.services.settings as SettingsStore).update({ profile: { name: 'Stanislaus' } } as never);
  const lines = (id: string) => h.chats.get(id) ? h.chats.messages(id, { limit: 100 }).filter((line) => line.kind === 'status').map((line) => line.meta.status?.text) : [];
  return { ...h, lines };
}

test('one line per update with who did it: time and notes together, a day without a clock, a quest move, words and done-when', () => {
  const h = setup();
  const todo = h.tasks.create({ title: 'morgen Paul schreiben, dass wir am Freitag einen Call haben', assigneeKind: 'human', createdBy: HUMAN_ID });
  h.tasks.update(todo.id, { at: Date.UTC(2026, 9, 18, 9, 0), minutes: 10, notes: 'Keine Uhrzeit genannt.' }, 'ag_mgr');
  assert.deepEqual(h.lines(todo.id), ['Time: Sun 18 Oct 09:00, 10 min · Notes updated (by Manager)'], 'one line for the whole update');
  h.tasks.update(todo.id, { at: Date.UTC(2026, 9, 18), minutes: null }, HUMAN_ID);
  assert.equal(h.lines(todo.id).at(-1), 'Day: Sun 18 Oct (by Stanislaus)', 'the person\'s own change is history too');
  const quest = h.tasks.create({ kind: 'quest', title: 'Call mit Paul', assigneeKind: 'human', createdBy: HUMAN_ID });
  h.tasks.update(todo.id, { parentId: quest.id }, 'ag_mgr');
  assert.equal(h.lines(todo.id).at(-1), 'Moved to quest "Call mit Paul" (by Manager)');
  h.tasks.update(todo.id, { parentId: null, title: 'Paul schreiben' }, 'ag_mgr');
  assert.equal(h.lines(todo.id).at(-1), 'Title: "Paul schreiben" · Taken out of its quest (by Manager)');
  h.tasks.update(quest.id, { doneWhen: 'Paul weiß vom Call' }, 'ag_mgr');
  assert.equal(h.lines(quest.id).at(-1), 'Done when: Paul weiß vom Call (by Manager)', 'a quest\'s change stands in the quest\'s thread');
  h.tasks.update(todo.id, { at: null }, 'ag_mgr');
  assert.equal(h.lines(todo.id).at(-1), 'Time removed (by Manager)');
});

test('no line for the runtime\'s own upkeep or for what nobody reads; a status change keeps its own line, and a new reason still replaces the last wait line', () => {
  const h = setup();
  const todo = h.tasks.create({ title: 'Belege sammeln', assigneeKind: 'human', createdBy: HUMAN_ID });
  h.tasks.update(todo.id, { title: 'Belege sammeln (diktiert)', notes: 'Transkript' }, SYSTEM_ID);
  h.tasks.update(todo.id, { priority: 1, sort: 3 }, 'ag_mgr');
  assert.deepEqual(h.lines(todo.id), [], 'the system\'s upkeep and priority/order leave no line');
  h.tasks.update(todo.id, { status: 'waiting', waitingOn: { on: 'outside', why: 'Die Bank schickt den Auszug' }, notes: 'Auszug fehlt' }, 'ag_mgr');
  h.tasks.update(todo.id, { status: 'waiting', waitingOn: { on: 'outside', why: 'Die Bank antwortet nicht' } }, 'ag_mgr');
  assert.deepEqual(h.lines(todo.id), ['Notes updated (by Manager)', 'Waiting: Belege sammeln (diktiert) · Die Bank antwortet nicht'], 'one wait line, the change line kept');
});

test('FIXREAL2 3: a change line that stands as its agent\'s own in the thread names nobody – the person and an agent outside the thread are named', () => {
  const h = setup();
  h.org.add(agent('ag_sara', 'Sara', { template: 'secretary' })); // the person's assistant: the agent of their to-do's thread
  const todo = h.tasks.create({ title: 'morgen Paul schreiben, dass wir am Freitag einen Call haben', assigneeKind: 'human', createdBy: HUMAN_ID });
  h.tasks.update(todo.id, { at: Date.UTC(2026, 9, 18), notes: 'Entwurf: „Hallo Paul, …“' }, 'ag_sara');
  const own = h.chats.messages(todo.id, { limit: 100 }).filter((line) => line.kind === 'status').at(-1)!;
  assert.deepEqual([own.meta.status?.text, own.authorId], ['Day: Sun 18 Oct · Notes updated', 'ag_sara'], 'its author says who: the day once, no echo');
  h.tasks.update(todo.id, { at: Date.UTC(2026, 9, 19) }, HUMAN_ID);
  assert.equal(h.lines(todo.id).at(-1), 'Day: Mon 19 Oct (by Stanislaus)', 'the person\'s line stands as the system\'s: it names them');
  h.tasks.update(todo.id, { title: 'Paul schreiben' }, 'ag_mgr');
  assert.equal(h.lines(todo.id).at(-1), 'Title: "Paul schreiben" (by Manager)', 'an agent outside the thread is named');
  const made = h.tasks.create({ title: 'Belege sammeln', assigneeKind: 'human', createdBy: 'ag_mgr' });
  h.tasks.update(made.id, { doneWhen: 'Alle Belege liegen im Ordner' }, 'ag_mgr');
  assert.equal(h.lines(made.id).at(-1), 'Done when: Alle Belege liegen im Ordner', 'the agent that made it is of its thread');
});

test('FIXREAL2 2: a person\'s to-do its maker closes as done says "Done" in its thread; dropped by its maker it is withdrawn quietly; an answered ask ends quietly', () => {
  const h = setup();
  h.org.add(agent('ag_tessa', 'Tessa'));
  const papers = h.tasks.create({ title: 'Steuerunterlagen und Belege zusammentragen', assigneeKind: 'human', createdBy: 'ag_tessa' });
  h.tasks.finish(papers.id, { status: 'done', summary: 'Belege sind zusammengetragen.' }, 'ag_tessa');
  assert.equal(h.lines(papers.id).at(-1), 'Done: Steuerunterlagen und Belege zusammentragen', 'done on the person\'s word is no withdrawal');
  const form = h.tasks.create({ title: 'Formular ausfüllen', assigneeKind: 'human', createdBy: 'ag_tessa' });
  h.tasks.finish(form.id, { status: 'dropped', summary: 'Nicht mehr nötig' }, 'ag_tessa');
  assert.ok(!h.lines(form.id).some((line) => line?.startsWith('Dropped:')), 'its maker withdrew it: no line');
  const ask = h.tasks.create({ title: 'Welche Bank?', assigneeKind: 'human', createdBy: 'ag_tessa', widget: { type: 'choice', question: 'Welche Bank?', options: ['Sparkasse', 'GLS'] } });
  h.tasks.answer({ taskId: ask.id, answer: { choice: 'GLS' }, by: HUMAN_ID });
  assert.equal(h.tasks.get(ask.id)!.status, 'done');
  assert.ok(!h.lines(ask.id).some((line) => line?.startsWith('Done:')), 'the person\'s own answer says it');
});
