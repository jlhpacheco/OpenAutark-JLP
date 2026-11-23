// "/todo text" in a chat's composer (src/ui/chat/composer/slash.ts; Quests round 20.11.2026, review R2.7): the one intake
// – tasks.quickCreate, as the Tasks page's input line – with the text and an idempotency key, never the old todos.add;
// offered where this connection may call tasks.quickCreate.
// Owns: these assertions only. Never: a real runtime (rpc.call is a fake) or rendering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
(rpc as unknown as { call: unknown }).call = async (method: string, params: Record<string, unknown>) => {
  calls.push({ method, params });
  return { task: { id: 'task_new00001' } };
};
const { SLASH_COMMANDS, parseSlash, runSlash } = await import('../../../src/ui/chat/composer/slash.ts');
const { session } = await import('../../../src/ui/lib/session.ts');

test('/todo adds the text through tasks.quickCreate and clears the composer', async () => {
  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] };
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === 'todo')?.needs, ['tasks.quickCreate']);
  const command = parseSlash('/todo Milch kaufen morgen');
  assert.deepEqual(command, { name: 'todo', arg: 'Milch kaufen morgen' });
  const clear = await runSlash(command!, { chat: { id: 'ch_1' } as ConversationSummary, openModelMenu: () => undefined, setLevel: () => undefined, send: async () => true });
  assert.equal(clear, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'tasks.quickCreate');
  assert.equal(calls[0].params.text, 'Milch kaufen morgen');
  assert.match(String(calls[0].params.clientId), /^up_/);
  assert.equal(await runSlash({ name: 'todo', arg: '' }, { chat: { id: 'ch_1' } as ConversationSummary, openModelMenu: () => undefined, setLevel: () => undefined, send: async () => true }), false, 'nothing to add');
});
