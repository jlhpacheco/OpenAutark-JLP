// Runde „Halb“ 21.11.2026: a chat riding along in a turn (TurnRequest.riders) – its notes under its chat's label and its
// unseen lines in the turn's input after the turn's own; a done turn moves that chat's read cursor over them, a failed one
// does not. Real chats and planTurn/buildTurn/finishTurn; a fake delta and engine result.
// Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurn, planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import { setup } from './fixture.ts';

function scene() {
  const h = setup();
  const other = h.chats.create({ title: 'Einkauf', agentIds: [h.tom.id], createdBy: 'human' });
  const own = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Draft the offer' });
  const line = h.chats.send({ conversationId: other.id, authorId: 'human', body: 'Buy milk too' });
  h.services.context.delta = (input) => input.conversationId === other.id
    ? { text: `[${other.id} "Einkauf" · Lena · 10:00 #${line.seq}] Buy milk too`, images: [], lastSeq: line.seq }
    : { text: `[${h.chat.id} · Lena · 10:00 #${own.seq}] Draft the offer`, images: [], lastSeq: own.seq };
  const cursor = (chatId: string) => h.chats.members(chatId).find((member) => member.memberId === h.tom.id)!.readSeq;
  const turn = async (stop: 'done' | 'error') => {
    const request = h.request({ riders: [{ conversationId: other.id, notes: [{ text: '[ui-answer] yes', at: h.clock.now(), reason: 'answer' }] }] });
    const plan = (await planTurn(h.services, request))!;
    const built = await buildTurn(h.services, plan, request, h.route, []);
    const text = built.input.map((part) => (part.type === 'text' ? part.text : '')).join('');
    const result = stop === 'done' ? { text: 'On it.', stop } as const : { text: '', stop, error: { code: 'internal' as const, message: 'failed' } };
    finishTurn(h.services, plan, built, request, h.attempt(result), undefined);
    return text;
  };
  return { ...h, other, own, line, cursor, turn };
}

test('a riding chat: its note under its label and its lines after the turn\'s own; a done turn moves both cursors', async () => {
  const h = scene();
  const text = await h.turn('done');
  const own = text.indexOf('Draft the offer');
  const note = text.indexOf(`· ${h.other.id} "Einkauf"] [ui-answer] yes`);
  const milk = text.indexOf('Buy milk too');
  assert.ok(own >= 0 && note > own && milk > note, text);
  assert.match(text, /\[note · [^\]]+ · ch_\w+ "Einkauf"\] \[ui-answer\] yes/, 'the note label names its chat');
  assert.doesNotMatch(text, /Nothing new arrived/);
  assert.equal(h.cursor(h.chat.id), h.own.seq);
  assert.ok(h.cursor(h.other.id) >= h.line.seq, "the riding chat's line counts as seen");
});

test('a riding chat after a failed turn: its cursor stays, its line is delivered again', async () => {
  const h = scene();
  await h.turn('error');
  assert.equal(h.cursor(h.other.id), 0);
});
