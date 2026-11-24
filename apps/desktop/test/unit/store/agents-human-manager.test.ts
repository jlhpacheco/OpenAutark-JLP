// 24.11.2026 (ORENDA, BEFUND-UMZUG.md L1): an employee's PC keeps the person's personal manager as person_manager_id = 'human'
// (devices/sync/employee.ts). Reading that as managerId 'human' must store it in person_manager_id with manager_id NULL,
// not in manager_id – that column references agents(id) and failed with FOREIGN KEY constraint failed on every save.
// Owns: these assertions only. Never: a real ORENDA database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { memoryDb } from './helpers.ts';

test("an agent whose manager is 'human' saves with foreign keys on: person_manager_id keeps it, manager_id stays empty", () => {
  const db = memoryDb();
  assert.equal(Number(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys), 1, 'the check runs with foreign keys on');
  const repo = new AgentRepo(db);
  const hired = agent('ag_orenda_test', 'Anna', { instructions: '', managerId: 'human', createdAt: 1, updatedAt: 1 });

  assert.doesNotThrow(() => repo.save(hired));
  const stored = db.get<{ manager_id: string | null; person_manager_id: string | null }>(
    'SELECT manager_id, person_manager_id FROM agents WHERE id = ?', [hired.id]);
  assert.equal(stored?.manager_id, null);
  assert.equal(stored?.person_manager_id, 'human');
  assert.equal(repo.get(hired.id)?.managerId, 'human', 'read back as the same manager');
});

test("a later save of that agent (rename, instructions) succeeds and keeps 'human' as its manager", () => {
  const db = memoryDb();
  const repo = new AgentRepo(db);
  const hired = agent('ag_orenda_test2', 'Anna', { managerId: 'human', createdAt: 1, updatedAt: 1 });
  repo.save(hired);

  const renamed = { ...repo.get(hired.id)!, name: 'Anna B.', instructions: '# Mine\nText.', updatedAt: 2 };
  assert.doesNotThrow(() => repo.save(renamed));
  const back = repo.get(hired.id);
  assert.equal(back?.name, 'Anna B.');
  assert.equal(back?.instructions, '# Mine\nText.');
  assert.equal(back?.managerId, 'human');
});

test('a manager that is an agent still goes to manager_id', () => {
  const db = memoryDb();
  const repo = new AgentRepo(db);
  repo.save(agent('ag_boss', 'Boss', { createdAt: 1, updatedAt: 1 }));
  repo.save(agent('ag_report', 'Report', { managerId: 'ag_boss', createdAt: 1, updatedAt: 1 }));
  const stored = db.get<{ manager_id: string | null; person_manager_id: string | null }>(
    'SELECT manager_id, person_manager_id FROM agents WHERE id = ?', ['ag_report']);
  assert.equal(stored?.manager_id, 'ag_boss');
  assert.equal(stored?.person_manager_id, null);
});
