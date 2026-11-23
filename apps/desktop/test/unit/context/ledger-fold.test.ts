// KI-Runde 17.11.2026 – the ledger's side of the context fold (context/ledger/service.ts fold and lines, capture.ts, store.ts): a
// run's 'Hand-over' note becomes a checkpoint item; fold() pins it for good and hides everything of the agent's own work before
// it by 'fold' – the chat lines, the words the agent posted in a chat, the tasks.update calls that finished a task (Quests round
// 20.11.2026: status done or dropped in their arguments) since the hand-over before it and
// what the agent brought back stay; a hidden item comes back through context.restore like any other; a checkpoint is never
// condensed or hidden by a mark and takes none of the room the agent keeps things in; a later fold takes the earlier hand-over
// out of view, and with it the finishes that hand-over already covers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSetup } from './ledger-fixture.ts';
import { KEEP_PIN, KEEP_TOKENS } from '../../../src/runtime/context/ledger/service.ts';
import { restoreItems } from '../../../src/runtime/context/ledger/restore.ts';
import { rebuildItems } from '../../../src/runtime/agents/rebuild-items.ts';
import { FOLD_REASON } from '../../../src/runtime/context/ledger/window.ts';

type Setup = ReturnType<typeof ledgerSetup>;

/** The hand-over as a fold's turn journals it (agents/context-fold.ts endFold). */
function handOver(t: Setup, runId: string, text: string): void {
  t.journal.item(runId, { kind: 'note', name: 'Hand-over', data: { checkpoint: true, text }, effectStatus: 'none' });
}

test('fold: the hand-over is pinned for good and my own work before it is hidden by fold – lines, finishing tasks.update calls and pins stay', async () => {
  const t = ledgerSetup();
  try {
    const line = t.say('Please build the export');
    const work = t.turn(line.seq);
    t.ourCall(work, 'shell.exec', { command: 'npm run export' }, 'export written to out/export.csv', 'c1');
    t.ourCall(work, 'files.read', { path: 'out/export.csv' }, 'id;name\n1;Ada', 'c2');
    t.ourCall(work, 'knowledge.open', { id: 'skill:csv-export' }, 'How I write exports …', 'c3');
    t.journal.item(work, { kind: 'reasoning', data: { summary: 'Thinking about the header row', live: false }, effectStatus: 'none' });
    t.journal.item(work, { kind: 'note', name: 'Update', data: { text: 'I write the header first.', commentary: true }, effectStatus: 'none' });
    t.ourCall(work, 'files.read', { path: 'inner.txt' }, 'inner', 'exec-1a2b3c4d'); // a call inside a script: nested
    t.ourCall(work, 'files.read', { path: 'keep.md' }, 'what I brought back', 'c4');
    t.ourCall(work, 'tasks.update', { id: 'tsk_1', notes: 'The header row first.' }, 'ok', 'c6'); // an update that ends nothing is work like any other
    t.ourCall(work, 'tasks.update', { id: 'tsk_1', status: 'done', result: 'Export written: 2 rows' }, 'Task done.', 'c5');
    t.journal.item(work, { kind: 'note', name: 'Answer', data: { answer: true, text: 'The export is written.', visibility: 'internal' }, effectStatus: 'none' });
    t.done(work);
    await t.journal.settled();
    const ids = () => Object.fromEntries(t.ledger.items(t.tom.id, 'main').map((item) => [item.title.split(/[ :]/)[0] + (item.nested ? '*' : ''), item.itemId]));
    const kept = t.ledger.items(t.tom.id, 'main').find((item) => item.title.startsWith('File keep.md'))!;
    t.ledger.mark(t.tom.id, 'main', [{ itemId: kept.itemId, state: 'keep', reason: 'context.restore keep', by: 'restore', keep: true }]);

    assert.equal(t.ledger.fold(t.tom.id, 'main', work), undefined, 'a run that left no hand-over folds nothing');
    assert.ok(t.ledger.items(t.tom.id, 'main').every((item) => item.state === 'keep'));

    const fold = t.turn();
    t.journal.item(fold, { kind: 'reasoning', data: { summary: 'What do I need again?', live: false }, effectStatus: 'none' });
    handOver(t, fold, 'I built the export for Alex: out/export.csv, 2 rows. Next: the import.');
    await t.journal.settled();
    const result = t.ledger.fold(t.tom.id, 'main', fold)!;
    const items = t.ledger.items(t.tom.id, 'main');
    const checkpoint = items.find((item) => item.kind === 'checkpoint')!;
    assert.deepEqual(result.checkpoint, [checkpoint.itemId]);
    assert.match(checkpoint.itemId, /^c\d+$/);
    assert.equal(checkpoint.title, 'I built the export for Alex: out/export.csv, 2 rows. Next: the import.');
    assert.equal(checkpoint.pinnedUntil, KEEP_PIN, 'pinned for good');
    const shown = items.filter((item) => item.state !== 'hidden').map((item) => `${item.kind}:${item.title.slice(0, 22)}`);
    assert.deepEqual(shown, [
      'message:Please build the expor', 'file:File keep.md', 'tool:tasks.update: tasks.up', 'checkpoint:I built the export for',
    ].map((entry) => entry), JSON.stringify(shown));
    const hidden = items.filter((item) => item.state === 'hidden');
    assert.equal(result.hidden, hidden.length);
    assert.deepEqual(hidden.map((item) => item.kind).sort(), ['assistant', 'assistant', 'file', 'file', 'reasoning', 'reasoning', 'skill', 'tool', 'tool'], 'the shell call, the file read, the inner call of a script, the skill, both thoughts, my update, the tasks.update that ended nothing and my closing words');
    assert.ok(hidden.every((item) => item.markedBy === 'fold' && item.markReason === FOLD_REASON));
    assert.ok(Object.keys(ids()).length > 0);

    // what a rebuild replays: the line, the finish call with its arguments, what I kept, the hand-over in full
    const replay = rebuildItems(t.ledger.view(t.tom.id, 'main')).items;
    assert.deepEqual(replay.map((item) => item.kind), ['m', 'f', 't', 'c']);
    assert.match(JSON.stringify(replay[2].call?.args), /Export written: 2 rows/);
    assert.equal(replay[3].text, 'I built the export for Alex: out/export.csv, 2 rows. Next: the import.');
    assert.equal(replay[3].role, 'assistant');

    // the way back: a hidden item returns whole, like every hidden item
    const shell = hidden.find((item) => item.kind === 'tool')!;
    const back = restoreItems(t.services, t.tom.id, 'main', { ids: [shell.itemId] });
    assert.match(back, new RegExp(`^Restored ${shell.itemId} –`));
    assert.match(back, /export written to out\/export\.csv/);
    assert.equal(t.ledger.items(t.tom.id, 'main').find((item) => item.itemId === shell.itemId)!.state, 'keep');
  } finally { t.cleanup(); }
});

test('what a fold leaves: my words posted in a chat, and the finishes since my last hand-over – the older ones are that hand-over\'s one line', async () => {
  const t = ledgerSetup();
  try {
    const line = t.say('Please build the export');
    const first = t.turn(line.seq);
    t.ourCall(first, 'tasks.update', { id: 'tsk_export', status: 'done', result: 'Export written: 2 rows' }, 'Task done.', 'c1');
    t.journal.item(first, { kind: 'note', name: 'Answer', data: { answer: true, text: 'The export is written.', visibility: 'notify', messageId: 'msg_1' }, effectStatus: 'none' });
    t.journal.item(first, { kind: 'note', name: 'Answer', data: { answer: true, text: 'A note to myself, posted nowhere.', visibility: 'internal' }, effectStatus: 'none' });
    t.done(first);
    await t.journal.settled();

    const foldOne = t.turn();
    handOver(t, foldOne, 'I built the export for Alex: out/export.csv, 2 rows. The export task is finished. Next: the import.');
    await t.journal.settled();
    t.ledger.fold(t.tom.id, 'main', foldOne);
    const state = (needle: string) => {
      const item = t.ledger.items(t.tom.id, 'main').find((entry) => entry.title.includes(needle))!;
      return [item.state, item.kind];
    };
    assert.deepEqual(state('The export is written'), ['keep', 'assistant'], 'my own line in the chat stays in view, like the others\' lines');
    assert.deepEqual(state('A note to myself'), ['hidden', 'assistant'], 'words that reached no chat are work before the hand-over');
    assert.deepEqual(state('tasks.update'), ['keep', 'tool'], 'the finish since my last hand-over stays');
    assert.deepEqual(t.ledger.lines(t.tom.id, 'main').map((item) => item.kind), ['message', 'assistant'], 'the chat lines of the thread: the person\'s and my posted words');

    // a second piece of work with its own finish, then the next hand-over
    const second = t.turn();
    t.ourCall(second, 'tasks.update', { id: 'tsk_import', status: 'dropped', result: 'Import read back: 2 rows' }, 'Task done.', 'c2');
    t.done(second);
    await t.journal.settled();
    const foldTwo = t.turn();
    handOver(t, foldTwo, 'The export and the import are both done; out/export.csv holds 2 rows. Next: the weekly report.');
    await t.journal.settled();
    t.ledger.fold(t.tom.id, 'main', foldTwo);
    const finishes = t.ledger.items(t.tom.id, 'main').filter((item) => item.title.startsWith('tasks.update'));
    assert.deepEqual(finishes.map((item) => [JSON.stringify(t.ledger.original(t.tom.id, 'main', item.itemId)?.args).includes('tsk_import'), item.state]),
      [[false, 'hidden'], [true, 'keep']], 'the export\'s finish is one line in the first hand-over now; the import\'s stays');
    assert.equal(t.ledger.items(t.tom.id, 'main').find((item) => item.title.includes('The export is written'))!.state, 'keep', 'my posted line still follows the chat lines\' reach, not the fold');
  } finally { t.cleanup(); }
});

test('a hand-over stays whole until a later fold: no mark condenses or hides it, it takes none of my keep room, and the next fold hides it with the work after it', async () => {
  const t = ledgerSetup();
  try {
    const first = t.turn();
    t.ourCall(first, 'shell.exec', { command: 'ls' }, 'a.txt', 'c1');
    // a long hand-over is journaled in parts of 4,000 characters (publishing.ts splitAnswer): eight of them are more than the whole keep room
    for (let part = 1; part <= 8; part++) handOver(t, first, `My first hand-over, part ${part}. ${'x'.repeat(3_960)}`);
    await t.journal.settled();
    assert.equal(t.ledger.fold(t.tom.id, 'main', first)!.checkpoint.length, 8);
    const parts = t.ledger.items(t.tom.id, 'main').filter((item) => item.kind === 'checkpoint');
    assert.ok(parts.every((item) => item.pinnedUntil === KEEP_PIN) && parts.reduce((sum, item) => sum + item.tokens, 0) > KEEP_TOKENS);
    const one = parts[0];
    t.ledger.mark(t.tom.id, 'main', [
      { itemId: one.itemId, state: 'condensed', condensed: 'short', reason: 'old', by: 'subconscious' },
      { itemId: one.itemId, state: 'hidden', reason: 'to fit', by: 'window' },
    ]);
    assert.equal(t.ledger.items(t.tom.id, 'main').find((item) => item.itemId === one.itemId)!.state, 'keep', 'neither the subconscious nor the fit touches it');

    const second = t.turn();
    t.ourCall(second, 'files.read', { path: 'notes.md' }, 'n'.repeat(4_000), 'c2');
    t.done(second);
    await t.journal.settled();
    const note = t.ledger.items(t.tom.id, 'main').find((item) => item.kind === 'file')!;
    assert.match(restoreItems(t.services, t.tom.id, 'main', { ids: [note.itemId], keep: true }), /kept in my context for good\./, 'the hand-over uses none of the room I keep things in');

    const third = t.turn();
    t.ourCall(third, 'shell.exec', { command: 'pwd' }, '/ws', 'c3');
    handOver(t, third, 'My second hand-over: everything from the first that still matters, and what came since.');
    await t.journal.settled();
    const result = t.ledger.fold(t.tom.id, 'main', third)!;
    const items = t.ledger.items(t.tom.id, 'main');
    assert.deepEqual(items.filter((item) => item.state !== 'hidden').map((item) => item.kind), ['file', 'checkpoint'], 'what I kept for good and the new hand-over');
    assert.ok(parts.every((part) => items.find((item) => item.itemId === part.itemId)!.state === 'hidden'), 'the earlier hand-over is folded behind the new one');
    assert.equal(items.find((item) => item.itemId === one.itemId)!.markedBy, 'fold');
    assert.equal(result.checkpoint.length, 1);
    assert.match(restoreItems(t.services, t.tom.id, 'main', { ids: [one.itemId] }), /My first hand-over, part 1/, 'and comes back like any hidden item');
  } finally { t.cleanup(); }
});
