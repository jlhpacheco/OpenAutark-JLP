// F-52 in the client: Team › People's pure parts, task owners that are people (select values
// 'person:<id>' ↔ assignee kind 'human' + id), the For-you rule (only the caller's own to-dos), and the
// caller's own identity (lib/self-identity.ts: the profile button's name and avatar, never "CEO"/"C").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { managerOptions, statusLabel } from '../../../src/ui/team/people-model.ts';
import { ownerOf } from '../../../src/ui/tasks/work-model.ts';
import { onForYouList } from '../../../src/shared/model/todo-later.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, title: '', avatar: { kind: 'initials', value: name[0] }, status: 'active', owner: id === 'human',
  scopes: { spaces: 'all', startChats: true, assignAgents: true }, createdAt: 0, updatedAt: 0, ...extra,
});
const agent = (id: string, name: string, extra: Partial<Agent> = {}) => ({ id, name, role: 'Researcher', ...extra }) as Agent;

test('People: labels, manager choices, scopes and reports', () => {
  assert.equal(statusLabel({ owner: true, status: 'active' }), 'Owner');
  assert.equal(statusLabel({ owner: false, status: 'invited' }), 'Invited');
  assert.equal(statusLabel({ owner: false, status: 'revoked' }), 'Access removed');
  const people = [person('human', 'Mara', { title: 'CEO' }), person('per_a', 'Anna'), person('per_b', 'Ben', { status: 'revoked' })];
  const agents = [agent('ag_1', 'Research'), agent('ag_2', 'Old', { archivedAt: 1 })];
  assert.deepEqual(managerOptions('per_a', people, agents).map((option) => option.value), ['', 'human', 'ag_1']);
});

test('F14: invited people are not in the org chart until they join; the owner always is', async () => {
  const { peopleOrg, splitInvited } = await import('../../../src/ui/team/people-model.ts');
  const people = [
    person('human', 'Mara', { title: 'CEO' }), person('per_a', 'Anna', { joinedAt: 5, managerId: 'human' }),
    person('per_h', 'huhu', { status: 'invited', managerId: 'human' }), person('per_r', 'Rex', { status: 'revoked' }),
    person('per_g', 'Gone', { status: 'revoked', joinedAt: 3 }), person('per_o', 'Old', { status: 'active' }),
  ];
  const { members, invited } = splitInvited(people);
  assert.deepEqual(members.map((entry) => entry.id), ['human', 'per_a', 'per_g', 'per_o'], 'joined (also one whose access ended; an active row without a date)');
  assert.deepEqual(invited.map((entry) => entry.id), ['per_h', 'per_r'], 'never joined: invited, or their invite ended before');
  const chart = peopleOrg(members, []);
  const ids = (entries: typeof chart.people): string[] => entries.flatMap((entry) => [entry.person.id, ...ids(entry.people)]);
  assert.ok(!ids(chart.people).includes('per_h'), 'huhu is no node and no report of the owner');
  assert.deepEqual(chart.people[0].people.map((entry) => entry.person.id), ['per_a']);
});

test('F13: Add person – the person Accept makes, the request slot\'s line, a link a browser elsewhere can open', async () => {
  const { browserReachable, newPersonOf, requestSlotHint } = await import('../../../src/ui/team/people-model.ts');
  assert.equal(newPersonOf({ name: '  ', title: 'Designer', managerId: 'human' }), undefined, 'no name, nothing to accept');
  assert.deepEqual(newPersonOf({ name: ' Anna Berg ', title: ' ', managerId: '' }), { name: 'Anna Berg' }, 'top of the org: no manager');
  assert.deepEqual(newPersonOf({ name: 'Anna', title: 'Designer ', managerId: 'ag_1' }), { name: 'Anna', title: 'Designer', managerId: 'ag_1' });
  assert.equal(requestSlotHint({ named: false, waiting: 0 }), 'Enter their name above; their device’s request shows here');
  assert.equal(requestSlotHint({ named: false, waiting: 2 }), '2 devices ask to connect · enter their name above to accept');
  assert.equal(requestSlotHint({ named: true, waiting: 0 }), 'Waiting for their phone or PC to ask');
  assert.match(requestSlotHint({ named: true, waiting: 0, accepted: 'Anna' }), /^Accepted · Anna is added as their device connects/);
  assert.equal(browserReachable(['http://localhost:7300', 'http://127.0.0.1:7300']), false, 'only this PC');
  assert.equal(browserReachable(['http://localhost:7300', 'http://192.168.1.20:7300']), true, 'the network');
  assert.equal(browserReachable(['https://pc.tailnet.ts.net']), true, 'the tailnet');
});

test('F13: a second CEO – the role choice, its line for either role, and the role Accept and Copy link carry', async () => {
  const { newPersonOf, ROLE_OPTIONS, roleHint } = await import('../../../src/ui/team/people-model.ts');
  assert.deepEqual(newPersonOf({ name: 'Anna', title: '', managerId: '', role: 'ceo' }), { name: 'Anna', role: 'ceo' });
  assert.deepEqual(newPersonOf({ name: 'Anna', title: '', managerId: 'human', role: 'member' }), { name: 'Anna', managerId: 'human' }, 'a member is the default: no role sent');
  assert.deepEqual(ROLE_OPTIONS.map((option) => option.value), ['member', 'ceo']);
  assert.match(roleHint('ceo'), /^Like you: .*not your plans, keys, secrets, Settings or 1:1s$/);
  assert.ok(roleHint('ceo').length <= 110 && roleHint('member').length <= 110, 'two lines at phone width at most (the hint keeps two lines\' room)');
  const read = (file: string) => readFileSync(new URL(`../../../src/ui/${file}`, import.meta.url), 'utf8');
  assert.match(read('team/PersonNew.tsx'), /newPersonOf\(\{ name, title, managerId: manager, role \}\)/);
  assert.match(read('team/PersonNew.tsx'), /\{isOwner\(\) && \(/, 'only the owner gives the role');
  assert.match(read('team/PersonDialog.tsx'), /const roles = isOwner\(\) && !owner;/);
  assert.match(read('styles/people.css'), /\.person-role-hint \{[^}]*min-height: calc\(2 \* 1\.4em\)/);
});

test('F13/F14 wiring: Add › Person is a page (a pushed screen on the phone), a never-joined person offers Remove, the tree leaves invited people out', () => {
  const read = (file: string) => readFileSync(new URL(`../../../src/ui/${file}`, import.meta.url), 'utf8');
  assert.match(read('team/TeamNav.tsx'), /label: 'Person', onSelect: \(\) => go\.addPerson\(\)/);
  assert.doesNotMatch(read('team/person-dialogs.tsx'), /'new'/, 'no Add person dialog any more');
  const views = read('shell/views.ts');
  assert.match(views, /if \(current\.addPerson\) return \{ key: 'person-new', body: h\(PersonNew, null\) \};/);
  assert.match(views, /current\.agentId \|\| current\.personId \|\| current\.addPerson/, 'pushed on the phone, with its own Back row');
  const menus = read('team/menus.ts');
  assert.match(menus, /!joined \? \[\{ label: 'Remove', danger: true, onSelect: \(\) => void removePerson\(person\) \}\]/);
  assert.match(menus, /rpc\.call\('people\.remove', \{ id: person\.id \}\)/);
  assert.match(read('team/org-state.ts'), /peopleOrg\(split\.value\.members, /);
  assert.match(read('team/PersonNew.tsx'), /<IncomingRow key=\{request\.id\} request=\{request\} people=\{\[\]\} newPerson=\{fresh\}/);
  assert.match(read('lib/people.ts'), /rpc\.on\('person\.removed', \(\{ id \}\) => dropPerson\(id\)\)/);
});

test('17.11.2026 (F13 Pop-up, Mika draft 3+4) / 20.11.2026 (one way): "Invite a device" is a card on the person page – this PC\'s code, their request with Accept as them, a link for a browser', () => {
  const read = (file: string) => readFileSync(new URL(`../../../src/ui/${file}`, import.meta.url), 'utf8');
  const join = read('team/PersonJoin.tsx');
  assert.doesNotMatch(join, /<Dialog/, 'no modal dialog');
  assert.match(join, /<section ref=\{card\} class="person-join-card"/);
  assert.match(join, /if \(event\.key === 'Escape'\) \{ event\.stopPropagation\(\); props\.onClose\(\); \}/);
  assert.match(join, /<CodeRow \/>/, 'this PC\'s connect code, as on Add person');
  assert.match(join, /<IncomingRow key=\{request\.id\} request=\{request\} people=\{\[person\]\} personId=\{person\.id\}/, 'Accept makes it their device');
  assert.match(join, /rpc\.call\('people\.invite', \{ id: person\.id \}\)/, 'the link for a browser');
  assert.doesNotMatch(join, /invite\.code|Show code/, 'no person-scoped 6-digit code: one way');
  assert.match(read('settings/connect-rows.tsx'), /useState\(props\.personId \?\? \(employee \? NEW_PERSON : ''\)\)/, 'a given person first; Eine-ID: a new member opens with the name field');
  assert.doesNotMatch(read('team/person-dialogs.tsx'), /<PersonJoin/, 'not mounted as a dialog');
  assert.match(read('team/PersonView.tsx'), /\{person && inviteOpen\(personId\) && <PersonJoin person=\{person\} /);
  assert.match(read('team/menus.ts'), /onSelect: \(\) => inviteDevice\(person\) \}/);
  assert.doesNotMatch(read('settings/DevicesGroup.tsx'), /people\.invite|Phone for/, 'Connect a phone is this PC\'s QR only');
});

test('a task owner can be a person; For you holds only your own to-dos', () => {
  assert.deepEqual(ownerOf({ assigneeKind: 'human', assigneeId: 'per_a' }), { kind: 'person', id: 'per_a' });
  assert.deepEqual(ownerOf({ assigneeKind: 'human' }), { kind: 'human' });
  assert.equal(onForYouList({ assigneeKind: 'human', status: 'open' }), true);
  assert.equal(onForYouList({ assigneeKind: 'human', assigneeId: 'per_a', status: 'open' }), false, 'a colleague\'s to-do');
  assert.equal(onForYouList({ assigneeKind: 'human', assigneeId: 'owner', status: 'open' }), false, 'the CEO\'s, seen on a person\'s device');
  assert.equal(onForYouList({ assigneeKind: 'human', status: 'open', kind: 'quest' }), false, 'a quest of the person\'s is a goal: never on the list or the badge');
  assert.equal(onForYouList({ assigneeKind: 'human', status: 'open', kind: 'todo' }), true);
});

test('an invite address (#join=<ticket>) is recognised; other fragments are not', async () => {
  const { joinTicket } = await import('../../../src/ui/pwa/join.ts');
  const ticket = 'A'.repeat(43);
  assert.equal(joinTicket(`#join=${ticket}`), ticket);
  assert.equal(joinTicket(`#connect=${ticket}`), undefined);
  assert.equal(joinTicket('#join=short'), undefined);
});

test('the caller\'s own identity is the profile button\'s everywhere: Team › People, "Reports to" choices, names', async () => {
  const { selfIdentity, withSelf } = await import('../../../src/ui/lib/self-identity.ts');
  // The owner's row as the runtime sends it without a profile name: "CEO", empty initials.
  const ownerRow = person('human', 'CEO', { title: 'CEO', avatar: { kind: 'initials', value: '' } });
  assert.deepEqual(selfIdentity({ name: '' }, ownerRow), { name: 'You' }, 'no "CEO"/"C": "You", initials Y – as the profile button');
  assert.deepEqual(selfIdentity({ name: ' Gerd ', avatarFileId: 'f'.repeat(64) }, ownerRow), { name: 'Gerd', avatar: { kind: 'image', value: 'f'.repeat(64) } });
  assert.deepEqual(selfIdentity(undefined), { name: 'You' }, 'settings not loaded yet');
  // On a person's device 'human' is them: their directory avatar when the profile has no photo.
  assert.deepEqual(selfIdentity({ name: 'Anna' }, person('human', 'Anna', { avatar: { kind: 'emoji', value: '🦊' } })), { name: 'Anna', avatar: { kind: 'emoji', value: '🦊' } });
  const directory = withSelf([ownerRow, person('per_a', 'Anna')], { name: '' });
  assert.deepEqual(directory.map((entry) => entry.name), ['You', 'Anna']);
  assert.deepEqual(managerOptions('per_a', directory, []).map((option) => option.label).slice(1), ['You · CEO'], 'the "Reports to" choice names the owner the same way');
});
