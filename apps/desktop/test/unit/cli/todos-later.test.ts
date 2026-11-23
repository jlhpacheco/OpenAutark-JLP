// `wf todos` (F04, Quests round 20.11.2026: one "when", the to-do's `at`): todos.list returns the person's unfinished
// to-dos; the lines list what is due now first, then "Later (n):" with when each comes – "rings …" for a timer, "at …"
// for a to-do on a later day; --json prints the runtime's data.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTodos } from '../../../src/runtime/wf-cli/format.ts';
import { AT, task } from './fixtures.ts';
import { fakeRuntime, wf } from './fake-runtime.ts';

const M = 60_000;
const H = 60 * M;

const sign = task({ id: 'task_s', title: 'Sign the form', assigneeKind: 'human', status: 'open', at: AT + H });
const nap = task({ id: 'task_n', title: 'Take the bread out', assigneeKind: 'human', status: 'open', widget: { type: 'timer', label: 'Bread' }, at: AT + 13 * H });
const older = task({ id: 'task_o', title: 'Stretch', assigneeKind: 'human', status: 'open', at: new Date(2026, 9, 24, 8, 0).getTime() });
const dentist = task({ id: 'task_d', title: 'Dentist', assigneeKind: 'human', status: 'open', widget: { type: 'timer', label: 'Dentist' }, at: new Date(2026, 9, 23, 9, 0).getTime() });

test('formatTodos: what is due now, then "Later (n):" with when each rings', () => {
  assert.deepEqual(formatTodos([nap, sign, dentist, older], AT), [
    '• Sign the form · in Launch · at 15:02 · task_s',
    'Later (3):',
    '• Take the bread out · timer · in Launch · rings 2026-10-21 03:02 · task_n',
    '• Dentist · timer · in Launch · rings 2026-10-23 09:00 · task_d',
    '• Stretch · in Launch · at 2026-10-24 08:00 · task_o',
  ]);
  assert.deepEqual(formatTodos([nap], AT), ['Nothing needs you right now.', 'Later (1):', '• Take the bread out · timer · in Launch · rings 2026-10-21 03:02 · task_n']);
  assert.deepEqual(formatTodos([dentist], new Date(2026, 9, 23, 8, 0).getTime()), ['• Dentist · timer · in Launch · at 09:00 · task_d'], 'within 12 h it is due now');
});

test('wf todos prints the split; --json the runtime\'s list as it is', async (t) => {
  const runtime = await fakeRuntime({ 'todos.list': () => [nap, sign] });
  t.after(() => runtime.stop());
  const out = await wf(['todos'], { runtime });
  assert.equal(out.out, '• Sign the form · in Launch · at 15:02 · task_s\nLater (1):\n• Take the bread out · timer · in Launch · rings 2026-10-21 03:02 · task_n\n');
  const json = await wf(['todos', '--json'], { runtime });
  assert.deepEqual(JSON.parse(json.out).map((todo: { id: string }) => todo.id), ['task_n', 'task_s']);
  const help = (await wf(['help', 'todos'])).out;
  assert.ok(help.includes('a time on a later day, or a timer more than 12 h ahead'), 'what "Later" holds (one "when": a snooze moves the at of the to-do)');
  assert.match(help, /--json prints the runtime's list unsplit/);
});
