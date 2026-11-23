// Doppelnachrichten and "[ran …]" posts (BEFUND-RUNTIME-JAN §2/§3, 17.11.2026): the safety net of finishTurn posted the
// final text into the person's chat although the same run had already answered there by `wf send` (35 times 13.–17.11.),
// and posted a final text that only imitated a call (Clara 17.11. 18:58, ch_4d6w7ctj #97). Before the fix each case below
// posted twice / posted the placeholder.
// Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import { answeredAlready, MIMICKED_NOTE, wordOverlap } from '../../../src/runtime/agents/net-repeat.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import type { ManualClock } from '../fakes.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { setup } from './fixture.ts';

async function turn() {
  const h = setup();
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Wie steht es mit den Bots?' });
  const request = h.request({ control: { lastSeq: 0, steeredSeq: 0 } });
  const plan = (await planTurn(h.services, request))!;
  h.db.run(`INSERT INTO runs (id, agent_id, conversation_id, trigger, status, started_at) VALUES (?, ?, ?, 'message', 'running', ?)`, [request.runId, h.tom.id, h.chat.id, h.clock.now()]);
  let seq = 0;
  const wfSend = (chatId: string, body: string) => h.chats.send({ conversationId: chatId, authorId: h.tom.id, authorKind: 'agent', runId: request.runId, body });
  const toolCalls = (count: number) => {
    for (let i = 0; i < count; i++) {
      (h.clock as ManualClock).advance(1_000);
      h.db.run(`INSERT INTO run_items (id, run_id, seq, kind, name, data, created_at) VALUES (?, ?, ?, 'tool_call', 'Bash', '{}', ?)`, [`ri_${++seq}`, request.runId, seq, h.clock.now()]);
    }
  };
  const finish = (text: string) => finishTurn(h.services, plan, h.routed(), request, h.attempt({ text, stop: 'done' }));
  const mine = (chatId: string) => h.chats.messages(chatId, { limit: 50 }).filter((message) => message.authorId === h.tom.id).map((message) => message.body);
  return { h, request, wfSend, toolCalls, finish, mine };
}

test('§2 (Lukas 17.11 17:36 #145/#146): wf send answered, then the final text says the same – posted once', async () => {
  const { h, wfSend, toolCalls, finish, mine } = await turn();
  wfSend(h.chat.id, 'Gute Idee. Noah fängt heute damit an, für alle Bots gleich: Wörter ziehen, Suche sofort starten.');
  toolCalls(1); // tasks.update
  (h.clock as ManualClock).advance(10_000);
  finish('Noah fängt heute noch an, deine Idee einzubauen, für alle Bots gleich: aus der Frage die Wörter ziehen und die Suche sofort starten.');
  assert.equal(mine(h.chat.id).length, 1);
});

test('§2: a different wording right after the send (no work between) stays in the run log too', async () => {
  const { h, wfSend, finish, mine } = await turn();
  wfSend(h.chat.id, 'Ja, Liquid d1 ist genau so ein Entscheidungsmodell.');
  (h.clock as ManualClock).advance(6_000);
  finish('Kurz gesagt: das schnelle Modell passt, Details siehe oben.');
  assert.deepEqual(mine(h.chat.id), ['Ja, Liquid d1 ist genau so ein Entscheidungsmodell.']);
});

test('§2 kept (Mika 17.11 10:40): real work after an early send – the final text is news and still posts', async () => {
  const { h, wfSend, toolCalls, finish, mine } = await turn();
  wfSend(h.chat.id, 'Passwort ist eingetragen, Stripe lädt gerade die Anmeldung.');
  toolCalls(12);
  finish('Bei Stripe ist noch nichts eingetragen: der Server ist überlastet, ich mache weiter, sobald Speicher frei ist.');
  assert.equal(mine(h.chat.id).length, 2);
});

test('§2 kept: a send only into another chat leaves the person\'s chat its answer', async () => {
  const { h, wfSend, finish, mine } = await turn();
  const other = h.chats.create({ agentIds: [h.tom.id], createdBy: HUMAN_ID });
  wfSend(other.id, 'Noah, bitte übernimm die Suche.');
  finish('Die Suche übernimmt Noah, Ergebnis bis Freitag.');
  assert.deepEqual(mine(h.chat.id), ['Die Suche übernimmt Noah, Ergebnis bis Freitag.']);
});

test('§3 (Clara 17.11 18:58): a final text that only imitates a call is never posted; the next turn reads why', async () => {
  const { h, finish, mine } = await turn();
  finish('[ran WebSearch: best text to speech API price quality comparison November 2026]');
  assert.deepEqual(mine(h.chat.id), []);
  const notes = h.db.all<{ value: string }>(`SELECT value FROM kv WHERE ns = 'repair_notes'`).map((row) => row.value).join('\n');
  assert.ok(notes.includes(MIMICKED_NOTE.slice(0, 40)), notes);
});

test('net-repeat: overlap and the work rule in isolation', async () => {
  assert.ok(wordOverlap('Die Bots bekommen wieder eine Internetsuche', 'Die Bots bekommen wieder eine Internetsuche, sauber') > 0.6);
  assert.ok(wordOverlap('Stripe ist eingetragen', 'Der Discord-Server bleibt beim Firmenkonto') < 0.1);
  const { h, request, wfSend } = await turn();
  const ask = (body: string) => answeredAlready(h.services, { runId: request.runId, agentId: h.tom.id, chatId: h.chat.id, body });
  assert.equal(ask('Etwas ganz anderes.'), false, 'nothing posted yet');
  wfSend(h.chat.id, 'Erster Stand.');
  (h.clock as ManualClock).advance(121_000);
  assert.equal(ask('Etwas ganz anderes nach langer Arbeit.'), false, 'more than two minutes later: news');
});
