// The first chat's opening lines (runtime/onboarding/service.ts start(), brief.ts, resources/prompts/onboarding.md, the
// onboarding.start RPC in rpc/handlers/app.ts). F07 (owner 15.11.2026): Start posts the start line in the person's voice
// (it says the app sent it) and B-090's fixed Manager line right below it, both written by the app – nobody wakes, no
// turn runs, the startup sweep finds nothing to answer. The person's answer is an ordinary message: one 'message' wake,
// exactly one Manager turn, routed as a person's request. onboarding.start takes no params.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Onboarding } from '../../../src/runtime/onboarding/service.ts';
import { BRIEF_MAX, setupLines, welcomeLanguage } from '../../../src/runtime/onboarding/brief.ts';
import { unansweredMessages } from '../../../src/runtime/chat/delivery-recovery.ts';
import { groupWakes } from '../../../src/runtime/agents/dispatch-groups.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { register as registerChats } from '../../../src/runtime/rpc/handlers/chats.ts';
import { register as registerApp } from '../../../src/runtime/rpc/handlers/app.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { agent, harness } from '../chat/harness.ts';
import { flush, setup as dispatcherSetup } from '../dispatcher/fakes.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
/** The five questions, in every shipped language. */
const QUESTIONS: Record<string, RegExp[]> = {
  de: [/\*\*Sprache:\*\*/, /\*\*Arbeitsweise:\*\*/, /\*\*Einrichten:\*\*/, /\*\*Namen:\*\*/, /\*\*Aufbau:\*\*/],
  fr: [/\*\*Langue :\*\*/, /\*\*Façon de travailler :\*\*/, /\*\*Installation :\*\*/, /\*\*Noms :\*\*/, /\*\*Structure :\*\*/],
  es: [/\*\*Idioma:\*\*/, /\*\*Forma de trabajar:\*\*/, /\*\*Configuración:\*\*/, /\*\*Nombres:\*\*/, /\*\*Estructura:\*\*/],
  en: [/\*\*Language:\*\*/, /\*\*Way of working:\*\*/, /\*\*Setup:\*\*/, /\*\*Names:\*\*/, /\*\*Structure:\*\*/],
};

/** The chat harness (real chats, delivery, wakes) with real settings and the shipped prompts – as service.test.ts. */
function withServices<H extends ReturnType<typeof harness>>(h: H) {
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  Object.assign(h.services, {
    settings, accounts: { list: () => [], detect: async () => ({}) },
    prompts: new PromptTemplates(() => path.join(RESOURCES, 'prompts')),
  });
  const services = h.services as RuntimeServices;
  const manager = h.org.add(agent('ag_boss', 'Manager', { mode: 'manager', template: 'manager', createdAt: 1 }));
  settings.update({ profile: { name: 'Lena Hess', company: 'Hess GmbH', language: 'de' } });
  return { ...h, services, settings, manager, onboarding: new Onboarding({ services: () => services }) };
}

/** The Manager's lines in a chat. */
const managerLines = (h: ReturnType<typeof withServices>, conversationId: string) => h.chats.messages(conversationId).filter((message) => message.authorId === h.manager.id);
/** The person's lines in a chat. */
const personLines = (h: ReturnType<typeof withServices>, conversationId: string) => h.chats.messages(conversationId).filter((message) => message.authorId === HUMAN_ID);
/** What every shipped start line begins with: it says the app sent it. */
const START: Record<string, RegExp> = {
  de: /^Von Autark gesendet, als ich auf Start geklickt habe: /,
  fr: /^Envoyé par Autark quand j'ai cliqué sur Start : /,
  es: /^Enviado por Autark cuando hice clic en Start: /,
  en: /^Sent by Autark when I clicked Start: /,
};

test("start(): the start line as the person's, the Manager's greeting right below it, in the profile's language; nobody wakes", () => {
  const h = withServices(harness());
  const { conversationId } = h.onboarding.start();

  const lines = h.chats.messages(conversationId).filter((message) => message.kind === 'text');
  assert.equal(lines.length, 2);
  const [opener, greeting] = lines;
  assert.equal(opener.authorId, HUMAN_ID, "the start line is the person's");
  assert.equal(opener.authorKind, 'human');
  assert.match(opener.body, START.de, 'it says the app sent it at Start');
  assert.ok(opener.body.length < 200, 'a short line: the plan is the Manager\'s');
  assert.equal(greeting.seq, opener.seq + 1, 'the greeting directly below it');
  assert.equal(greeting.authorId, h.manager.id, "the Manager's own message");
  assert.equal(greeting.authorKind, 'agent');
  assert.match(greeting.body, /^Hallo Lena Hess, ich bin dein Manager – deine rechte Hand in Autark\./);
  for (const question of QUESTIONS.de) assert.match(greeting.body, question);
  assert.match(greeting.body, /Dieser PC steht uns ganz offen\./, 'whole PC: the full setup question');
  assert.match(greeting.body, /Soll ich noch warten, sag es einfach/, 'the person decides when the work starts');
  assert.doesNotMatch(greeting.body, START.de, 'the start line is not repeated in the greeting');
  assert.equal(h.wakeRows().length, 0, 'no turn at Start');
  assert.deepEqual(unansweredMessages(h.services), [], 'the startup sweep finds nothing to answer either');
  const managerCursor = h.chats.members(conversationId).find((member) => member.memberId === h.manager.id)?.readSeq ?? 0;
  assert.ok(managerCursor < opener.seq, 'the Manager has not read the start line yet: its first turn reads both lines');
  assert.deepEqual(h.settings.get().onboarding, { completed: true, step: 'done' });
});

test("the person's answer is the first turn: one 'message' wake with no note, one group", () => {
  const h = withServices(harness());
  const { conversationId } = h.onboarding.start();
  h.chats.send({ conversationId, body: 'Deutsch mit mir, intern Englisch. Leg los.', authorId: HUMAN_ID, authorKind: 'human' });
  const rows = h.wakeRows().filter((row) => row.agent_id === h.manager.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversation_id, conversationId);
  assert.equal(rows[0].reason, 'message');
  assert.equal(rows[0].note, null, 'no separate note');
  assert.equal(groupWakes(h.wakes.claim(h.manager.id)).length, 1, 'one claim, one group: one turn');
});

test('asked twice: the two lines once; after "Set up team again" with an answer in between, both again', () => {
  const h = withServices(harness());
  const first = h.onboarding.start();
  assert.deepEqual(h.onboarding.start(), first, 'the same chat again');
  assert.equal(managerLines(h, first.conversationId).length, 1, 'never posted twice');
  assert.equal(personLines(h, first.conversationId).length, 1, 'the start line neither');
  h.chats.send({ conversationId: first.conversationId, body: 'Später.', authorId: HUMAN_ID, authorKind: 'human' });
  h.wakes.done(h.wakes.claim(h.manager.id).map((wake) => wake.id)); // the answer's own wake is not this test's
  h.onboarding.reset();
  h.onboarding.start();
  assert.equal(managerLines(h, first.conversationId).length, 2, 'the person answered: the first message is the newest line again');
  assert.deepEqual(h.chats.messages(first.conversationId).slice(-2).map((message) => message.authorId), [HUMAN_ID, h.manager.id], 'start line, then greeting');
  assert.equal(h.wakeRows().length, 0, 'the second start wakes nobody either');
});

test('an own prompt without a start part posts the greeting alone; the shipped prompt and the fallback carry both lines', () => {
  const h = withServices(harness());
  const own = (text: string) => setupLines({ ...h.services, prompts: { text: () => text } } as unknown as RuntimeServices);
  assert.deepEqual(own('Hi {{name}}, I am here.'), { start: '', answer: 'Hi Lena Hess, I am here.' }, 'no start part: no start line');
  assert.deepEqual(own('{{#start}}Started by {{name}}.{{/start}}{{^start}}Hello.{{/start}}'), { start: 'Started by Lena Hess.', answer: 'Hello.' });
  Object.assign(h.services, { prompts: { text: () => 'Only my own greeting.' } });
  const { conversationId } = h.onboarding.start();
  assert.deepEqual(h.chats.messages(conversationId).map((message) => [message.authorId, message.body]), [[h.manager.id, 'Only my own greeting.']]);
  h.settings.update({ profile: { language: 'en' } });
  const fallback = setupLines({ ...h.services, prompts: undefined } as unknown as RuntimeServices);
  assert.match(fallback.start, START.en);
  assert.match(fallback.answer, /^Hi Lena Hess, I'm your Manager/);
});

test('every shipped language has the five questions; other languages get English; Secure mode asks for its own area', () => {
  const h = withServices(harness());
  for (const [code, expected] of [['de-AT', 'de'], ['fr', 'fr'], ['es-MX', 'es'], ['en-GB', 'en'], ['it', 'en'], ['', 'en'], [undefined, 'en']] as const) assert.equal(welcomeLanguage(code), expected, String(code));
  for (const code of ['de', 'fr', 'es', 'en']) {
    for (const careful of [false, true]) {
      h.settings.update({ profile: { language: code }, security: { mode: careful ? 'secure' : 'trust' } });
      const { start, answer: text } = setupLines(h.services);
      assert.match(start, START[code], `${code}: its own start line`);
      assert.doesNotMatch(start, /\{\{|<!--|\u0000|\n/, `${code}: one clean line`);
      for (const question of QUESTIONS[code]) assert.doesNotMatch(start, question, `${code}: the questions are the Manager's`);
      for (const question of QUESTIONS[code]) assert.match(text, question, `${code} ${careful}`);
      for (const other of Object.keys(QUESTIONS).filter((key) => key !== code)) assert.doesNotMatch(text, QUESTIONS[other][3], `${code}: only its own section`);
      assert.match(text, /Lena Hess/);
      assert.match(text, /Ultra/);
      assert.doesNotMatch(text, /\{\{|<!--|\u0000/, 'no placeholder, maintainer note or gap left');
      assert.ok(text.length < BRIEF_MAX, `${code}: ${text.length}`);
      assert.match(text, careful ? /(eigenen Bereich|propre espace|propio espacio|own area)/ : /(ganz offen|entièrement ouvert|totalmente abierto|fully open)/, `${code} ${careful}`);
    }
  }
  h.settings.update({ profile: { language: 'it', name: '' }, security: { mode: 'trust' } });
  assert.match(setupLines(h.services).answer, /^Hi, I'm your Manager/, 'no name leaves no gap');
});

test('the fallback is the shipped English text; an own prompt replaces them and is cut when far too long', () => {
  const h = withServices(harness());
  h.settings.update({ profile: { language: 'en' } });
  const shipped = setupLines(h.services);
  assert.deepEqual(setupLines({ ...h.services, prompts: undefined } as unknown as RuntimeServices), shipped, 'the fallback');
  assert.deepEqual(setupLines({ ...h.services, prompts: { text: () => { throw new Error('locked'); } } } as unknown as RuntimeServices), shipped, 'an unreadable prompt');
  const own = (text: string) => setupLines({ ...h.services, prompts: { text: () => text } } as unknown as RuntimeServices).answer;
  assert.equal(own('Hi from {{name}} of {{company}} in {{language}}'), 'Hi from Lena Hess of Hess GmbH in English');
  assert.equal(own(`${'y'.repeat(5000)} {{name}}`).length, BRIEF_MAX);
});

test('an own prompt that renders to nothing posts nothing and still ends the first run', () => {
  const h = withServices(harness());
  Object.assign(h.services, { prompts: { text: () => '{{#unknown}}never{{/unknown}}' } });
  const { conversationId } = h.onboarding.start();
  assert.equal(h.chats.messages(conversationId).length, 0);
  assert.deepEqual(h.settings.get().onboarding, { completed: true, step: 'done' });
});

test('real dispatcher: no turn at Start; the answer gives exactly ONE Manager turn, no notes', async () => {
  const h = withServices(dispatcherSetup());
  h.dispatcher.start();
  const { conversationId } = h.onboarding.start();
  await flush();
  assert.equal(h.executor.calls.length, 0, 'the first message is no turn');
  h.chats.send({ conversationId, body: 'Leg los.', authorId: HUMAN_ID, authorKind: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 1, 'one turn');
  const turn = h.executor.last().request;
  assert.equal(turn.agentId, h.manager.id);
  assert.equal(turn.conversationId, conversationId);
  assert.equal(turn.reason, 'message');
  assert.deepEqual(turn.notes, []);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'no second turn');
  assert.equal(h.wakeRows().length, 0, 'nothing left in the queue');
});

test('"Set up team again" while a Manager task in that chat waits on the person: the first message wakes nobody, the answer carries the task', async () => {
  const h = withServices(dispatcherSetup());
  const chat = h.chats.create({ agentIds: [h.manager.id], createdBy: 'human' }); // the Manager's first chat
  const task = h.tasks.create({ conversationId: chat.id, title: 'Book the venue', assigneeKind: 'agent', assigneeId: h.manager.id, createdBy: HUMAN_ID });
  h.tasks.update(task.id, { status: 'waiting' as const, waitingOn: { on: 'who' as const, who: 'human', why: 'Which date?' } }, h.manager.id);
  h.wakes.done(h.wakes.claim(h.manager.id).map((wake) => wake.id)); // what the task itself queued is not this test's
  h.dispatcher.start();
  const { conversationId } = h.onboarding.start();
  assert.equal(conversationId, chat.id);
  assert.equal(h.chats.get(chat.id)?.title, chat.title, 'the start line names no chat');
  await flush();
  assert.equal(h.executor.calls.length, 0, 'the first message is no turn');
  h.chats.send({ conversationId, body: 'Am Freitag.', authorId: HUMAN_ID, authorKind: 'human' });
  // B-089: a wait set outside its own turn plans its re-check a day later (tasks/transitions.ts) – that one stands beside the message wake
  const rows = h.wakeRows().filter((row) => row.agent_id === h.manager.id && row.reason !== 'review');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, task.id);
  assert.equal(rows[0].note ?? null, null); // the person's line itself is the news
  await flush();
  assert.equal(h.executor.calls.length, 1);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'no second Manager turn');
});

test('onboarding.start takes no params: any key is refused and starts nothing; the plain call posts the first message', async (t) => {
  const table = new HandlerTable();
  registerChats(table);
  registerApp(table);
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  const onboarding = new Onboarding({ services: () => f.services });
  Object.assign(f.extras, { onboarding });
  const boss = f.org.add(agent('ag_boss', 'Boss', { mode: 'manager', template: 'manager' }));
  const owner = new TestClient(f.server, OWNER);

  for (const params of [{ firstTask: 'Plan the launch' }, { chat: 'x' }]) {
    const response = await owner.request('onboarding.start', params);
    assert.equal(response.error?.code, 'bad_request', JSON.stringify(params));
  }
  assert.equal(f.services.settings.get().onboarding.step, 'tour', 'still the first step (B-055 Q5: the tour)');

  const { conversationId } = await owner.call<{ conversationId: string }>('onboarding.start');
  const posted = f.chats.messages(conversationId);
  assert.equal(posted.at(-1)?.authorId, boss.id, "the Manager's first message is the newest line");
  assert.ok(posted.length <= 2 && posted.slice(0, -1).every((message) => message.authorId === HUMAN_ID), 'at most the start line before it');
  assert.equal(f.wakeRows().length, 0, 'nobody wakes');
  assert.deepEqual(f.services.settings.get().onboarding, { completed: true, step: 'done' });
});
