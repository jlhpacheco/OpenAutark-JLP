// Owns: the one cut-off note (interruptionNote: `[note · <time>] My last turn here was cut off at <time> (<why>).` and what
// it already did) and the one label of every note (noteLines), through real persisted runs and the turn input builder.
// Never: uses live engines, accounts, network connections or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { CRASH_ERROR } from '../../../src/runtime/store/runs.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { BRIEF_INTERRUPTION_MS, interruptionNote, recordTurnInput } from '../../../src/runtime/agents/interruption-context.ts';
import { RECAP_TITLE } from '../../../src/runtime/context/recent-actions.ts';
import { INTERRUPTED_NOTE } from '../../../src/runtime/tasks/recover-notes.ts';
import { buildTurn, noteLines, planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { noteLabel } from '../../../src/runtime/agents/note-label.ts';
import { dueText } from '../../../src/runtime/context/time.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { setup } from './fixture.ts';

async function rig() {
  const h = setup();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.services.runs = runs;
  const original = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Export the report' });
  const request = h.request({ runId: 'run_old' });
  const plan = (await planTurn(h.services, request))!;
  runs.start({ id: request.runId, agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  recordTurnInput(h.services, plan, request, original.seq);
  const fail = (error = 'Internet connection lost') => runs.finish(request.runId, { status: 'failed', error });
  const next = h.request({ runId: 'run_next', reason: 'retry' });
  const context = (patch = {}, recap?: string) => interruptionNote(h.services, plan, { ...next, ...patch }, h.chats.messages(h.chat.id, { limit: 1 })[0].seq, 'UTC', recap);
  return { ...h, journal: runs, original, plan, fail, next, context };
}

test('a short retry with unchanged input adds no interruption narrative – only the recap, when there is one', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(BRIEF_INTERRUPTION_MS - 1);
  assert.equal(h.context(), undefined);
  const recap = `${RECAP_TITLE}\n- 10:00 files.write: a.txt → done`;
  assert.equal(h.context({}, recap), `${noteLabel(h.clock.now(), 'UTC')} My last turn here was cut off.\n${recap}`);
});

test('a longer pause puts one note with the real cause and the time since before the actual input; the recovery wake note is folded in', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(BRIEF_INTERRUPTION_MS);
  h.services.context.delta = () => ({ text: 'CEO: Export the report', images: [], lastSeq: h.original.seq });
  const retry = { ...h.next, notes: [{ at: h.clock.now(), text: INTERRUPTED_NOTE, reason: 'retry' as const }] };
  const turn = await buildTurn(h.services, h.plan, retry, h.route, []);
  const text = turn.input.map(part => part.type === 'text' ? part.text : '').join('');
  assert.match(text, /\[note · [^\]]+\] My last turn here was cut off at \w{3} \d+ \w{3} \d{2}:\d{2} \(Internet connection lost\)\./);
  assert.ok(text.indexOf('cut off at') < text.indexOf('CEO: Export the report'), 'the note comes before the input');
  assert.ok(!text.includes(INTERRUPTED_NOTE), 'one note, not two');
  assert.equal(text.split('cut off').length, 2, 'said once');
});

test('a new CEO message and a cron event are visible even during a brief interruption', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(1000);
  const cronAt = h.clock.now();
  h.clock.advance(1000);
  const message = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'What is happening?' });
  const context = h.context({ reason: 'message', notes: [{ at: cronAt, text: 'Send the invoice', reason: 'schedule' }] })!;
  assert.match(context, /My last turn here was cut off at [^(]+\(Internet connection lost\)\.$/, 'new input since: the cut is said');
  assert.ok(message.seq > 0);
  assert.doesNotMatch(context, /What is happening\?|Send the invoice/, 'the lines and notes come below as themselves');
});

test('status lines and failed own replies are not new input', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(1000);
  h.chats.status(h.chat.id, { type: 'note', text: 'Retrying interrupted work' });
  h.chats.postAgentMessage(h.chat.id, h.tom.id, 'run_old', { body: 'Partial answer', state: 'failed' });
  assert.equal(h.context(), undefined);
});

test('editing the original message is changed input', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(1000);
  h.chats.edit(h.original.id, 'Do not export; preview it first', 'human');
  assert.match(h.context()!, /cut off at [^(]+\(Internet connection lost\)/, 'an edited line is new input');
});

test('a changed task is input; ownership bookkeeping alone is not', async () => {
  const h = await rig();
  const task = h.tasks.create({ title: 'Export report', notes: 'October', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  h.plan.task = task;
  recordTurnInput(h.services, h.plan, h.request({ runId: 'run_old' }), h.original.seq);
  h.fail();
  h.clock.advance(1000);
  h.plan.task = { ...task, ledger: { ...task.ledger, movedAt: h.clock.now() } };
  assert.equal(h.context(), undefined);
  h.plan.task = { ...task, notes: 'November instead' };
  assert.match(h.context()!, /cut off at [^(]+\(Internet connection lost\)/, 'a changed task is new input');
});

test('a chat-free event gets restart context only for its own source', async () => {
  const h = await rig();
  const request = h.request({ runId: 'run_mail', conversationId: undefined, reason: 'event', origin: { source: 'mail:inbox', label: 'New mail' } });
  const plan = (await planTurn(h.services, request))!;
  h.journal.start({ id: request.runId, agentId: h.tom.id, trigger: 'event', origin: request.origin });
  recordTurnInput(h.services, plan, request, 0);
  h.clock.advance(3600_000);
  h.journal.reconcile();
  const retry = { ...request, runId: 'run_mail_retry' };
  assert.match(interruptionNote(h.services, plan, retry, 0, 'UTC')!, /\(the app restarted\)/);
  const other = { ...plan, origin: { source: 'mail:other', label: 'Other inbox' }, thread: 'src:mail:other' };
  assert.equal(interruptionNote(h.services, other, retry, 0, 'UTC'), undefined);
});

test('restart uses the last recorded activity, never pretends the restart time is the crash time', async () => {
  const h = await rig();
  h.clock.advance(2 * 3600_000);
  h.journal.reconcile();
  assert.equal(h.journal.get('run_old')?.error, CRASH_ERROR);
  const context = h.context()!;
  const started = h.journal.get('run_old')!.startedAt!;
  assert.ok(context.includes(`cut off at ${dueText(started, 'UTC', h.clock.now())} (the app restarted).`), context);
});

test('success clears the interruption context and another thread never inherits it', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(120_000);
  const other = h.chats.create({ agentIds: [h.tom.id], createdBy: 'human' });
  const otherPlan = (await planTurn(h.services, h.request({ conversationId: other.id })))!;
  assert.equal(interruptionNote(h.services, otherPlan, h.next, 0, 'UTC'), undefined);
  h.journal.start({ id: 'run_done', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'retry' });
  h.journal.finish('run_done', { status: 'done' });
  assert.equal(h.context(), undefined);
});

test('repeated failures retain the original pause and redact the cause', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(3600_000);
  h.journal.start({ id: 'run_retry', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'retry' });
  recordTurnInput(h.services, h.plan, { ...h.next, runId: 'run_retry' }, h.original.seq);
  h.journal.finish('run_retry', { status: 'failed', error: 'Limit secret-value reached' });
  h.services.secrets.redact = text => text.replaceAll('secret-value', '[redacted]');
  h.clock.advance(1000);
  const context = h.context()!;
  assert.match(context, /Limit \[redacted\] reached/);
  assert.doesNotMatch(context, /secret-value/);
});

test('actual attempts persist only input coordinates; a resumed builder sees them', async () => {
  const h = setup();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.services.runs = runs;
  h.services.router = { route: async () => h.route } as typeof h.services.router;
  const message = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Export the report' });
  h.services.context.delta = () => ({ text: 'CEO: Export the report', images: [], lastSeq: message.seq });
  h.state.script = async () => ({ text: '', stop: 'error', error: { code: 'unavailable', message: 'Connection lost' } });
  await new TurnExecutor(() => h.services).execute(h.request());
  const marker = new KvRepo(h.db).get<{ lastSeq: number }>('turnInput', `${h.tom.id}:main`);
  assert.equal(marker?.lastSeq, message.seq);
  assert.doesNotMatch(JSON.stringify(marker), /Export the report/);
  h.clock.advance(120_000);
  const request = h.request({ runId: 'run_2', reason: 'retry' });
  const plan = (await planTurn(h.services, request))!;
  const turn = await buildTurn(h.services, plan, request, h.route, []);
  assert.match(turn.input[0].type === 'text' ? turn.input[0].text : '', /Connection lost/);
});

test('merged notes keep per-event attribution; app retries are never the AI\'s own notes', () => {
  const lines = noteLines({ reason: 'message', notes: [
    { text: 'Send the invoice', at: 0, reason: 'schedule' },
    { text: 'The app restarted', at: 1, reason: 'retry' },
  ] }, 'UTC');
  assert.match(lines[0], /^\[note · Thu 1 Jan 00:00 · my schedule\] Send the invoice$/);
  assert.match(lines[1], /^\[note · Thu 1 Jan 00:00\] The app restarted$/, 'one label for every note, never a reason word');
  const scheduled = noteLines({ reason: 'schedule', notes: [{ text: 'Send it', at: 0 }], origin: { source: 'schedule:sch_1' } as never }, 'UTC', undefined, 'Weekly invoice');
  assert.match(scheduled[0], /^\[note · [^·]+ · my schedule sch_1 "Weekly invoice"\] Send it$/, 'a schedule\'s note names it with its title');
  assert.doesNotMatch(lines.join('\n'), /Note from the app|My own scheduled note|retry/);
  const task = { id: 'task_1', title: 'Montagstest 16.11.: Lumo auf Felix\' echtem Android-Handy (Chrome) vorbereiten und prüfen' };
  assert.match(noteLines({ reason: 'task', notes: [{ text: 'I continue this task.', at: 0 }] }, 'UTC', task)[0], /^\[note · [^·]+ · task_1 "Montagstest 16\.11\.: Lumo auf Felix' echtem Android-Handy \(C…"\] I continue/);
  const reminder = noteLines({ reason: 'schedule', notes: [{ text: 'Look again', at: 0 }], origin: { source: 'schedule:sch_1' } as never }, 'UTC', task, 'Weekly invoice');
  assert.match(reminder[0], /^\[note · [^·]+ · task_1 "Montagstest[^"]*"\] Look again$/, 'a reminder about a quest or to-do names it, not the schedule');
  const merged = noteLines({ reason: 'task', notes: [{ text: 'Look again', at: 0, reason: 'schedule' }, { text: 'Felix wrote', at: 0 }] }, 'UTC', task, undefined, 'Now:\nMontagstest · task_1');
  assert.match(merged[0], /\] Look again\nNow:\nMontagstest · task_1$/, 'FIXREAL 5: the snapshot follows the reminder\'s note');
  assert.match(merged[1], /\] Felix wrote$/, 'once, under the reminder only');
});

test('FIXREAL 5: a reminder about a quest brings the quest as it stands now in its own input text – whatever the live block keeps', async () => {
  const h = setup();
  h.services.runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const quest = h.tasks.create({ kind: 'quest', title: 'Einkauf prüfen', doneWhen: 'einkauf.txt ist noch da', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: h.tom.id });
  h.tasks.create({ title: 'Datei ansehen', parentId: quest.id, assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: h.tom.id });
  const request = h.request({ runId: 'run_note', reason: 'schedule', taskId: quest.id, notes: [{ text: 'Jetzt prüfen, ob einkauf.txt noch da ist.', at: h.clock.now(), reason: 'schedule' }], origin: { source: 'schedule:sch_1', label: 'Reminder' } });
  const plan = (await planTurn(h.services, request))!;
  const turn = await buildTurn(h.services, plan, request, h.route, []);
  const text = turn.input.map((part) => part.type === 'text' ? part.text : '').join('');
  assert.ok(text.includes(`"Einkauf prüfen"] Jetzt prüfen, ob einkauf.txt noch da ist.\nNow:\nEinkauf prüfen · ${quest.id} – done when einkauf.txt ist noch da.\nPerson: 0 open\nMe:\n  - "Datei ansehen" · task_`), text);

  // FIXREAL second round 3: a live block that carries the quest's section this turn (a new session) – the note does not repeat it.
  const current = { name: 'task', text: `## Current quest\n${quest.id} · open\nNow:\nEinkauf prüfen · ${quest.id} – done when einkauf.txt ist noch da.` };
  h.services.context.prompt = (() => ({ stable: 'stable', volatile: current.text, sections: [current] })) as never;
  const once = await buildTurn(h.services, plan, request, h.route, []);
  const input = once.input.map((part) => part.type === 'text' ? part.text : '').join('');
  assert.ok(input.includes('"Einkauf prüfen"] Jetzt prüfen, ob einkauf.txt noch da ist.') && !input.includes('\nNow:\n'), input);
  assert.ok(once.prompt.volatile.includes('## Current quest'), 'one copy – in the live block');
});

for (const changed of [true, false]) test(`a same-run failover explains ${changed ? 'new input during the failed attempt' : 'a long reconnect wait'}`, async () => {
  const h = setup();
  h.services.runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.services.accounts.get = id => ({ ...h.account, id });
  let routes = 0;
  h.services.router = { route: async () => {
    if (++routes === 1) return h.route;
    if (!changed) h.clock.advance(120_000);
    return { ...h.route, accountId: 'acc_backup' };
  } } as typeof h.services.router;
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Export the report' });
  h.services.context.delta = () => {
    const messages = h.chats.messages(h.chat.id, { limit: 60 });
    return { text: messages.filter(message => message.authorKind === 'human').map(message => message.body).join('\n'), images: [], lastSeq: messages.at(-1)!.seq };
  };
  let attempts = 0;
  let text = '';
  h.state.script = async input => {
    if (++attempts === 1) {
      if (changed) {
        h.clock.advance(1000);
        h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Preview it first' });
      }
      return { text: '', stop: 'error', error: { code: 'unavailable', message: 'Connection lost mid-turn' } };
    }
    text = input.input.map(part => part.type === 'text' ? part.text : '').join('');
    return { text: 'Continued', stop: 'done' };
  };
  await new TurnExecutor(() => h.services).execute(h.request());
  assert.equal(attempts, 2);
  assert.match(text, /Connection lost mid-turn/);
  assert.match(text, /My last turn here was cut off at [^(]+\(Connection lost mid-turn\)/);
  assert.equal(text.split('cut off').length, 2, 'said once');
});

test('B-080 wave 3: after a graceful-shutdown cut the next turn reads why – "The runtime is shutting down."', async () => {
  const h = await rig();
  h.journal.finish('run_old', { status: 'done' });
  const controller = new AbortController();
  controller.abort(new WorkforceError('cancelled', 'The runtime is shutting down.', { details: { stopKind: 'shutdown' } }));
  const request = h.request({ runId: 'run_cut', signal: controller.signal, control: { lastSeq: 0, steeredSeq: 0, stopKind: 'shutdown' } });
  const plan = (await planTurn(h.services, request))!;
  h.journal.start({ id: 'run_cut', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  finishTurn(h.services, plan, h.routed(), request, h.attempt({ text: '', stop: 'interrupted' }), undefined);
  assert.deepEqual([h.journal.get('run_cut')?.status, h.journal.get('run_cut')?.error], ['interrupted', 'The runtime is shutting down.']);
  h.clock.advance(BRIEF_INTERRUPTION_MS);
  const context = interruptionNote(h.services, plan, h.next, h.original.seq, 'UTC')!;
  assert.match(context, /The runtime is shutting down\./);
  assert.doesNotMatch(context, /The previous attempt was interrupted\./);
});
