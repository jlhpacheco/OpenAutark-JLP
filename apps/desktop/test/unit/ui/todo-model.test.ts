// The person's to-do helpers (ui/tasks/todo-model.ts, F01 follow-up): they live in one module only – model.ts
// re-exports nothing (Quests round 20.11.2026: no barrel, importers use the real module) – and the mini-app rules hold.
// Owns: these assertions only. Never: the DOM, the store or rpc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../../../src/ui/tasks/model.ts';
import * as todo from '../../../src/ui/tasks/todo-model.ts';

test('the to-do helpers live in todo-model.ts only; model.ts is no barrel', () => {
  const names = ['todoLabel', 'askTargetOf', 'widgetIcon', 'SHOW_AS', 'showAsOptions'] as const;
  for (const name of names) {
    assert.ok(name in todo, `${name} lives in todo-model.ts`);
    assert.equal(name in model, false, `${name} is not re-exported`);
  }
});

test('a mini-app to-do has its own icon and no "Show as" choices; a to-do keeps its title', () => {
  const app = { type: 'app', messageId: 'msg_1', index: 0, permissions: [] } as unknown as Parameters<typeof todo.widgetIcon>[0];
  assert.equal(todo.widgetIcon(app), 'app-window');
  assert.deepEqual(todo.showAsOptions({ widget: app as never, createdBy: 'ag_1', assigneeKind: 'human' }), []);
  assert.equal(todo.showAsOptions({ createdBy: 'ag_1', assigneeKind: 'human' }), todo.SHOW_AS);
  assert.equal(todo.todoLabel({ widget: { type: 'confirm' } as never, createdBy: 'ag_1', title: 'Call Anna' }), 'Call Anna');
});

test('no "Show as" choices on cards the host bound to the person: access requests', () => {
  const human = { createdBy: 'system', assigneeKind: 'human' as const };
  for (const widget of [
    { type: 'choice', question: 'Accept only if the device shows the code 4821.', options: ['Full access', 'To-do only', 'Deny'], accessRequestId: 'par_1' },
  ]) {
    assert.deepEqual(todo.showAsOptions({ ...human, widget: widget as never }), [], widget.type);
    assert.equal(todo.showAsOptions({ ...human, createdBy: 'ag_1', widget: widget as never }), todo.SHOW_AS, `${widget.type}: an agent's copy binds nothing`);
  }
});

test("a person's join request reads as one sentence wherever its to-do shows (the Tasks page, the notice band)", () => {
  const join = { title: 'Let Laptop · Chrome join as Anna Berg · Designer?', createdBy: 'system', widget: { type: 'choice', accessRequestId: 'person_tok_9' } as never };
  assert.equal(todo.todoLabel(join), 'Anna Berg wants to join from Laptop · Chrome', 'not "Let … join as …?" – the role stays in the question');
  assert.equal(todo.todoLabel({ ...join, createdBy: 'ag_1' }), join.title, "an agent's to-do keeps its own title");
  assert.equal(todo.todoLabel({ ...join, widget: { type: 'choice', accessRequestId: 'remote_rq_1' } as never }), join.title, 'only a person\'s join request');
});
