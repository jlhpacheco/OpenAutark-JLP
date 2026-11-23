// F12 (owner 15.11.2026): "Show work" opens the agent's own Work page (#/team/<agentId>/work) – what it does right now,
// its really active tasks, its activity log. The pure rules of src/ui/team/agent-work.ts (Now cards with split parts,
// active vs older open vs waiting, plan progress, the last ended run, the page's end) and the route; the .tsx wiring
// (node --test cannot import .tsx) is read from the source: Show work → go.work, the log only on the Work page,
// useAgent exported, every .work-* class styled, the stylesheet imported.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentActivity, Run } from '../../../src/shared/model/runs.ts';
import type { Task } from '../../../src/shared/model/tasks.ts';
import { ACTIVE_MS, activeTasks, atEnd, isActive, lastEnded, nowCards, planProgress, questLine } from '../../../src/ui/team/agent-work.ts';
import { formatRoute, parseRoute } from '../../../src/ui/lib/router.ts';

const NOW = Date.UTC(2026, 10, 16, 12);
const H = 3_600_000;

function live(runId: string, startedAt: number, patch: Partial<AgentActivity> = {}): AgentActivity {
  return { agentId: 'ag_mara', runId, note: 'Reading files', startedAt, ...patch };
}
const part = (runId: string, idx: number, parentRunId: string, startedAt: number): AgentActivity =>
  live(runId, startedAt, { split: { id: `sp_${idx}`, groupId: 'grp_1', idx, of: 3, parentRunId, title: `Part ${idx}` } });

test('Now cards: one per run in start order; a split\'s parts on the card of the run that split, sorted by their place', () => {
  const cards = nowCards([
    live('run_b', NOW - 2 * H),
    part('run_p2', 2, 'run_a', NOW - 50),
    live('run_a', NOW - 3 * H),
    part('run_p1', 1, 'run_a', NOW - 40),
    live('run_other', NOW - 4 * H, { agentId: 'ag_tom' }),
  ], 'ag_mara');
  assert.deepEqual(cards.map((card) => card.key), ['run_a', 'run_b'], 'start order; another agent\'s run is not here');
  assert.deepEqual(cards[0].parts.map((entry) => entry.runId), ['run_p1', 'run_p2']);
  assert.deepEqual(cards[1].parts, []);
});

test('Now cards: parts still at work after the run that split ended stand on one card of their own', () => {
  const cards = nowCards([part('run_p2', 2, 'run_gone', NOW - 10), part('run_p1', 1, 'run_gone', NOW - 20), live('run_c', NOW - 5)], 'ag_mara');
  assert.deepEqual(cards.map((card) => card.key), ['split:grp_1', 'run_c']);
  assert.equal(cards[0].run, undefined);
  assert.equal(cards[0].startedAt, NOW - 20, 'the card starts with its earliest part');
  assert.deepEqual(cards[0].parts.map((entry) => entry.runId), ['run_p1', 'run_p2']);
});

type Row = Pick<Task, 'id' | 'status' | 'assigneeKind' | 'assigneeId' | 'ledger' | 'createdAt' | 'at'> & { running?: boolean };
const task = (id: string, movedAgo: number, patch: Partial<Row> = {}): Row =>
  ({ id, status: 'open', assigneeKind: 'agent', assigneeId: 'ag_mara', ledger: { movedAt: NOW - movedAgo }, createdAt: NOW - 30 * 24 * H, ...patch });

test('active tasks: a turn on it now or a move in the last 24 h; an older open task folds; a time decides nothing', () => {
  const list = [
    task('moved_23h', 23 * H),
    task('moved_25h', 25 * H, { at: NOW + H }), // agent work has no time – a stray one keeps nothing active
    task('running_old', 9 * 24 * H, { running: true }),
    task('waiting', 2 * H, { status: 'waiting' }),
    task('done', H, { status: 'done' }),
    task('toms', H, { assigneeId: 'ag_tom' }),
    task('made_days_ago', 0, { ledger: {}, createdAt: NOW - 4 * 24 * H }), // no move recorded: its creation counts
  ];
  const { open, older, waiting } = activeTasks(list, 'ag_mara', NOW);
  assert.deepEqual(open.map((entry) => entry.id), ['moved_23h', 'running_old'], 'the newest move first');
  assert.deepEqual(older.map((entry) => entry.id), ['moved_25h', 'made_days_ago']);
  assert.deepEqual(waiting.map((entry) => entry.id), ['waiting'], 'waiting stays apart, however fresh');
  assert.equal(ACTIVE_MS, 24 * H);
  assert.equal(isActive(task('edge', ACTIVE_MS), NOW), false, 'exactly 24 h is older');
  assert.equal(isActive(task('waiting_running', 0, { status: 'waiting', running: true }), NOW), false, 'a waiting task is no open work');
});

test('questLine: a quest says how many of its to-dos are done (dropped ones left out), a to-do names its quest', () => {
  type Placed = Pick<Task, 'id' | 'kind' | 'parentId' | 'status' | 'title'>;
  const rows: Placed[] = [
    { id: 'task_q', kind: 'quest', status: 'open', title: 'Signing' },
    { id: 'task_a', kind: 'todo', parentId: 'task_q', status: 'done', title: 'Read' },
    { id: 'task_b', kind: 'todo', parentId: 'task_q', status: 'open', title: 'Sign' },
    { id: 'task_c', kind: 'todo', parentId: 'task_q', status: 'dropped', title: 'Fax' },
    { id: 'task_lone', kind: 'todo', status: 'open', title: 'Alone' },
    { id: 'task_orphan', kind: 'todo', parentId: 'task_gone', status: 'open', title: 'Lost' },
    { id: 'task_empty', kind: 'quest', status: 'open', title: 'New goal' },
    { id: 'task_one', kind: 'quest', status: 'open', title: 'One' },
    { id: 'task_d', kind: 'todo', parentId: 'task_one', status: 'open', title: 'Only' },
  ];
  const every = new Map(rows.map((entry) => [entry.id, entry]));
  const line = (id: string) => questLine(every.get(id)!, every);
  assert.equal(line('task_q'), 'Quest · 1 of 2 to-dos done');
  assert.equal(line('task_one'), 'Quest · 0 of 1 to-do done');
  assert.equal(line('task_empty'), 'Quest · 0 of 0 to-dos done');
  assert.equal(line('task_b'), 'In Signing');
  assert.equal(line('task_lone'), undefined, 'a to-do without a quest says nothing');
  assert.equal(line('task_orphan'), undefined, 'a quest not known here is not guessed');
});

test('plan progress, the last ended run and the page\'s end', () => {
  assert.equal(planProgress(undefined), undefined);
  assert.equal(planProgress([]), undefined);
  assert.equal(planProgress(['✓ read', 'write']), '1 of 2 steps');
  assert.equal(planProgress(['write']), '0 of 1 step');
  const runs: Array<Pick<Run, 'status' | 'endedAt'>> = [{ status: 'done', endedAt: 1 }, { status: 'failed', endedAt: 2 }, { status: 'running' }, { status: 'queued' }];
  assert.equal(lastEnded(runs)?.endedAt, 2, 'the newest ended one, not the live ones after it');
  assert.equal(lastEnded([{ status: 'running' }]), undefined);
  assert.equal(atEnd({ scrollTop: 976, clientHeight: 1000, scrollHeight: 2000 }), true, 'within the slack');
  assert.equal(atEnd({ scrollTop: 900, clientHeight: 1000, scrollHeight: 2000 }), false);
});

test('#/team/<agentId>/work: parsed and formatted both ways; the agent page stays itself', () => {
  assert.deepEqual(parseRoute('#/team/ag_x/work'), { view: 'team', agentId: 'ag_x', work: true });
  assert.equal(formatRoute({ view: 'team', agentId: 'ag_x', work: true }), '#/team/ag_x/work');
  assert.deepEqual(parseRoute('#/team/ag_x'), { view: 'team', agentId: 'ag_x' });
});

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (file: string) => readFileSync(path.join(ui, file), 'utf8');

test('the wiring: Show work opens the Work page, the log lives only there, useAgent is shared', () => {
  const view = read('team/AgentView.tsx');
  assert.match(view, /onClick=\{\(\) => go\.work\(agent\.id\)\}>Show work<\/button>/);
  assert.doesNotMatch(view, /AgentLog|go\.tasks\(/, 'the profile carries no log and no jump to the Work list');
  assert.match(view, /export function useAgent\(/);
  const work = read('team/AgentWork.tsx');
  assert.match(work, /import \{ useAgent \} from '\.\/AgentView\.tsx';/);
  assert.match(work, /<AgentLog state=\{state\} answersOpen=\{!isMobile\.value\} \/>/);
  assert.match(read('shell/views.ts'), /current\.agentId && current\.work\) return \{ key: `work:\$\{current\.agentId\}`, body: h\(AgentWork/);
  assert.match(read('team/WorkNow.tsx'), /<Fold label=\{`\$\{older\.length\} older open`\}/);
  assert.match(read('team/WorkNow.tsx'), /const every = everyTask\(tasks\.value\);/, 'a to-do in a quest is read from the quest\'s steps');
  assert.doesNotMatch(read('team/WorkNow.tsx') + read('team/agent-work.ts'), /nextLook|nextAt\b|dueAt|\.at\b/, 'agent work shows no time');
});

test('every Work page class has its rule; the sheet is imported; icons exist', () => {
  const css = read('styles/agent-work.css') + read('styles/team.css');
  const source = read('team/WorkNow.tsx') + read('team/AgentWork.tsx');
  const sections = new Set(['work-now', 'work-tasks']); // the two sections' names: styled as .agent-section (team.css)
  const classes = new Set([...source.matchAll(/class(?:Name)?="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/))
    .filter((name) => /^(work-|agent-work|agent-fold)/.test(name) && !sections.has(name)));
  assert.ok(classes.size > 15, String(classes.size));
  for (const name of classes) assert.match(css, new RegExp(`\\.${name}(?![\\w-])`), name);
  assert.match(read('styles/index.css'), /@import "\.\/agent-work\.css";/);
  const icons = read('lib/icons.tsx');
  for (const [, name] of source.matchAll(/<Icon name="([^"]+)"/g)) assert.ok(icons.includes(`'${name}'`), `icon ${name}`);
  assert.match(css, /\.work-card-head \{[^}]*height: 28px;/, 'the live note\'s line has one height');
  assert.match(css, /\.work-card-note \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(css, /\.work-jump \{\s*position: absolute;/, 'Jump to now floats: nothing moves when it shows');
});
