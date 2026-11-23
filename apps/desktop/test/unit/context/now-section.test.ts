// B-083 (track D): the volatile "## Now" says what I run on – model · effort and the turn's temperature (where the model
// samples at its own setting, as my stance for the step) –, and my start model and who set it (ModelPolicy.pinBy); the
// person's suggestion in a chat stands on their line, not here (13.11.2026). Without any of them it stays the one line it
// was. B-083 (live 09.11.): a stance names where a temperature reaches; owner 09.11.: Claude keeps its thinking, so there
// it is a stance. Halb 21.11.2026: how big my context is, from my session's own count.
// Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { fixture, route, VIDEO_MODE } from './fixture.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';

const DAY = 86_400_000;

function nowOf(f: ReturnType<typeof fixture>, input: { agentId?: string; conversationId?: string; route?: RouteDecision }): string {
  const target = f.org.get(input.agentId ?? f.vid.id)!;
  const { volatile } = f.context.prompt({ agent: target, conversationId: input.conversationId, mode: VIDEO_MODE, route: input.route ?? route() });
  const start = volatile.indexOf('## Now');
  const end = volatile.indexOf('\n\n', start);
  return volatile.slice(start, end < 0 ? undefined : end);
}

test('without a temperature, start model or suggestion: the one line it was', () => {
  const f = fixture();
  const now = nowOf(f, {});
  assert.deepEqual(now.split('\n').slice(2), ['I run on GPT-6.1 Sol · effort high, in Codex.'] /* owner 15.11.: the engine of this turn */);
});

test('a temperature the model takes is part of what I run on; one it does not take is my stance for the step', () => {
  const f = fixture();
  const sent = nowOf(f, { route: { ...route('compatible:qwen'), engine: 'compatible', temperature: 0.3 } });
  assert.ok(sent.includes('I run on compatible:qwen · effort high · temperature 0.3, in '), sent);
  const stance = nowOf(f, { route: { ...route(), temperature: 0.7 } });
  assert.ok(stance.includes('I run on GPT-6.1 Sol · effort high, in Codex; temperature 0.7 is my stance for this step, as this model samples at its own setting – my thinking comes first, so a temperature goes only where it costs none: to the API and local models that take one (models.list marks them); Claude and Codex keep their own setting (older Claude models take one only without thinking, the newer ones none, Codex not at all) – there my drafts carry the variety.'), stance);
});

test('B-083 (owner 09.11.): on Claude every model keeps its thinking, so a temperature is my stance there; the API sends it to an older model that runs without thinking', () => {
  const f = fixture();
  for (const id of ['claude-sonnet-4-6', 'claude-opus-5-5']) {
    const stance = nowOf(f, { route: { ...route(`claude:${id}`), engine: 'claude', temperature: 0.3 } });
    assert.match(stance, new RegExp(`I run on claude:${id} · effort high, in [^;]+; temperature 0\.3 is my stance for this step, as this model samples at its own setting – my thinking comes first`), stance);
  }
  const sent = nowOf(f, { route: { ...route('anthropic:claude-haiku-4-5'), engine: 'anthropic', temperature: 0.3 } });
  assert.ok(sent.includes('I run on anthropic:claude-haiku-4-5 · effort high · temperature 0.3, in '), sent);
});

test('my start model names who set it and when – the person on my page, a manager by name, or I myself; an old pin without origin just the model', () => {
  const f = fixture();
  const at = f.clock.now() - DAY;
  f.org.add(agent('ag_pia', 'Pia', { modelPolicy: { pin: 'codex:luna', pinBy: { name: 'Alex', at } } })); // the owner's profile name
  f.org.add(agent('ag_kim', 'Kim', { modelPolicy: { pin: 'codex:luna', pinBy: { name: 'Konrad', at } } })); // a manager's agents.update
  f.org.add(agent('ag_ole', 'Ole', { modelPolicy: { pin: 'codex:gpt-6.1-sol', pinBy: { name: 'Ole', at, self: true } } }));
  f.org.add(agent('ag_old', 'Old', { modelPolicy: { pin: 'codex:luna' } }));
  assert.ok(nowOf(f, { agentId: 'ag_pia' }).includes('My start model: Luna (set by Alex on my page, Fri 16 Oct).'));
  assert.ok(nowOf(f, { agentId: 'ag_kim' }).includes('My start model: Luna (set by Konrad, Fri 16 Oct).'));
  assert.ok(nowOf(f, { agentId: 'ag_ole' }).includes('My start model: GPT-6.1 Sol (I set it myself, Fri 16 Oct).'));
  assert.ok(nowOf(f, { agentId: 'ag_old' }).includes('My start model: Luna.'));
  assert.ok(!nowOf(f, {}).includes('start model'), 'no start model: no line');
});

test("Halb 21.11.2026: my context's size from my session's own count, rounded to 5k – none below 20k and none for a part", () => {
  const f = fixture();
  const engine = route().engine;
  const sizeOf = (tokens: number | undefined, thread = 'main'): string => {
    new SessionStore(f.db).save({ agentId: f.vid.id, conversationId: thread, engine, ref: 'thr_1', generation: 1, cursorSeq: 0, ...(tokens !== undefined ? { contextTokens: tokens } : {}), updatedAt: 0 });
    const { volatile } = f.context.prompt({ agent: f.vid, mode: VIDEO_MODE, route: route(), thread });
    const start = volatile.indexOf('## Now');
    return volatile.slice(start, volatile.indexOf('\n\n', start) < 0 ? undefined : volatile.indexOf('\n\n', start));
  };
  assert.ok(sizeOf(152_400).endsWith('\nMy context holds about 150k tokens; each step of mine reads it again.'), sizeOf(152_400));
  assert.ok(sizeOf(22_600).includes('My context holds about 25k tokens;'));
  assert.ok(!sizeOf(19_000).includes('My context'), 'below 20k: nothing to say');
  assert.ok(!sizeOf(undefined).includes('My context'), 'no count yet');
  assert.ok(!sizeOf(300_000, 'split:spl_1').includes('My context'), 'a part starts small and ends');
});

test("13.11.2026: the person's suggestion in this chat is not in \"## Now\" – it stands on their line (context/render.ts)", () => {
  const f = fixture();
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  f.chats.update(chat.id, { settings: { modelHints: { [f.vid.id]: 'codex:luna' }, efforts: { [f.vid.id]: 'high' }, temperatures: { [f.vid.id]: 0.4 } } }, 'human');
  assert.doesNotMatch(nowOf(f, { conversationId: chat.id }), /suggest/);
});
