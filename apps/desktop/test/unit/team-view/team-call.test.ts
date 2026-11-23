// Team-Call 21.11.2026: what a drop in the team tree changes (src/ui/team/drop-model.ts dropChange – agent onto agent
// reports to it, person onto agent makes it theirs, agent onto person reports to them, the owner = the top, no drop onto
// itself, into a loop, as a no-op or with a read-only company colleague) and which chats an agent's or a person's page
// lists under "New chat" (src/ui/team/member-chats.ts sharedChats); a company colleague on an employee's PC (fromEmployer)
// is in no chat picker (lib/people.ts colleagues) and offers no New chat or Message (source wiring).
// Owns: these assertions only. Never: renders, rpc or the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import { colleagues, people as peopleSignal } from '../../../src/ui/lib/people.ts';
import { dropChange } from '../../../src/ui/team/drop-model.ts';
import { sharedChats } from '../../../src/ui/team/member-chats.ts';

const agent = (id: string, managerId?: string, archivedAt?: number) => ({ id, ...(managerId ? { managerId } : {}), ...(archivedAt ? { archivedAt } : {}) });
const person = (id: string, extra: { managerId?: string; owner?: boolean; fromEmployer?: true } = {}) => ({ id, owner: extra.owner ?? id === 'human', ...extra });

const agents = [agent('jonas'), agent('social', 'jonas'), agent('writer', 'social'), agent('old', undefined, 5)];
const people = [person('human'), person('per_momo00000', { managerId: 'human' }), person('per_lea0000000', { managerId: 'writer' }), person('owner', { fromEmployer: true })];

test('an agent dropped on an agent reports to it', () => {
  assert.deepEqual(dropChange({ kind: 'agent', id: 'writer' }, { kind: 'agent', id: 'jonas' }, agents, people), { agentId: 'writer', managerId: 'jonas' });
});

test('a person dropped on an agent makes that agent theirs; an agent dropped on a person reports to them', () => {
  assert.deepEqual(dropChange({ kind: 'person', id: 'per_momo00000' }, { kind: 'agent', id: 'jonas' }, agents, people), { agentId: 'jonas', managerId: 'per_momo00000' });
  assert.deepEqual(dropChange({ kind: 'agent', id: 'social' }, { kind: 'person', id: 'per_momo00000' }, agents, people), { agentId: 'social', managerId: 'per_momo00000' });
});

test('the owner as the new manager is the top (cleared)', () => {
  assert.deepEqual(dropChange({ kind: 'agent', id: 'social' }, { kind: 'person', id: 'human' }, agents, people), { agentId: 'social', managerId: null });
  assert.equal(dropChange({ kind: 'person', id: 'human' }, { kind: 'agent', id: 'jonas' }, agents, people), null, 'already at the top');
});

test('no drop onto itself, into a loop, as a no-op or with archived agents', () => {
  assert.equal(dropChange({ kind: 'agent', id: 'jonas' }, { kind: 'agent', id: 'jonas' }, agents, people), null);
  assert.equal(dropChange({ kind: 'agent', id: 'jonas' }, { kind: 'agent', id: 'writer' }, agents, people), null, 'jonas under its own report');
  assert.equal(dropChange({ kind: 'person', id: 'per_lea0000000' }, { kind: 'agent', id: 'jonas' }, agents, people), null, 'Lea reports up to jonas already: jonas cannot report to her');
  assert.equal(dropChange({ kind: 'agent', id: 'social' }, { kind: 'agent', id: 'jonas' }, agents, people), null, 'already its manager');
  assert.equal(dropChange({ kind: 'agent', id: 'social' }, { kind: 'agent', id: 'old' }, agents, people), null);
  assert.equal(dropChange({ kind: 'person', id: 'per_momo00000' }, { kind: 'person', id: 'human' }, agents, people), null, 'person onto person is no drop');
});

test('a company colleague on an employee PC is read-only', () => {
  assert.equal(dropChange({ kind: 'person', id: 'owner' }, { kind: 'agent', id: 'jonas' }, agents, people), null);
  assert.equal(dropChange({ kind: 'agent', id: 'jonas' }, { kind: 'person', id: 'owner' }, agents, people), null);
});

const member = (memberId: string, leftAt?: number): Member => ({ conversationId: 'c', memberId, kind: memberId.startsWith('a') ? 'agent' : 'human', role: 'member', readSeq: 0, joinedAt: 0, ...(leftAt ? { leftAt } : {}) } as Member);
const chat = (id: string, members: Member[], extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id, title: '', titleNamed: false, createdBy: 'human', pinned: false, settings: {}, lastSeq: 0, createdAt: 1, updatedAt: 1,
  members, unread: 0, working: [], openTasks: 0, ...extra,
} as ConversationSummary);

test('the chats shared with a member: both still in, list chats only, newest first', () => {
  const list = [
    chat('old', [member('human'), member('ajonas')], { lastMessageAt: 10 }),
    chat('new', [member('human'), member('ajonas'), member('per_momo00000')], { lastMessageAt: 20 }),
    chat('left', [member('human'), member('ajonas', 3)], { lastMessageAt: 30 }),
    chat('other', [member('human'), member('asocial')], { lastMessageAt: 40 }),
    chat('thread', [member('human'), member('ajonas')], { lastMessageAt: 50, settings: { parentId: 'old', anchorId: 'm1' } }),
    chat('work', [member('ajonas'), member('asocial')], { lastMessageAt: 60 }),
    chat('archived', [member('human'), member('ajonas')], { lastMessageAt: 70, archivedAt: 71 }),
    chat('viewer-left', [member('human', 2), member('ajonas')], { lastMessageAt: 80 }),
  ];
  assert.deepEqual(sharedChats(list, 'ajonas').map((entry) => entry.id), ['new', 'old']);
  assert.deepEqual(sharedChats(list, 'per_momo00000').map((entry) => entry.id), ['new']);
});

test('a company colleague (fromEmployer) is in no chat picker and offers no New chat or Message', () => {
  const row = (id: string, extra: Partial<Person> = {}) => ({ id, name: id, title: '', avatar: { kind: 'initials', value: 'x' }, status: 'active', owner: false, scopes: { spaces: 'all', startChats: true, assignAgents: true }, createdAt: 0, updatedAt: 0, ...extra } as Person);
  peopleSignal.value = [row('human', { owner: true }), row('per_momo00000'), row('owner', { fromEmployer: true }), row('per_ceo000000', { fromEmployer: true })];
  assert.deepEqual(colleagues().map((person) => person.id), ['per_momo00000']);
  peopleSignal.value = [];
  const src = (file: string) => readFileSync(new URL(`../../../src/ui/team/${file}`, import.meta.url), 'utf8');
  assert.match(src('menus.ts'), /person\.status === 'active' && !person\.fromEmployer && directReachable\(\)/);
  assert.match(src('PersonView.tsx'), /canStart=\{person\?\.status === 'active' && !person\.fromEmployer/);
});
