// F06 (owner 15.11.2026: paused cron jobs go under a button below): the one state rule of a schedule
// (src/ui/tasks/schedule-state.ts) – next run, no next run, paused by someone, ended by itself – and the agent page's
// split: active by next run, paused apart, ended one-shots left out. Both lists use the rule (source read: .tsx).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Schedule } from '../../../src/shared/model/tasks.ts';
import { agentSchedules, byNextRun, scheduleState } from '../../../src/ui/tasks/schedule-state.ts';

type Row = Pick<Schedule, 'id' | 'ownerId' | 'active' | 'nextAt' | 'pausedBy' | 'createdAt'>;
const row = (id: string, patch: Partial<Row> = {}): Row => ({ id, ownerId: 'ag_konrad', active: true, createdAt: 0, ...patch });

test('the state: next, none, paused (someone paused it), ended (it used up its runs)', () => {
  assert.equal(scheduleState({ active: true, nextAt: 5 }), 'next');
  assert.equal(scheduleState({ active: true }), 'none', 'active without a next run known here');
  assert.equal(scheduleState({ active: false, pausedBy: 'human' }), 'paused');
  assert.equal(scheduleState({ active: false, pausedBy: 'ag_konrad', nextAt: 5 }), 'paused');
  assert.equal(scheduleState({ active: false }), 'ended', 'a one-shot reminder that fired – no Paused label');
});

test('the agent page: active by next run (none last), paused apart newest first, ended and other owners left out', () => {
  const list = [
    row('late', { nextAt: 300 }),
    row('none', { createdAt: 1 }),
    row('soon', { nextAt: 100 }),
    row('paused_old', { active: false, pausedBy: 'human', createdAt: 5 }),
    row('paused_new', { active: false, pausedBy: 'ag_konrad', createdAt: 9 }),
    row('ended', { active: false, createdAt: 7 }),
    row('toms', { ownerId: 'ag_tom', nextAt: 50 }),
  ];
  const { active, paused } = agentSchedules(list, 'ag_konrad');
  assert.deepEqual(active.map((item) => item.id), ['soon', 'late', 'none']);
  assert.deepEqual(paused.map((item) => item.id), ['paused_new', 'paused_old']);
  assert.deepEqual(agentSchedules([row('ended', { active: false })], 'ag_konrad'), { active: [], paused: [] }, 'nothing to show: the section goes');
  assert.deepEqual([row('b', { createdAt: 2 }), row('a', { createdAt: 1 })].sort(byNextRun).map((item) => item.id), ['a', 'b'], 'ties by creation');
});

test('both lists draw the one rule; the agent page folds the paused ones under one toggle', () => {
  const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
  const details = readFileSync(path.join(ui, 'team/AgentDetails.tsx'), 'utf8');
  assert.match(details, /const \{ active, paused \} = agentSchedules\(schedules\.value, props\.agentId\);/);
  assert.match(details, /<span>Paused \(\{paused\.length\}\)<\/span>/);
  assert.match(details, /\{open && paused\.map\(/, 'opening only adds rows below the toggle');
  const chat = readFileSync(path.join(ui, 'chat/details/Schedules.tsx'), 'utf8');
  assert.match(chat, /const state = scheduleState\(schedule\);/);
  assert.match(chat, /none: 'No next run', paused: 'Paused', ended: 'Ended'/);
  // Quests round 20.11.2026: a chat's schedules are two kinds – a message sent later and an agent's reminder
  assert.match(chat, /message: \{ icon: 'chat-text', label: 'Send later' \},\s*reminder: \{ icon: 'bell', label: 'Reminder' \},\s*\};/);
  assert.doesNotMatch(chat, /routine|timer/i);
});
