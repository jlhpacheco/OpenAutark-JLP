// Approval requests (Sicher-Runde 19.11.2026, runtime/security/service.ts + approvals.ts + tasks/approval-todo.ts): a closed
// switch makes a request and a to-do with a choice; the call waits for the answer; once / always the setting / always
// the place / decline; a call that gave up leaves the request, and the late answer wakes the agent; the request survives a
// restart; the to-do's answer goes to the service without a chat line; an agent's own session never answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agent, harness } from '../chat/harness.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { Security } from '../../../src/runtime/security/service.ts';
import { securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';
import { securityOf } from '../../../src/shared/model/system.ts';
import { withCaller } from '../../../src/runtime/rpc/caller.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const root = path.resolve('approvals-root');
const outside = path.join(root, 'elsewhere', 'taxes.pdf');

function setup(security: Partial<SecuritySettings> = {}, waitMs = 5_000) {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  settings.update({ profile: { name: 'Mia' }, security: { ...securityDefaults('secure'), ...security } } as never);
  const services = h.services as RuntimeServices;
  services.settings = settings;
  services.paths = { data: path.join(root, 'data'), workspace: path.join(root, 'Workforce'), resources: path.join(root, 'res'), temp: path.join(root, 'data', 'tmp') } as RuntimeServices['paths'];
  h.org.add(agent('ag_tom', 'Tom'));
  const sec = new Security({ services: () => services, waitMs });
  services.security = sec;
  const todos = () => h.tasks.todos(50);
  return { ...h, settings, sec, todos, services };
}

const req = (extra: Partial<Parameters<Security['gate']>[0]> = {}) => ({ agentId: 'ag_tom', capability: 'commands' as const, summary: 'Run: npm install', fingerprint: 'fp_1', ...extra });

test('a closed switch asks: a request and a to-do with the choice; "once" lets the waiting call go on', async () => {
  const h = setup();
  const pending = h.sec.gate(req({ chatId: h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' }).id }));
  const [request] = h.sec.requests();
  assert.equal(request.capability, 'commands');
  assert.equal(request.agentName, 'Tom');
  assert.equal(request.summary, 'Run: npm install');
  const [todo] = h.todos();
  assert.equal(todo.title, 'Tom asks: Run: npm install');
  assert.deepEqual((todo.widget as unknown as { options: Array<{ value: string }> }).options.map((o) => o.value), ['once', 'setting', 'decline']);
  assert.ok(h.notified.some((n) => n.kind === 'todo'), 'pushed like every new to-do');
  h.sec.answer(request.id, 'once');
  assert.deepEqual(await pending, { ok: true });
  assert.equal(h.sec.requests().length, 0);
  assert.equal(h.tasks.get(todo.id)?.status, 'done');
  assert.equal(h.wakeRows().length, 0, 'the waiting call went on: no wake');
  assert.equal(securityOf(h.settings.get()).commands, 'ask', 'once changes no setting');
  // the next identical call asks again (the once was the waiting call)
  const again = h.sec.gate(req());
  assert.equal(h.sec.requests().length, 1);
  h.sec.answer(h.sec.requests()[0].id, 'decline');
  const declined = await again;
  assert.equal(declined.ok, false);
  assert.match((declined as { text: string }).text, /Mia declined "Run: npm install"/);
});

test('no answer in time: the call ends with my text, the request stays; the late "once" wakes me and lets the same step through once', async () => {
  const h = setup({}, 20);
  const result = await h.sec.gate(req({ taskId: undefined }));
  assert.equal(result.ok, false);
  assert.match((result as { text: string }).text, /request stays in Mia's to-dos; when they answer, I'm woken and the same step goes through/);
  const [request] = h.sec.requests();
  assert.ok(request, 'the request stays');
  h.sec.answer(request.id, 'once');
  const [wake] = h.wakeRows();
  assert.equal(wake.agent_id, 'ag_tom');
  assert.equal(wake.reason, 'answer');
  assert.match(wake.note ?? '', /Mia answered my request "Run: npm install": Allow once/);
  assert.deepEqual(await h.sec.gate(req()), { ok: true }, 'the grant lets the identical call through');
  const other = await h.sec.gate(req({ fingerprint: 'fp_2' }));
  assert.equal(other.ok, false, 'another call still asks');
});

test('"always the setting" opens the switch; "always the place" adds the folder', async () => {
  const h = setup();
  const pending = h.sec.gate(req());
  h.sec.answer(h.sec.requests()[0].id, 'setting');
  assert.deepEqual(await pending, { ok: true });
  assert.equal(securityOf(h.settings.get()).commands, 'yes');
  assert.deepEqual(await h.sec.gate(req({ fingerprint: 'fp_x' })), { ok: true }, 'open from now on');

  const read = h.sec.gate(req({ capability: 'read', path: outside, summary: `Read ${outside}`, fingerprint: 'fp_r' }));
  const [request] = h.sec.requests();
  assert.deepEqual(request.place, { kind: 'folder', value: path.dirname(outside) });
  const todo = h.todos().find((t) => t.title.includes('Read'));
  assert.ok((todo?.widget as unknown as { options: Array<{ label: string }> }).options.some((o) => o.label === `Always: ${path.dirname(outside)}`));
  h.sec.answer(request.id, 'place');
  assert.deepEqual(await read, { ok: true });
  assert.deepEqual(securityOf(h.settings.get()).readFolders, [path.dirname(outside)]);
  assert.equal(h.sec.check({ agentId: 'ag_tom', capability: 'read', path: path.join(path.dirname(outside), 'other.pdf'), fingerprint: 'f' }), 'open');
});

test('closed for good: money in Secure mode is refused without a request', async () => {
  const h = setup({ money: 'yes' });
  const result = await h.sec.gate(req({ capability: 'money', summary: 'Pay 20 EUR' }));
  assert.equal(result.ok, false);
  assert.match((result as { text: string }).text, /Spending money is closed on this PC/);
  assert.equal(h.sec.requests().length, 0);
  assert.equal(h.todos().length, 0);
});

test('the same step asked twice waits on one request; a turn that ends stops the wait', async () => {
  const h = setup();
  const stop = new AbortController();
  const first = h.sec.gate(req({ signal: stop.signal }));
  const second = h.sec.gate(req());
  assert.equal(h.sec.requests().length, 1);
  stop.abort();
  assert.equal((await first).ok, false);
  h.sec.answer(h.sec.requests()[0].id, 'once');
  assert.deepEqual(await second, { ok: true });
});

test('a request survives a restart (kv)', async () => {
  const h = setup({}, 10);
  await h.sec.gate(req());
  const again = new Security({ services: () => h.services, waitMs: 10 });
  assert.equal(again.requests().length, 1);
  assert.equal(again.requests()[0].summary, 'Run: npm install');
  again.answer(again.requests()[0].id, 'setting');
  assert.equal(securityOf(h.settings.get()).commands, 'yes');
  assert.equal(h.wakeRows().length, 1);
});

test('the to-do\'s answer goes to the service: no chat line, the waiting call goes on', async () => {
  const h = setup();
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const pending = h.sec.gate(req({ chatId: chat.id }));
  const [todo] = h.todos();
  const before = h.db.all('SELECT id FROM messages').length;
  const view = h.tasks.answer({ taskId: todo.id, answer: { choice: 'once' }, by: 'human' });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(view?.status, 'done');
  assert.equal(h.db.all('SELECT id FROM messages').length, before, 'no line in any chat');
  // a declined to-do ("Can't do this") is a decline
  const next = h.sec.gate(req({ fingerprint: 'fp_d' }));
  const second = h.todos().find((t) => t.status !== 'done' && t.id !== todo.id)!;
  h.tasks.answer({ taskId: second.id, answer: { declined: true }, by: 'human', decline: true });
  assert.equal((await next).ok, false);
});

test('an agent\'s own session never answers a request; Settings answers end the to-do', async () => {
  const h = setup({}, 10);
  await h.sec.gate(req());
  const [request] = h.sec.requests();
  assert.throws(() => withCaller({ scope: { kind: 'owner', agentId: 'ag_tom' } }, () => h.sec.answer(request.id, 'setting')), /answered by the person/);
  assert.throws(() => withCaller({ scope: { kind: 'owner', agentId: 'ag_tom' } }, () => h.tasks.answer({ taskId: h.todos()[0].id, answer: { choice: 'setting' }, by: 'human' })), /answered by the person/);
  withCaller({ scope: { kind: 'owner', person: true } }, () => h.sec.answer(request.id, 'decline'));
  assert.equal(h.todos().filter((t) => t.status === 'open').length, 0);
  assert.throws(() => h.sec.answer(request.id, 'once'), /no longer waiting/);
});

test('Trust AI mode: only its switches ask; fileScope is all', async () => {
  const h = setup();
  h.settings.update({ security: { ...securityDefaults('trust'), money: 'ask' } } as never);
  assert.deepEqual(await h.sec.gate(req()), { ok: true });
  assert.equal(h.sec.check({ agentId: 'ag_tom', capability: 'money', fingerprint: 'f' }), 'ask');
  const scope = h.sec.fileScope('ag_tom');
  assert.equal(scope.read, 'all');
  assert.deepEqual(scope.closed, []);
  assert.deepEqual(scope.guarded, []);
  h.settings.update({ security: securityDefaults('secure') } as never);
  const secure = h.sec.fileScope('ag_tom');
  assert.ok(Array.isArray(secure.write) && secure.write.includes(path.join(root, 'Workforce')));
  assert.deepEqual(secure.closed, [path.join(root, 'data', 'security')]);
  assert.deepEqual(secure.guarded, [path.join(root, 'Workforce', 'skills')]);
});
