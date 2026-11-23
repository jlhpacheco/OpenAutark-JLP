// Where an agent runs, in words (src/ui/team/runs-on.ts, owner 21.11.2026: "ein klareres System, wo ein Agent läuft"):
// nothing with one PC alone; "This PC (…)" for one here; the PC's name for one of my other PCs, "· offline" when it is;
// "· company PC" on an employee's PC for the company's agents (never mine to move); the move offers this PC and my own
// online PCs only. Also: the agent page, the team list and the live bar use these words.
// Owns: these assertions only. Never: a real PC or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Device } from '../../../src/shared/model/devices.ts';
import { moveTargets, runsOn, runsOnText } from '../../../src/ui/team/runs-on.ts';

const pc = (id: string, extra: Partial<Device> = {}): Device => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});
const self = pc('laptop', { self: true });

test('one PC alone: nothing to say', () => {
  assert.equal(runsOn({}, [self]), undefined);
});

test('here, on my other PC, offline, unknown', () => {
  const list = [self, pc('tower'), pc('nas', { status: 'offline' })];
  assert.equal(runsOnText(runsOn({}, list)!), 'This PC (laptop)');
  assert.equal(runsOnText(runsOn({ deviceId: 'laptop' }, list)!), 'This PC (laptop)');
  assert.equal(runsOnText(runsOn({ deviceId: 'tower' }, list)!), 'tower');
  assert.equal(runsOnText(runsOn({ deviceId: 'nas' }, list)!), 'nas · offline');
  assert.equal(runsOn({ deviceId: 'gone' }, list)!.name, 'another PC');
});

test('on an employee\'s PC the company\'s agents say so', () => {
  const list = [self, pc('momosdojo', { joinedAs: 'employee' })];
  assert.equal(runsOnText(runsOn({ deviceId: 'momosdojo' }, list)!), 'momosdojo · company PC');
  const other = runsOn({ deviceId: 'company-tower' }, list)!;
  assert.deepEqual([other.name, other.company], ['a company PC', true], 'a company PC this one has no link to');
});

test('a move goes to this PC or one of my own online PCs', () => {
  const list = [self, pc('tower'), pc('nas', { status: 'offline' }), pc('momosdojo', { joinedAs: 'employee' }), pc('lena-pc', { personId: 'per_lena' })];
  assert.deepEqual(moveTargets(list).map((device) => device.id), ['laptop', 'tower']);
});

test('the agent page, the team list and the live bar name the PC', () => {
  const ui = path.resolve(import.meta.dirname, '../../../src/ui');
  const read = (file: string) => readFileSync(path.join(ui, file), 'utf8');
  assert.match(read('team/AgentProfile.tsx'), /<dt>Runs on<\/dt>/);
  assert.match(read('team/TeamTree.tsx'), /where && !where\.here \? `on \$\{where\.name\}` : ''/);
  assert.match(read('chat/LiveBarMore.tsx'), /This runs on \{pcLabel\(run\.deviceId!\)\}; its steps are there\./);
});
