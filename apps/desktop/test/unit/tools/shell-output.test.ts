// 0.3.19, the masked engine shell (tools/builtin/shell-output.ts): a command's output is kept whole per pipe up to its
// budget and masked only as a whole – never a prefix or a tail a redactor could miss a cut value in. Ported from the
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
  assert.match(shown, /\[output capped\]$/);
});

test('unfinished, over budget, or a failing redactor cannot release a raw prefix', () => {
  const capture = new ShellOutput();
  capture.append(value.slice(0, 22));
  assert.equal(capture.view(false, marked), WITHHELD);
  assert.equal(capture.view(true, () => { throw new Error('fixture redactor failed'); }), WITHHELD);
  capture.append('x'.repeat(1024 * 1024));
  assert.equal(capture.view(true, marked), WITHHELD);
});
