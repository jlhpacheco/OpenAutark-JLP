// 24.11.2026 (ORENDA, BEFUND-UMZUG.md L2): a failing "standard comment not kept" was logged at every agent.upserted – 672 times
// in ORENDA's log. The warning now goes out once per agent and failure in this process; another agent or another failure
// is logged again. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warnKeepFailure } from '../../../src/runtime/org/standard.ts';

function fakeLog() {
  const warnings: Array<{ message: string; data: unknown }> = [];
  const log = { info() {}, error() {}, debug() {}, warn(message: string, data?: unknown) { warnings.push({ message, data }); } };
  return { log: log as unknown as Parameters<typeof warnKeepFailure>[0], warnings };
}

test('the same agent and the same failure are logged once, however often it repeats', () => {
  const { log, warnings } = fakeLog();
  for (let i = 0; i < 5; i++) warnKeepFailure(log, 'ag_warn_once_a', new Error('FOREIGN KEY constraint failed'));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.message, 'standard comment not kept');
  assert.deepEqual(warnings[0]!.data, { agentId: 'ag_warn_once_a', error: 'FOREIGN KEY constraint failed' });
});

test('another failure of the same agent is logged again, and another agent with the same failure too', () => {
  const { log, warnings } = fakeLog();
  warnKeepFailure(log, 'ag_warn_once_b', new Error('FOREIGN KEY constraint failed'));
  warnKeepFailure(log, 'ag_warn_once_b', new Error('disk I/O error'));
  warnKeepFailure(log, 'ag_warn_once_c', new Error('FOREIGN KEY constraint failed'));
  warnKeepFailure(log, 'ag_warn_once_b', new Error('disk I/O error'));
  assert.equal(warnings.length, 3);
});

test('a thrown value that is not an Error is named by its text', () => {
  const { log, warnings } = fakeLog();
  warnKeepFailure(log, 'ag_warn_once_d', 'plain text');
  warnKeepFailure(log, 'ag_warn_once_d', 'plain text');
  assert.equal(warnings.length, 1);
  assert.equal((warnings[0]!.data as { error: string }).error, 'plain text');
});
