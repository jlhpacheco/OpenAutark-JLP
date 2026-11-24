// 0.3.19, the masked engine shell (tools/builtin/shell-output.ts): a command's output is kept whole per pipe up to its
// budget and masked only as a whole – beyond it its start and its end, each masked whole and cut by a margin at the inner
// edge, so no part of a value the cut split in two shows. Ported from the
// reviewed draft's fixture tests (managed-shell-private-integration/fixture-tests/shell-output.test.mjs), unchanged in substance.
// Owns: these assertions only. Never: a real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellOutput, WITHHELD } from '../../../src/runtime/tools/builtin/shell-output.ts';

const value = 'synthetic-catalog-test-value-not-a-key';
const marked = (text: string) => text.replaceAll(value, 'secret://fixture');

test('a value split across two reads at the visible cap is masked before the cap', () => {
  const capture = new ShellOutput();
  capture.append('x'.repeat(65520) + value.slice(0, 22));
  capture.append(value.slice(22) + '\n');
  const shown = capture.view(true, marked);
  assert.ok(shown.includes('secret://fixture'));
  assert.ok(!shown.includes(value.slice(0, 17)));
  assert.match(shown, /\n… \[output capped\] …\n/);
  assert.ok(shown.endsWith('secret://fixture\n'), 'the end stays visible');
});

test('unfinished or a failing redactor cannot release a raw prefix, also over budget', () => {
  const capture = new ShellOutput();
  capture.append(value.slice(0, 22));
  assert.equal(capture.view(false, marked), WITHHELD);
  assert.equal(capture.view(true, () => { throw new Error('fixture redactor failed'); }), WITHHELD);
  capture.append('x'.repeat(1024 * 1024));
  assert.equal(capture.view(false, marked), WITHHELD);
  assert.equal(capture.view(true, () => { throw new Error('fixture redactor failed'); }), WITHHELD);
});

// 0.3.19 (Noah's review 24.11.2026): over budget a pipe keeps its start and its end – a long build log's error is at the end –
// each masked whole, and the inner edges cut by the margin, so a value the cut split in two never shows in part.
const EDGE = 78 * 1024; // SIDE 30 KB + MARGIN (shell-output.ts)
const MARGIN = 48 * 1024;
test('over budget: the start and the end remain, masked, with the middle left out', () => {
  const capture = new ShellOutput();
  capture.append('START ' + value + '\n');
  for (let i = 0; i < 20; i++) capture.append('log line ' + 'x'.repeat(64 * 1024) + '\n');
  capture.append('ERROR: build failed with ' + value + '\n');
  const shown = capture.view(true, marked);
  assert.ok(shown.startsWith('START secret://fixture\n'), 'the start, masked');
  assert.ok(shown.endsWith('ERROR: build failed with secret://fixture\n'), 'the end with the error, masked');
  assert.match(shown, /\[output too long: \d+ characters, the middle left out\]/);
  assert.ok(!shown.includes(value), 'no raw value');
  assert.ok(shown.length < 70 * 1024, 'within the visible cap');
});

test('over budget: a value cut at the inner edge of the start or of the end never shows in part', () => {
  const atHead = new ShellOutput();
  atHead.append('a'.repeat(EDGE - 11) + value + 'b'.repeat(600 * 1024)); // the start ends 11 characters into the value
  const head = atHead.view(true, marked);
  assert.ok(!head.includes(value.slice(0, 11)) && !head.includes(value.slice(-12)), 'neither part of the value');
  const atTail = new ShellOutput();
  atTail.append('c'.repeat(600 * 1024));
  atTail.append(value + 'd'.repeat(EDGE - 12)); // the end begins 12 characters before the value's end
  const tail = atTail.view(true, marked);
  assert.ok(!tail.includes(value.slice(-12)) && !tail.includes(value.slice(0, 11)), 'neither part of the value');
  assert.ok(tail.endsWith('d'.repeat(EDGE - 12 - MARGIN)), 'the end after the margin');
});

test('over budget: the margin holds where masking shortened a side, so the cut part would come close', () => {
  const short = (text: string) => text.replaceAll(value, '#'); // each whole value becomes one character
  const whole = Math.floor((EDGE - 11) / value.length);
  const atHead = new ShellOutput();
  atHead.append('a'.repeat(EDGE - 11 - whole * value.length) + value.repeat(whole) + value + 'b'.repeat(600 * 1024));
  const head = atHead.view(true, short);
  assert.ok(!head.includes(value.slice(0, 11)), 'not the start of the cut value');
  const atTail = new ShellOutput();
  atTail.append('c'.repeat(600 * 1024));
  atTail.append(value + value.repeat(whole) + 'd'.repeat(EDGE - 12 - whole * value.length));
  const tail = atTail.view(true, short);
  assert.ok(!tail.includes(value.slice(-12)), 'not the end of the cut value');
  assert.match(tail, /\[output too long: \d+ characters, the middle left out\]/);
});

test('over budget: the end is the newest output, however small the reads', () => {
  const capture = new ShellOutput();
  capture.append('y'.repeat(600 * 1024));
  for (let i = 0; i < 50_000; i++) capture.append(`line ${i}\n`);
  const shown = capture.view(true, (text) => text);
  assert.ok(shown.endsWith('line 49999\n'));
  assert.ok(shown.includes('line 49000\n'), 'the end holds the last lines');
});
