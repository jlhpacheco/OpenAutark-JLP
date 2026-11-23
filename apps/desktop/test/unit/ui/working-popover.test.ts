// The chat's live texts as data (chat/live-text.ts modelLine, noteText, liveRuns): a live run's "model · effort" comes from
// the run's live values (B-075: the summary's live runs), before that from the message's meta, never invented; its note
// reads as what the agent does, a context fold's as "Folding its context". Plus the wiring the window relies on (20.11.2026): the header's live line is a button
// for everyone that opens the lines of the live bar above the composer – the one place with steps, Stop and task.
// Owns: these assertions only. Never: renders or reads the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORT_LABEL, FOLD_TEXT, doingOf, liveRuns, modelLine, noteText } from '../../../src/ui/chat/live-text.ts';

test('modelLine: the activity\'s display name and effort; a bare id without a name; the message meta before the activity knows', () => {
  assert.equal(modelLine({ model: 'claude:claude-opus-5-5', modelName: 'Claude Opus 5.5', effort: 'xhigh' }), 'Opus 5.5 · Very high');
  assert.equal(modelLine({ model: 'codex:gpt-6.1-sol', effort: 'medium' }), 'gpt-6.1-sol · Medium', 'no display name: the id without its provider');
  assert.equal(modelLine({ modelName: 'Local Qwen' }), 'Local Qwen', 'no effort: the name alone');
  assert.equal(modelLine({}, { model: 'GPT-6.1 Sol', effort: 'high' }), 'GPT-6.1 Sol · High', 'the streaming message meta while routing');
  assert.equal(modelLine({ modelName: 'Claude Sonnet 5', effort: 'low' }, { model: 'Claude Opus 5.5', effort: 'high' }), 'Sonnet 5 · Low', 'after a failover the activity wins over the first meta');
  assert.equal(modelLine({}, { model: 'GPT-6.1 Sol', effort: 'turbo' }), 'GPT-6.1 Sol', 'an unknown effort word is not shown');
  assert.equal(modelLine(undefined), '', 'routing: an empty slot');
  assert.equal(modelLine({}, { model: 42 }), '');
  assert.deepEqual(Object.keys(EFFORT_LABEL), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('noteText: what the agent does in words, upper case first, else "Working"', () => {
  assert.equal(noteText('bash'), 'Running a command');
  assert.equal(noteText('waiting for approval'), 'Waiting for approval');
  assert.equal(noteText('cutting intro'), 'Cutting intro');
  assert.equal(noteText(''), 'Working');
  assert.equal(noteText('   '), 'Working');
  assert.equal(noteText(undefined), 'Working');
});

test('liveRuns: the chat\'s live bar as the entries the header line reads – its step before its note, model, task', () => {
  const chat = { id: 'c1', working: ['a', 'm', 'r'], live: [
    { runId: 'run_a', agentId: 'a', note: 'bash', model: 'Claude Opus 5.5', effort: 'high', taskId: 'tk_1', startedAt: 30 },
    { runId: 'run_m', agentId: 'm', effort: 'turbo', startedAt: 10 },
    { runId: 'run_r', agentId: 'r', note: 'bash', step: 'Reading a.pdf', startedAt: 40 },
  ] };
  const entries = liveRuns(chat);
  assert.deepEqual(entries[0], { agentId: 'a', runId: 'run_a', conversationId: 'c1', note: 'bash', startedAt: 30, modelName: 'Claude Opus 5.5', effort: 'high', taskId: 'tk_1' });
  assert.deepEqual(entries[1], { agentId: 'm', runId: 'run_m', conversationId: 'c1', note: '', startedAt: 10 }, 'an unknown effort word is left out');
  assert.equal(entries[2]!.note, 'Reading a.pdf', 'its step before its note');
  assert.deepEqual(liveRuns({ id: 'c1' }), [], 'nobody works');
});

const source = (file: string) => readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/chat', file), 'utf8');

test('22.11.2026: a context fold says "Folding its context" instead of its step – in the bar\'s line and the header\'s line', () => {
  assert.equal(doingOf({ step: 'Reading a.pdf', note: 'bash', fold: true }), FOLD_TEXT);
  assert.equal(doingOf({ step: 'Reading a.pdf', note: 'bash' }), 'Reading a.pdf');
  assert.equal(doingOf({ note: 'bash' }), 'bash');
  const [entry] = liveRuns({ id: 'c1', live: [{ runId: 'run_f', agentId: 'a', step: 'Reading a.pdf', startedAt: 1, fold: true }] });
  assert.equal(entry!.note, 'Folding its context');
  assert.equal(noteText(FOLD_TEXT), 'Folding its context');
  assert.match(source('LiveBar.tsx'), /const doing = noteText\(doingOf\(run\)\);/, 'the bar\'s line reads it too');
});

test('wiring: the live line is a button for everyone that opens the chat\'s live bar lines; no popover draws them twice', () => {
  const line = source('LiveLine.tsx');
  assert.ok(!/<span[^>]*class="chat-live[\s"]/.test(line), 'never plain text (its inner .chat-live-text span aside)');
  assert.match(line, /<button type="button" class="chat-live tabular"[^>]*aria-expanded=\{props\.open\}/);
  const header = source('ChatHeader.tsx');
  assert.match(header, /open=\{linesOpen\(runIds\)\} onToggle=\{\(\) => toggleLines\(runIds\)\}/, 'the line opens the bar\'s lines');
  assert.doesNotMatch(header, /Popover/);
  assert.match(source('LiveBar.tsx'), /export function toggleLines\(runIds: readonly string\[\]\): void/);
  const more = source('LiveBarMore.tsx');
  assert.match(more, /run\.taskId && can\('tasks\.get'\)/, 'the task link for whoever may read tasks');
  assert.match(more, /onClick=\{\(\) => openTaskDetail\(task\)\}/);
});
