// tasks.remind (tools/builtin/tasks-remind.ts, Quests round 20.11.2026) against the real chat/schedule services: a note to
// myself once (at) or repeating (repeat – a routine), in the profile zone, about this turn's work by default; the answer
// echoes the rule and the next runs; nothing is posted; list shows mine and my reports' (with posts), cancel ends my own
// or a report's – never the person's; a note fires as a wake with its words and its task.
// Owns: these assertions only. Never: real timers, network or a real engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { validate } from '../../../src/runtime/tools/validate.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const H = 3_600_000;

function setup(t: { after(fn: () => void): void }) {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_bob', 'Bob'));
  f.services.settings.update({ profile: { timezone: 'Europe/Berlin' } });
  const chat = f.chats.create({ agentIds: ['ag_ava', 'ag_bob'], createdBy: 'human' });
  const remind = taskTools.find((entry) => entry.name === 'tasks.remind')!;
  const call = async (args: Record<string, unknown>, agentId = 'ag_ava', taskId?: string) => {
    assert.deepEqual(validate(args, remind.inputSchema), [], JSON.stringify(args));
    const ctx = { agent: f.org.get(agentId), runId: 'run_1', conversationId: chat.id, taskId, mode: 'general', services: f.services, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
    return remind.run(args, ctx);
  };
  return { f, chat, call };
}

const out = (result: ToolOutput) => result.structured as { noteId: string; rule: string; next: string[]; about?: string };
const textOf = (result: ToolOutput) => String((result.content[0] as { text: string }).text);

test('a note once or repeating, in the profile zone, about this turn\'s work; nothing is posted', async (t) => {
  const { f, chat, call } = setup(t);
  const quest = f.tasks.create({ kind: 'quest', title: 'Windows signing', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  const once = await call({ text: 'Look at Certum.', at: '+2h' }, 'ag_ava', quest.id);
  assert.ok(!once.isError, textOf(once));
  assert.match(out(once).rule, /^once /);
  assert.equal(out(once).about, quest.id, 'about this turn\'s quest');
  const routine = await call({ text: 'Answer the comments.', repeat: { times: ['09:00', '17:30'], days: ['mon', 'tue', 'wed', 'thu', 'fri'] } });
  assert.equal(out(routine).rule, 'daily at 09:00, 17:30 on Mon, Tue, Wed, Thu, Fri');
  for (const at of out(routine).next) assert.match(at, /T(09:00|17:30)\+0[12]:00$/, at);
  const stored = f.scheduler.get(out(routine).noteId)!;
  assert.equal(stored.kind, 'reminder');
  assert.equal(stored.spec.tz, 'Europe/Berlin');
  assert.equal(stored.payload.note, 'Answer the comments.');
  assert.equal(f.chats.messages(chat.id).filter((message) => message.kind === 'status' && message.meta.status?.type === 'schedule_created').length, 0, 'a note is mine alone');
  assert.equal((await call({ text: 'x' })).isError, true, 'a note has one time');
  assert.equal((await call({ text: 'x', at: '+1h', repeat: { every: '1d' } })).isError, true);
  assert.match(textOf(await call({ at: '+1h' })), /text/);
});

test('list shows mine and my reports\' notes and posts; cancel ends mine or a report\'s, never the person\'s', async (t) => {
  const { f, chat, call } = setup(t);
  const bobs = out(await call({ text: 'Check the deadline.', at: '+1h' }, 'ag_bob'));
  const post = f.scheduler.create({ ownerId: 'ag_ava', conversationId: chat.id, kind: 'message', title: 'Weekly numbers', spec: { at: f.clock.now() + 5 * H }, payload: { body: 'Weekly numbers' } });
  const persons = f.scheduler.create({ ownerId: 'human', conversationId: chat.id, kind: 'message', title: 'Hello', spec: { at: f.clock.now() + 5 * H }, payload: { body: 'Hello' } });
  const listed = textOf(await call({ list: true }));
  assert.ok(listed.includes(`- ${bobs.noteId} · note · `) && listed.includes(' · of Bob · Check the deadline.'), listed);
  assert.ok(listed.includes(`- ${post.id} · post · `), listed);
  assert.ok(!listed.includes(persons.id), 'the person\'s post is theirs');
  assert.equal((await call({ cancel: persons.id })).isError, true);
  assert.equal((await call({ cancel: bobs.noteId })).isError, undefined);
  assert.equal(f.scheduler.get(bobs.noteId), undefined);
  f.org.canManage = () => false;
  const theirs = out(await call({ text: 'Mine.', at: '+1h' }, 'ag_bob'));
  assert.equal((await call({ cancel: theirs.noteId })).isError, true, 'not managed: it stays');
});

test('list holds what still runs; my paused and ended ones come with all (owner 21.11.2026)', async (t) => {
  const { f, call } = setup(t);
  const running = out(await call({ text: 'Still on.', at: '+1h' }));
  const paused = out(await call({ text: 'On hold.', repeat: { every: '1d' } }));
  f.scheduler.update(paused.noteId, { active: false }, 'human');
  const ended = f.scheduler.create({ ownerId: 'ag_ava', kind: 'reminder', title: 'Fired once', spec: { at: f.clock.now() + H }, payload: { note: 'Fired once' } });
  f.scheduler.update(ended.id, { active: false });
  const listed = textOf(await call({ list: true }));
  assert.ok(listed.includes(running.noteId), listed);
  assert.ok(!listed.includes(paused.noteId) && !listed.includes(ended.id), 'what no longer runs stays out by default');
  const all = textOf(await call({ list: true, all: true }));
  assert.ok(all.includes(`${paused.noteId} · note · `) && all.includes(' · paused · '), all);
  assert.ok(all.includes(`${ended.id} · note · `) && all.includes(' · ended · '), all);
  f.scheduler.remove(running.noteId);
  assert.equal(textOf(await call({ list: true })), 'No notes or posts that still run.');
});

test('a note fires as a wake with its words and the work it is about', async (t) => {
  const { f, call } = setup(t);
  const quest = f.tasks.create({ kind: 'quest', title: 'Windows signing', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  const note = out(await call({ text: 'Look at Certum.', at: '+1h', about: quest.id }));
  f.scheduler.runNow(note.noteId);
  const wake = f.services.wakes.list('ag_ava').find((item) => item.reason === 'schedule');
  assert.equal(wake?.note, 'Look at Certum.');
  assert.equal(wake?.taskId, quest.id);
});
