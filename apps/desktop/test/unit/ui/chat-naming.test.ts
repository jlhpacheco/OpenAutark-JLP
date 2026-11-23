// B-050 K2 in the UI (src/ui/lib/chat-naming.ts): a chat's name, partner and second line as the caller
// ('human') sees it – the default 1:1 by its partner, a topic chat as "Name · Topic", a group by its
// other members; and the UI's own label where the shared rule knows no name (a default 1:1 whose partner
// was removed, or a person whose access ended): "Untitled chat", never a blank. A task's own thread is named by its task
// (a quest's to-do too) – never "Untitled chat" – and its composer says "Write to <its lead> about this…" (the mockup's
// line; "Write about this…" while it has no lead).
// Owns: these assertions. Never: renders (the face: lib/chat-face.tsx, checked in test/ui/team-chats-window).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import { UNKNOWN_TASK, UNTITLED_CHAT, chatPartner, chatSubtitle, chatTitle, composerPlaceholder } from '../../../src/ui/lib/chat-naming.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { agents, archivedAgents, tasks } from '../../../src/ui/lib/store.ts';
import { people } from '../../../src/ui/lib/people.ts';

agents.value = [
  { id: 'ag_lena', name: 'Lena', role: 'Research' } as Agent,
  { id: 'ag_ravi', name: 'Ravi', role: 'Writing' } as Agent,
];
people.value = [{ id: 'per_anna0000001', name: 'Anna', title: 'Design' } as Person];

function member(memberId: string, patch: Partial<Member> = {}): Member {
  return { conversationId: 'ch_1', memberId, kind: memberId.startsWith('ag_') ? 'agent' : 'human', role: 'member', readSeq: 0, joinedAt: 0, ...patch };
}

function chat(members: Member[], patch: Partial<ConversationSummary> = {}): ConversationSummary {
  return { id: 'ch_1', title: '', titleNamed: false, settings: {}, members, createdBy: 'human', pinned: false, lastSeq: 0, createdAt: 0, updatedAt: 0, unread: 0, working: [], openTasks: 0, ...patch } as ConversationSummary;
}

test('chatTitle: the default 1:1 by its partner, a topic chat as "Name · Topic", a group by its other members', () => {
  const direct = chat([member('human'), member('ag_lena')], { settings: { direct: true } });
  assert.equal(chatTitle(direct), 'Lena');
  assert.equal(chatPartner(direct)?.memberId, 'ag_lena');
  assert.equal(chatSubtitle(direct), 'Research');
  assert.equal(chatTitle(chat([member('human'), member('ag_lena')], { title: 'Video edit', titleNamed: true })), 'Lena · Video edit');
  const group = chat([member('human'), member('ag_lena'), member('per_anna0000001')]);
  assert.equal(chatTitle(group), 'Lena, Anna', 'an untitled group: the other members');
  assert.equal(chatSubtitle(group), '2 members');
});

test('chatTitle: a chat nobody can name – a default 1:1 whose partner was removed – gets a label, never a blank', () => {
  // A summary lists its active members only (runtime chat/summary.ts): the removed partner is gone from it.
  const left = chat([member('human')]);
  assert.equal(chatTitle(left), UNTITLED_CHAT, 'no blank row, header or "Message " placeholder');
  assert.equal(chatPartner(left), undefined, 'no partner to open');
  assert.equal(chatSubtitle(left), '');
  assert.equal(chatTitle(chat([member('human'), member('ag_lena', { leftAt: 5 })])), UNTITLED_CHAT, 'a left member names nothing');
  assert.equal(chatTitle(chat([member('human')], { title: 'Lena' })), 'Lena', 'a stored title still names it');
  assert.equal(chatTitle(chat([member('human')], { title: 'Q3 plan', titleNamed: true })), 'Q3 plan');
});

test('chatTitle: the default 1:1 of an archived agent keeps its agent name and role (agents.list leaves archived agents out)', () => {
  archivedAgents.value = [{ id: 'ag_otto', name: 'Otto', role: 'Support', archivedAt: 9 } as Agent];
  try {
    const direct = chat([member('human'), member('ag_otto')], { settings: { direct: true } });
    assert.equal(chatTitle(direct), 'Otto', 'not "Untitled chat"');
    assert.equal(chatPartner(direct)?.memberId, 'ag_otto');
    assert.equal(chatSubtitle(direct), 'Support');
    assert.equal(chatTitle(chat([member('human'), member('ag_otto')], { title: 'Refunds', titleNamed: true })), 'Otto · Refunds');
  } finally { archivedAgents.value = []; }
  assert.equal(chatTitle(chat([member('human'), member('ag_otto')], { settings: { direct: true } })), UNTITLED_CHAT, 'a restored or removed agent is not remembered');
});

test('a task\'s own thread is named by its task (a quest\'s to-do too), never "Untitled chat"; its composer writes about it', () => {
  const step = { id: 'task_step0000001', title: 'Collect the receipts', steps: [] } as unknown as TaskView;
  tasks.value = [{ id: 'task_quest000001', title: 'Tax return 2026', steps: [step], rev: 1 } as unknown as TaskView];
  try {
    const thread = (id: string) => chat([member('human'), member('ag_lena'), member('ag_ravi')], { id });
    assert.equal(chatTitle(thread('task_quest000001')), 'Tax return 2026');
    assert.equal(chatTitle(thread('task_step0000001')), 'Collect the receipts', 'a to-do inside a quest');
    assert.equal(chatTitle(thread('task_gone0000001')), UNKNOWN_TASK, 'a task the store holds no copy of');
    assert.equal(composerPlaceholder(thread('task_step0000001')), 'Write about this…', 'no lead yet');
    assert.equal(composerPlaceholder(chat([member('human'), member('ag_lena', { role: 'lead' }), member('ag_ravi')], { id: 'task_step0000001' })), 'Write to Lena about this…');
    assert.equal(composerPlaceholder(chat([member('human'), member('ag_lena', { role: 'lead', leftAt: 5 })], { id: 'task_step0000001' })), 'Write about this…', 'a lead who left answers no more');
    assert.equal(composerPlaceholder(chat([member('human'), member('ag_lena')])), 'Message Lena', 'a chat stays as it was');
    assert.equal(composerPlaceholder(chat([member('human'), member('ag_lena')]), true), 'Scheduled message for Lena');
  } finally { tasks.value = []; }
});
