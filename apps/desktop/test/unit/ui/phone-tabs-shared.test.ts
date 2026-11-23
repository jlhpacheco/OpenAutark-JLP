// 21.11.2026: a person's device keeps what the PC shares with it as the PC has it now (src/ui/workspace/phone-tabs.ts
// withShared) – an agent's own browser it put in a chat's area comes in, and once the agent took it back it is gone
// here too; the person's own tabs stay.
// Owns: these assertions only. Never: a runtime or DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withShared } from '../../../src/ui/workspace/phone-tabs.ts';

test("an agent's browser shared in a chat's area comes and goes with the PC's copy; the person's own tabs stay", () => {
  const browser = { id: 'agent:ag_ada', panel: 'agent', agentId: 'ag_ada' };
  const notes = { id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' };
  const shared = withShared({ 'chat:ch_1': { tabs: [notes] } }, { 'chat:ch_1': { shown: browser.id, tabs: [browser] } });
  assert.deepEqual(shared['chat:ch_1'], { shown: browser.id, tabs: [browser, notes] });
  const back = withShared(shared, {});
  assert.deepEqual(back['chat:ch_1'], { tabs: [notes] }, 'taken back on the PC: gone here');
});
