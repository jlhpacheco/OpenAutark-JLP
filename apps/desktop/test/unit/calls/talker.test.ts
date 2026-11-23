// The call voice (src/runtime/calls/talker.ts) with the real chat service and delivery and a scripted voice (voice-fake.ts):
// KI-Runde 17.11.2026 – one kept conversation per call, opened with what the agent's work knows; a spoken line stored quiet
// is answered from that state at once, sentence by sentence into a row that is 'streaming' until the answer ends; the tags
// are never spoken and pass work on now or at the next step; a line that is not for the agent is answered with silence; in
// a team call the opening tag names who speaks; the end of the call wakes the agents the voice names and leaves the call's
// lines for every agent of the chat; a call that ends while the voice writes keeps what was already said; a hand-over that
// is not steered is the note of the agent's wake; a quiet line of the agent's work and a run that ended are the voice's
// next inputs, which it may say.
// Owns: these assertions only. Never: a real model (no live run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { quietPickupLine } from '../../../src/runtime/chat/quiet-pickup.ts';
import { CALL_WAKE, CallTalker, actsOn, handOver } from '../../../src/runtime/calls/talker.ts';
import { CALL_VOICE, voiceEndAsk, workLine } from '../../../src/runtime/calls/talker-prompt.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { callRecord } from '../../../src/shared/model/call.ts';
import { createCalls, stopCalls } from '../../../src/runtime/calls/wiring.ts';
import { agent, harness } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { fakeVoice, type FakeSaid } from './voice-fake.ts';

const CALL = 'call_talk1';

function setup(answers: (input: string, index: number) => FakeSaid, voice: Record<string, unknown> = {}) {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava', { role: 'Assistant' }));
  h.org.add(agent('ag_ben', 'Ben'));
  const solo = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const group = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID, lead: 'ag_ben' });
  const direct = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID, settings: { direct: true, directPair: ['ag_ben', HUMAN_ID] } }); // Ben's 1:1, Ava added
  Object.assign(h.services, {
    secrets: { redact: (text: string) => text.replace('s3cret', '[hidden]') },
    settings: { get: () => ({ profile: { name: 'Gerd', language: 'de' }, voice: { vocabulary: ['Teydra'], ...voice } }) },
  });
  const steers: Array<{ agentId: string; conversationId: string; text: string; mode: string }> = [];
  const steerable = { value: false };
  Object.assign(h.services.dispatcher, {
    relay: async (agentId: string, conversationId: string, text: string, mode: string) => { steers.push({ agentId, conversationId, text, mode }); return steerable.value; },
  });
  const fake = fakeVoice(answers);
  const joined: string[] = [];
  const record: { id: string; participant: string; name: string; startedAt: number; lines: Array<{ at: number; from: string; name: string; text: string }>; ring?: { by: string; why: string; until: number } } = { id: CALL, participant: 'device:pc', name: 'Office PC', startedAt: 0, lines: [{ at: 1, from: 'device:pc', name: 'Gerd', text: 'Wie weit bist du?' }] };
  const talker = new CallTalker({
    services: () => h.services as RuntimeServices, voice: fake.opener,
    calls: { record: () => record as never, join: (_chat, _call, agentId) => joined.push(agentId) },
  });
  const say = (body: string, conversationId = solo.id): Message => {
    const message = h.chats.send({ conversationId, body, authorId: HUMAN_ID, authorKind: 'human', silent: true, speech: { source: 'endpoint', live: true }, meta: { call: { id: CALL, participant: 'device:pc', name: 'Office PC' } } });
    talker.heard(message);
    return message;
  };
  const rows = (conversationId = solo.id) => h.chats.messages(conversationId, { limit: 30 }).filter((message) => message.meta.call?.voice === 'talker');
  return { ...h, solo, group, direct, talker, fake, steers, steerable, joined, say, rows, record };
}

const settled = async () => { for (let round = 0; round < 8; round++) await new Promise<void>((resolve) => setTimeout(resolve, 5)); };

test('a line answered from the state: the voice speaks as the agent at once, nobody is woken, and the line is no pickup', async () => {
  const h = setup(() => 'Mir geht es gut, der Build läuft noch.');
  const line = h.say('Wie geht es dir?');
  assert.equal(line.silent, true);
  assert.equal(quietPickupLine(line), false, 'a call line is not picked up later');
  await settled();
  const [said] = h.rows();
  assert.equal(said.body, 'Mir geht es gut, der Build läuft noch.');
  assert.equal(said.authorId, 'ag_ava');
  assert.equal(said.state, 'final');
  assert.equal(said.silent, false, 'the device reads it aloud');
  assert.equal(said.meta.model, 'fake:small');
  assert.equal(said.meta.call?.id, CALL, 'the same call');
  assert.equal(h.wakes.list('ag_ava').length, 0);
  assert.equal(h.fake.opens.length, 1, 'one conversation for the call');
  assert.match(h.fake.inputs[0], /Gerd said: "Wie geht es dir\?"/);
});

test('the stable part: who I am, how I speak on a call, the tags and what my work knows (the live bar, my tasks, this chat)', async () => {
  const h = setup(() => 'Ok.');
  h.tasks.create({ title: 'Checkout prüfen', notes: '', assigneeKind: 'agent', assigneeId: 'ag_ava', conversationId: h.solo.id, createdBy: HUMAN_ID });
  h.chats.send({ conversationId: h.solo.id, body: 'Vorher gesagt', authorId: 'ag_ava', authorKind: 'agent', silent: true });
  h.running.push({ agentId: 'ag_ava', runId: 'run_1', conversationId: 'other', note: 'running tests', startedAt: 0 } as never);
  h.say('Das Passwort ist s3cret');
  await settled();
  const [open] = h.fake.opens;
  assert.equal(open.purpose, 'call voice');
  assert.match(open.system, /live voice of Ava/);
  assert.match(open.system, /I am on a call\./, 'CALL_VOICE');
  assert.match(open.system, /Everything I say is heard once[^.]*so I shape each answer for the ear\./, 'TALK 19.11.: written for the ear');
  assert.match(open.system, /<main now>/, 'the tags are named and not spoken');
  assert.match(open.system, /profile language is de/);
  assert.match(open.system, /by first name and in the familiar form/, 'B-078: as the realtime brief (voiceSelf)');
  assert.match(open.system, /What my work knows right now:/);
  assert.match(open.system, /My work right now: busy in another chat \(running tests\)\./);
  assert.match(open.system, /My open tasks:\n- Checkout prüfen \(open\)/);
  assert.match(open.system, /The last lines of this chat:\nme: Vorher gesagt/);
  assert.equal(h.fake.inputs[0].includes('s3cret'), false, 'a secret value stays out of what the voice is told');
  assert.match(h.fake.inputs[0], /\[hidden\]/);
});

test('each finished sentence reaches the reader while the voice still writes, and the row is final with the whole answer', async () => {
  const h = setup(() => 'Der Build läuft noch durch. Danach schicke ich dir die Zahlen.');
  h.say('Wie weit ist der Build?');
  await settled();
  const updates = h.of('message.updated').filter((message) => message.meta.call?.voice === 'talker');
  const created = h.of('message.created').filter((message) => message.meta.call?.voice === 'talker');
  assert.equal(created.length, 1);
  assert.equal(created[0].state, 'streaming', 'the row opens with the first finished sentence');
  assert.equal(created[0].body, 'Der Build läuft noch durch.');
  assert.ok(updates.length >= 1, 'it grows while the model writes');
  assert.equal(updates.at(-1)!.state, 'final');
  assert.equal(updates.at(-1)!.body, 'Der Build läuft noch durch. Danach schicke ich dir die Zahlen.');
  assert.equal(h.rows().length, 1, 'one row, not one per sentence');
});

test('now: steered into the running turn wherever it runs, else delivered with this chat next; next: the soft steer, else a queued wake', async () => {
  const now = setup(() => 'Mache ich sofort. <main now>Stop the deploy and tell me what the last build did.</main>');
  now.steerable.value = true;
  now.say('Stopp den Deploy.');
  await settled();
  assert.equal(now.steers.length, 1);
  assert.equal(now.steers[0].mode, 'now');
  assert.equal(now.rows()[0].body, 'Mache ich sofort.', 'the tag is never spoken');
  assert.match(now.steers[0].text, /The person said: "Stopp den Deploy\."/);
  assert.match(now.steers[0].text, /My voice told them: "Mache ich sofort\."/);
  assert.match(now.steers[0].text, /What my voice passes on: "Stop the deploy/);
  assert.equal(now.wakes.list('ag_ava').length, 0);

  now.steerable.value = false;
  now.say('Und noch eins.');
  await settled();
  assert.equal(now.wakes.list('ag_ava').length, 1);
  assert.match(now.wakeRows()[0].note ?? '', /\[Live call: my live voice passes this on now\][\s\S]*The person said: "Und noch eins\."/, 'the wake carries the hand-over as what it is');
  assert.deepEqual(now.urgent, [{ agentId: 'ag_ava', conversationId: now.solo.id }]);

  const next = setup(() => 'Notiere ich mir. <main next>Use blue for the banner.</main>');
  next.steerable.value = true;
  next.say('Nimm lieber Blau.');
  await settled();
  assert.equal(next.steers[0].mode, 'next');
  assert.equal(next.wakes.list('ag_ava').length, 0, 'nothing has to stop and nothing is queued');
  next.steerable.value = false;
  next.say('Und das Logo kleiner.');
  await settled();
  assert.equal(next.wakes.list('ag_ava').length, 1, 'no steer: the agent reads it at its next turn');
  assert.match(next.wakeRows()[0].note ?? '', /passes this on for my next step[\s\S]*What my voice passes on: "Use blue for the banner\."/);
  assert.equal(next.urgent.length, 0, 'next never cuts');
});

test('a line that is not for me: the voice says nothing and the line stays quiet in the chat', async () => {
  const h = setup(() => '   ');
  h.say('… also dann machen wir das so, oder?');
  await settled();
  assert.equal(h.rows().length, 0, 'no line of the voice');
  assert.equal(h.wakes.list('ag_ava').length, 0, 'and nobody is woken');
});

test('silence has a form (FIXES-3 E1): the voice knows <silent/>, and an answer with it leaves no row, steers nothing and wakes nobody', async () => {
  const h = setup(() => '<silent/> <main next>Den Kellerschlüssel suchen</main>');
  h.say('Moment, Jonas, hast du den Schlüssel für den Keller gesehen?');
  await settled();
  assert.match(h.fake.opens[0].system, /<silent\/>/, 'CALL_VOICE gives silence its form');
  assert.equal(h.rows().length, 0, 'no line of the voice');
  assert.deepEqual(h.steers, [], 'nothing is passed on');
  assert.equal(h.wakes.list('ag_ava').length, 0, 'and nobody is woken');
});

test('silence written out before its tag (FIXES-3 E1, review R1): the row closes without those words and passes nothing on', async () => {
  const h = setup(() => 'Das Gespräch ist nicht für mich. <silent/>');
  h.say('Moment, Jonas, hast du den Schlüssel für den Keller gesehen?');
  await settled();
  assert.deepEqual(h.rows().map((row) => row.body).filter(Boolean), [], 'nothing of it is kept as said');
  assert.deepEqual(h.steers, []);
  assert.equal(h.wakes.list('ag_ava').length, 0);
});

test('a failed answer: the agent answers through the normal delivery; lines said meanwhile are answered together, once', async () => {
  const failed = setup(() => new Error('no route'));
  failed.say('Hallo?');
  await settled();
  assert.equal(failed.rows().length, 0);
  assert.equal(failed.wakes.list('ag_ava').length, 1, 'the agent is woken');

  const together = setup((input) => (input.includes('Zweitens') ? 'Beides klar.' : { stream: 'Erst', then: 'hang' }));
  together.say('Erstens');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  together.say('Zweitens');
  await settled();
  assert.equal(together.fake.inputs.length, 2);
  assert.match(together.fake.inputs[1], /"Erstens" "Zweitens"/, 'asked again with every unanswered line');
  assert.equal(together.rows().at(-1)!.body, 'Beides klar.');
});

test('a team call: the opening tag names who speaks, a listening agent joins, no tag is nobody', async () => {
  const h = setup(() => '<as name="Ava">Ich bin noch an der API, zwei Tage.');
  h.say('Wie weit ist die API?', h.group.id);
  await settled();
  const [said] = h.rows(h.group.id);
  assert.equal(said.authorId, 'ag_ava', 'the one the tag names, not the lead');
  assert.equal(said.body, 'Ich bin noch an der API, zwei Tage.');
  assert.deepEqual(h.joined, ['ag_ava'], 'a listening agent that speaks is in the call');
  assert.match(h.fake.opens[0].system, /I speak for each agent in the call as that agent/);
  assert.match(h.fake.opens[0].system, /Gerd started this call/, 'the text says who started it');

  const nobody = setup(() => 'Das sagt der Chef dann schon.');
  nobody.say('Das klären wir morgen.', nobody.group.id);
  await settled();
  assert.equal(nobody.rows(nobody.group.id).length, 0, 'without the tag nobody speaks');
});

test('the end of the call: the voice names per agent what it acts on – those are woken, every agent of the chat gets the call\'s lines', async () => {
  const h = setup((input) => (input.startsWith('The call has ended') ? 'Ava: yes – sie wartet auf die Zahlen\nBen: no' : '<as name="Ava">Ok, ich schaue nach.'));
  h.say('Schau mal nach den Zahlen.', h.group.id);
  await settled();
  h.talker.ended(h.group.id, CALL);
  await settled();
  assert.match(h.fake.inputs.at(-1)!, /One line per agent/);
  assert.equal(h.fake.closed, 1, 'the call\'s conversation is let go');
  const wakes = h.wakeRows().filter((row) => row.note?.startsWith(CALL_WAKE.slice(0, -1)));
  assert.deepEqual(wakes.map((row) => row.agent_id), ['ag_ava'], 'only the agent the voice named');
  const notes = (agentId: string) => h.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', ['repair_notes', `${agentId}:main`])?.value ?? '';
  for (const agentId of ['ag_ava', 'ag_ben']) {
    assert.match(notes(agentId), /The call in this chat has ended/, `${agentId} finds the call's lines`);
    assert.match(notes(agentId), /Wie weit bist du\?/);
  }
});

test('a call that ends while the voice still writes: what was already said stands as the agent\'s line', async () => {
  const h = setup((input) => (input.startsWith('The call has ended') ? 'Ava: no' : { stream: 'Ja, die Zahlen sind da. Ich lese noch', then: 'hang' }));
  h.say('Sind die Zahlen da?');
  await settled();
  assert.equal(h.rows()[0].state, 'streaming');
  h.talker.ended(h.solo.id, CALL);
  await settled();
  const [said] = h.rows();
  assert.equal(said.state, 'final', 'the row does not stay open');
  assert.equal(said.body, 'Ja, die Zahlen sind da.', 'the finished sentence it really said');
  assert.equal(h.wakes.list('ag_ava').length, 0, "the line is not delivered a second time: the end's hand-over carries it, and the voice named nobody");
});

test("my own work during the call: a quiet line to the call's chat and a run that ended are the voice's next inputs, and it may say them", async () => {
  const h = setup((input) => (input.includes('wrote this quietly') ? 'Die Zahlen sind da: drei Komma zwei.'
    : input.includes('Hallo?') ? '' : input.includes('Umsatz') ? { stream: 'Ich schaue', then: 'hang' } : 'Ich schaue nach.'));
  h.say('Wie sind die Zahlen?');
  await settled();
  h.chats.postAgentMessage(h.solo.id, 'ag_ava', 'run_main', { body: 'Oktober: 3,2 Mio.', silent: true });
  await settled();
  assert.match(h.fake.inputs[1], /^My own work \(Ava\) wrote this quietly into this chat[\s\S]*Oktober: 3,2 Mio\./, 'the quiet line is the next input');
  assert.equal(h.rows().at(-1)!.body, 'Die Zahlen sind da: drei Komma zwei.', 'and it said it in its own words');

  // While the voice writes, what my work tells it waits and comes with the next input – nothing is lost.
  h.say('Und der Umsatz?');
  await settled();
  const run = { id: 'run_main', agentId: 'ag_ava', endedAt: 5, status: 'done', summary: 'Bericht verschickt.' };
  h.bus.emit('run.upserted', run as never);
  h.bus.emit('run.upserted', run as never); // a run is announced again as it settles
  await settled();
  assert.equal(h.fake.inputs.length, 3, 'nothing asked while it writes');
  h.say('Hallo?');
  await settled();
  const last = h.fake.inputs.at(-1)!;
  assert.match(last, /just finished a step: Bericht verschickt\./);
  assert.match(last, /Gerd said: "Und der Umsatz\?" "Hallo\?"/);
  assert.equal(h.fake.inputs.filter((input) => input.includes('just finished a step')).length, 1, 'one input per run');
  assert.equal(h.rows().length, 2, 'nothing to say to it: silence');
  assert.equal(h.wakes.list('ag_ava').length, 0);
});

test('who it serves, and what the hand-over and the end verdict read as', async () => {
  const h = setup(() => ({ stream: '', then: 'hang' }));
  assert.equal(h.talker.serves(h.solo.id), true);
  assert.equal(h.talker.serves(h.direct.id), true, 'a default 1:1 with more agents: as the agent of its pair');
  assert.equal(h.talker.serves(h.group.id, CALL), true, 'a group with several agents: its lead speaks for the team');
  assert.equal(h.talker.serves(h.chats.create({ agentIds: [], createdBy: HUMAN_ID }).id), false, 'no agent to speak as');
  const off = setup(() => 'Ok.', { talker: false });
  assert.equal(off.talker.serves(off.solo.id), false, 'voice.talker false');
  h.say('Bist du da?');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  h.talker.stop();
  assert.equal(h.talker.serves(h.solo.id), false);
  assert.equal(h.wakes.list('ag_ava').length, 1, 'the open line goes to the agent');
  assert.equal(h.fake.closed, 1);

  const line = { body: 'Stopp', conversationId: h.solo.id } as Message;
  assert.match(handOver('next', h.solo.id, [line], 'Notiere ich.', 'Use blue.'), /passes this on for my next step/);
  assert.match(handOver('now', h.solo.id, [line], 'Mache ich.', 'Stop it.'), new RegExp(`What I post to the call's chat ${h.solo.id} while the call runs is read aloud`), 'wherever the turn runs, it knows which chat is heard');
  const agents = [{ id: 'ag_ava', name: 'Ava' }, { id: 'ag_ben', name: 'Ben' }];
  assert.deepEqual([...actsOn('- Ava: yes – die Zahlen\nBen: nein', agents)!], [['ag_ava', 'die Zahlen']], 'with what it acts on');
  assert.equal(actsOn('Zoe: yes', agents), undefined, 'a name that is in no chat names nobody: the verdict cannot be read');
  assert.deepEqual([...actsOn('**Ava**: yes – die Zahlen\n**Ben**: no', agents)!.keys()], ['ag_ava'], 'a bold name');
  assert.deepEqual([...actsOn('Ava (Assistant): yes – x\nBen (Lead): no', agents)!.keys()], ['ag_ava'], 'a role in brackets, as the team text names agents');
  assert.deepEqual([...actsOn('Ava – yes: x\n_Ben_ - nein', agents)!.keys()], ['ag_ava'], 'a dash instead of the colon');
  assert.deepEqual([...actsOn('Ava: no\nBen: no', agents)!.keys()], [], 'read: nobody acts');
});

// ------------------------------------------------------------------ fixes after the second review (r2-2, r2-1, r2-4)

test('a team answer that passes something on without speaking: nobody speaks, and the hand-over still goes on (r2-2 finding 4)', async () => {
  const h = setup(() => '<main now>Check the October invoice.</main>');
  h.say('Kann einer die Oktober-Rechnung prüfen?', h.group.id);
  await settled();
  assert.equal(h.rows(h.group.id).length, 0, 'without the tag nobody speaks');
  assert.equal(h.steers.length, 1, 'the hand-over went on');
  assert.equal(h.steers[0].agentId, 'ag_ben', 'to the agent the voice speaks for');
  assert.match(h.steers[0].text, /My voice said nothing to them\./);
  assert.match(h.steers[0].text, /What my voice passes on: "Check the October invoice\."/);
});

test('a hand-over tag that is not closed, or closed with other words, is never spoken and goes on (r2-2 finding 3)', async () => {
  for (const answer of ['Ich schau nach. <main now>Find the October numbers', 'Ich schau nach. <main now>Find the October numbers</main now>', 'Ich schau nach. <main_now>Find the October numbers</main_now>']) {
    const h = setup(() => answer);
    h.steerable.value = true;
    h.say('Wie sind die Zahlen?');
    await settled();
    assert.equal(h.rows()[0].body, 'Ich schau nach.', answer);
    assert.match(h.steers[0]?.text ?? '', /What my voice passes on: "Find the October numbers"/, answer);
  }
});

test('the end verdict cannot be read: only the agents who took part in the call are woken, the others find the block (r2-2 finding 5)', async () => {
  for (const verdict of ['Alles erledigt, danke.', new Error('no lane')]) {
    const h = setup((input) => (input.startsWith('The call has ended') ? verdict : '<as name="Ben">Mache ich.'));
    h.say('Ben, schick mir den Bericht.', h.group.id);
    await settled();
    h.talker.ended(h.group.id, CALL);
    await settled();
    const wakes = h.wakeRows().filter((row) => row.note === CALL_WAKE);
    assert.deepEqual(wakes.map((row) => row.agent_id), ['ag_ben'], `${String(verdict)}: Ben spoke in the call, Ava only listened`);
    const notes = h.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', ['repair_notes', 'ag_ava:main'])?.value ?? '';
    assert.match(notes, /The call in this chat has ended/, 'the listener finds the block at its next turn');
  }
});

test('what my work said aloud in the call reaches the voice with its next input, and that run gives no run note (r2-2 finding 6)', async () => {
  const h = setup(() => 'Ok.');
  h.say('Wie sind die Zahlen?');
  await settled();
  h.chats.postAgentMessage(h.solo.id, 'ag_ava', 'run_main', { body: 'Oktober: 3,2 Mio. Umsatz.' });
  await settled();
  assert.equal(h.fake.inputs.length, 1, 'a line read aloud starts no answer by itself');
  h.bus.emit('run.upserted', { id: 'run_main', agentId: 'ag_ava', endedAt: 5, status: 'done', summary: 'Zahlen gesagt.' } as never);
  await settled();
  assert.equal(h.fake.inputs.length, 1, 'the run whose answer was read aloud gives no run note');
  h.say('Und jetzt?');
  await settled();
  assert.match(h.fake.inputs[1], /My own work \(Ava\) said this aloud in the call, so the person has heard it: "Oktober: 3,2 Mio\. Umsatz\."[\s\S]*Gerd said: "Und jetzt\?"/);
  h.say('Noch was?');
  await settled();
  assert.equal(h.fake.inputs[2].includes('said this aloud'), false, 'told once');
});

test('a call turn\'s spoken answer (it carries the call in its meta) is what my work said aloud: no run note, so the voice does not say it again (real run 18.11.)', async () => {
  const h = setup(() => 'Ok.');
  h.say('Was schrieb Weber?');
  await settled();
  h.chats.postAgentMessage(h.solo.id, 'ag_ava', 'run_call', { body: 'Weber schrieb am 14.11.: Lagerhalle 3 statt Zentrale.', meta: { call: { id: CALL, participant: 'agent:ag_ava', name: 'Ava' } } });
  await settled();
  h.bus.emit('run.upserted', { id: 'run_call', agentId: 'ag_ava', endedAt: 5, status: 'done', summary: 'Weber schrieb am 14.11.: Lagerhalle 3 statt Zentrale.' } as never);
  await settled();
  assert.equal(h.fake.inputs.length, 1, 'the run whose answer the call heard gives the voice nothing to say');
  h.say('Danke.');
  await settled();
  assert.match(h.fake.inputs[1], /said this aloud in the call, so the person has heard it: "Weber schrieb am 14\.11\.: Lagerhalle 3 statt Zentrale\."/);
});

test('a run of mine that ended without words gives the voice nothing to say (real run 18.11.: it repeated an earlier answer)', async () => {
  const h = setup(() => 'Ok.');
  h.say('Wie sind die Zahlen?');
  await settled();
  h.bus.emit('run.upserted', { id: 'run_quiet', agentId: 'ag_ava', endedAt: 5, status: 'done', summary: '' } as never);
  await settled();
  assert.equal(h.fake.inputs.length, 1, 'no input for a run without words');
  h.bus.emit('run.upserted', { id: 'run_said', agentId: 'ag_ava', endedAt: 6, status: 'done', summary: 'Die Datei liegt im Ausgang.' } as never);
  await settled();
  assert.equal(h.fake.inputs.length, 2, 'a run with words is told');
  assert.match(h.fake.inputs[1], /just finished a step: Die Datei liegt im Ausgang\./);
});

test('a paused agent\'s voice knows the work is paused (r2-2 finding 7); a team text names the agent that rang (r2-1 finding 9)', async () => {
  const h = setup(() => 'Ok.');
  h.org.add(agent('ag_cleo', 'Cleo', { status: 'paused' }));
  const paused = h.chats.create({ agentIds: ['ag_cleo'], createdBy: HUMAN_ID });
  h.say('Bist du da?', paused.id);
  await settled();
  assert.match(h.fake.opens[0].system, /My work is paused right now; nothing I pass on runs until Gerd resumes me\./);

  const team = setup(() => '<as name="Ben">Ja.');
  team.org.add(agent('ag_ava', 'Ava', { role: 'Assistant', status: 'paused' }));
  team.record.ring = { by: 'ag_ava', why: 'Logo decision', until: 10 };
  team.say('Worum geht es?', team.group.id);
  await settled();
  assert.match(team.fake.opens[0].system, /Ava called about "Logo decision"/, 'the ringer, not the speaker (Ben speaks: Ava is paused)');
});

test('the start of the call opens its voice\'s session; a call that left this PC another way only closes it (r2-2 finding 9)', async () => {
  const h = setup(() => 'Ok.');
  h.talker.started(h.solo.id, CALL);
  assert.equal(h.fake.opens.length, 1, 'opened at the start, before any line');
  assert.equal(h.fake.started, 1);
  h.say('Hallo?');
  await settled();
  assert.equal(h.fake.opens.length, 1, 'the first line runs on it');
  h.talker.ended(h.solo.id, CALL, false);
  await settled();
  assert.equal(h.fake.closed, 1);
  assert.equal(h.fake.inputs.some((input) => input.startsWith('The call has ended')), false, 'no verdict, no hand-over from this PC');
});

test('the work line: who works and on which PC, from the chats\' live bars', async () => {
  const h = setup(() => 'Ok.');
  const device = (id: string, name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ id, name, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra });
  new DevicesRepo(h.db).upsert(device('dev_book', 'laptop', { self: true }));
  new DevicesRepo(h.db).upsert(device('dev_server', 'office-pc'));
  h.org.add(agent('ag_ava', 'Ava', { role: 'Assistant', deviceId: 'dev_server' })); // at home on the other PC
  h.bus.emit('agent.activity', { active: [
    { agentId: 'ag_ava', runId: 'run_far', conversationId: h.solo.id, note: 'reading files', startedAt: 1 },
    { agentId: 'ag_ben', runId: 'run_ben', conversationId: h.group.id, note: 'searching', startedAt: 2 },
  ] });
  const work = (chat: string) => workLine(h.services as RuntimeServices, 'ag_ava', chat);
  assert.equal(work(h.solo.id), 'My work right now: busy in this chat (reading files) on office-pc.');
  assert.equal(work(h.group.id), 'My work right now: busy in another chat (reading files) on office-pc. At work in this chat: Ben in this chat (searching) on laptop.');
  h.bus.emit('agent.activity', { active: [] });
  // Nothing streams: at home on another PC, a run there without a chat does not show here; at home here, nothing runs.
  h.org.add(agent('ag_jonas', 'Jonas', { deviceId: 'dev_server' }));
  h.org.add(agent('ag_dan', 'Dan'));
  const idle = (agentId: string) => workLine(h.services as RuntimeServices, agentId, h.solo.id);
  assert.equal(idle('ag_jonas'), 'My work right now: no work of mine streams in a chat; my turns run on office-pc, and a run there without a chat does not show here.');
  assert.equal(idle('ag_dan'), 'My work right now: nothing is running.');
});

test('messages.send: a plain live line goes to the voice, stored quiet as a line of the device\'s call; a marked or dictated line goes the normal way', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_ben', 'Ben'));
  const services = f.services as RuntimeServices;
  Object.assign(services, { secrets: { redact: (text: string) => text } });
  createCalls(services, { voice: fakeVoice(() => 'Bin da.').opener });
  t.after(() => stopCalls(services));
  const owner = new TestClient(f.server, OWNER);
  const solo = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const live = { source: 'endpoint', live: true };
  const line = await owner.call<Message>('messages.send', { conversationId: solo.id, body: 'Hallo', speech: live });
  assert.equal(line.silent, true);
  assert.equal(line.meta.call?.participant, 'device:pc');
  assert.equal(line.meta.speech?.live, true);
  assert.equal(line.meta.speech?.call, undefined, 'the call is meta.call, not speech');
  const call = f.chats.messages(solo.id, { limit: 10 }).map((m) => callRecord(m)).find(Boolean);
  assert.equal(line.meta.call?.id, call?.id, 'a live line without a named call opens the device\'s call');
  await settled();
  assert.equal(f.wakeRows().length, 0);
  assert.ok(f.chats.messages(solo.id, { limit: 10 }).some((message) => message.body === 'Bin da.' && message.authorId === 'ag_ava' && !message.silent));

  const dictated = await owner.call<Message>('messages.send', { conversationId: solo.id, body: 'Diktiert', speech: { source: 'endpoint' } });
  assert.equal(dictated.silent, false);
  assert.equal(f.wakeRows().length, 1, 'a dictated line wakes as before');

  const group = f.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: 'human', lead: 'ag_ben' });
  assert.equal((await owner.call<Message>('messages.send', { conversationId: group.id, body: 'Alle', speech: live })).silent, true, 'a group: its lead speaks for the team');
  const direct = f.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: 'human', settings: { direct: true, directPair: ['ag_ben', 'human'] } });
  assert.equal((await owner.call<Message>('messages.send', { conversationId: direct.id, body: 'Hallo Ben', speech: live })).silent, true, 'a default 1:1 with more agents: its pair\'s voice answers');
  const marked = await owner.call<Message>('messages.send', { conversationId: solo.id, body: 'Wichtig', speech: { ...live, call: call?.id }, priority: 'important' });
  assert.equal(marked.silent, false);
  assert.equal(marked.meta.call?.id, call?.id, 'the call it names');
});

// ------------------------------------------------------------------ FIXES-3b F2: the end of a call wakes with its reason, and quietly

test('the end verdict names what an agent acts on: its wake carries that, flat and cut, as a first-person fact (FIXES-3b F2.1)', async () => {
  const what = 'sie wartet auf \t  die Oktober-Zahlen bis Freitag';
  const h = setup((input) => (input.startsWith('The call has ended') ? `Ava: yes – ${what}${' und mehr'.repeat(80)}\nBen: no` : '<as name="Ava">Ok, ich schaue nach.'));
  h.say('Schau mal nach den Zahlen.', h.group.id);
  await settled();
  h.talker.ended(h.group.id, CALL);
  await settled();
  const wakes = h.wakeRows().filter((row) => row.note?.startsWith(CALL_WAKE.slice(0, -1)));
  assert.deepEqual(wakes.map((row) => row.agent_id), ['ag_ava'], 'only the agent the voice named');
  assert.match(wakes[0].note!, /^The call in this chat has ended, and it holds something I act on: sie wartet auf die Oktober-Zahlen bis Freitag und mehr/, 'the wake starts from its reason');
  assert.ok(wakes[0].note!.length <= CALL_WAKE.length + 320, 'cut');
  assert.equal(/\s{2}|\t/.test(wakes[0].note!), false, 'flat');
});

test('a verdict in the form of silence names nobody to act: nobody is woken, every agent keeps the call\'s block (FIXES-3b F2.2, review R9)', async () => {
  const h = setup((input) => (input.startsWith('The call has ended') ? '<silent/>' : '<as name="Ben">Mache ich.'));
  h.say('Ben, wie spät ist es?', h.group.id);
  await settled();
  h.talker.ended(h.group.id, CALL);
  await settled();
  assert.deepEqual(h.wakeRows().filter((row) => row.reason === 'message').map((row) => row.agent_id), [], 'silence wakes nobody');
  for (const agentId of ['ag_ava', 'ag_ben']) {
    const notes = h.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', ['repair_notes', `${agentId}:main`])?.value ?? '';
    assert.match(notes, /The call in this chat has ended/, `${agentId} finds the call's block at its next turn`);
  }
});

test('the end verdict leaves one log line without any of the call\'s content: how many agents, how many act, read, silent (FIXES-3b F2.3)', async () => {
  const cases: Array<[string | Error, Record<string, unknown>]> = [
    ['Ava: yes – die geheimen Zahlen\nBen: no', { agents: 2, act: 1, read: true, silent: false }],
    ['<silent/>', { agents: 2, act: 0, read: false, silent: true }],
    ['Alles erledigt, danke.', { agents: 2, act: 1, read: false, silent: false }],
    [new Error('no lane'), { agents: 2, act: 1, read: false, silent: false }],
  ];
  for (const [verdict, expected] of cases) {
    const h = setup((input) => (input.startsWith('The call has ended') ? verdict : '<as name="Ben">Mache ich.'));
    const logged: Array<{ message: string; data: Record<string, unknown> }> = [];
    Object.assign(h.services, { log: { debug() {}, warn() {}, error() {}, info: (message: string, data: Record<string, unknown>) => logged.push({ message, data }) } });
    h.say('Ben, schick mir den Bericht.', h.group.id);
    await settled();
    h.talker.ended(h.group.id, CALL);
    await settled();
    const lines = logged.filter((line) => line.message === 'call end verdict');
    assert.equal(lines.length, 1, `${String(verdict)}: one line`);
    const { conversationId: _chat, callId: _call, ...counts } = lines[0].data;
    assert.deepEqual(counts, expected, String(verdict));
    assert.equal(JSON.stringify(lines[0].data).includes('Zahlen') || JSON.stringify(lines[0].data).includes('Bericht'), false, 'nothing of the call');
  }
});

test('what passes on from a call is work, not news: the voice text says it, and the end ask counts as "yes" only what an agent does not have yet (FIXES-3b F1, F2)', () => {
  assert.match(CALL_VOICE, /My work reads this call by itself; what I pass on is what it still has to do or find out\./);
  const ask = voiceEndAsk([{ id: 'ag_ava', name: 'Ava' }]);
  assert.match(ask, /A "yes" is something the call gave that agent to do which it does not have yet\./);
  assert.equal(/answered on the call and passed on already/.test(ask), false, 'one principle, not cases');
});
