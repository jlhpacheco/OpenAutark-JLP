// 0.3.19 (Stanislaus 23.11.2026, task_0mvd0nrj): a to-do the app itself made (createdBy 'system', e.g. "Sign in to … again")
// shows "from Autark" on the desktop and the phone (TodoDetail: `from ${agentName(task.createdBy)}`), never "from Former member".
// Owns: this assertion. Never: renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentName } from '../../../src/ui/lib/store.ts';
import { SYSTEM_ID } from '../../../src/shared/ids.ts';

test('the app\'s own to-dos come from "Autark"; an unknown id stays a former member', () => {
  assert.equal(agentName(SYSTEM_ID), 'Autark');
  assert.equal(agentName('ag_gone'), 'Former member');
});
