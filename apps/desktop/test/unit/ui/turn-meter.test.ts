// One log line per call turn (src/ui/chat/call/turn-meter.ts, calls.turn in src/runtime/rpc/handlers/calls.ts): the page
// measures a call turn from the end of speech – heard (and by which way), the answer's first row (and who answered),
// the answer handed to the reading voice – and sends it once, numbers and labels only; words said before the line
// went out belong to the same turn; a turn outside a call sends nothing; the runtime writes one log line.
// Owns: these assertions only. Never: a microphone, a model or a real call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { TurnMeter, type TurnNote } from '../../../src/ui/chat/call/turn-meter.ts';
import { MemoryLogger } from '../fakes.ts';
import { register as calls } from '../../../src/runtime/rpc/handlers/calls.ts';
import { OWNER, TestClient, rpcFixture, s1Table } from '../rpc/s1-helpers.ts';

function rig() {
  let now = 1_000;
  const notes: TurnNote[] = [];
  const meter = new TurnMeter(() => now, (note) => notes.push(note));
  const row = (seq: number, extra: Partial<Message> & { meta?: Message['meta'] } = {}) => ({ id: `m${seq}`, conversationId: 'ch_a', seq, authorKind: 'agent', authorId: 'ag_ava', kind: 'text', state: 'streaming', body: '', silent: false, meta: {}, ...extra }) as Message;
  return { meter, notes, row, at: (ms: number) => { now = ms; } };
}

const live = { conversationId: 'ch_a', body: 'Hallo', speech: { live: true } };

test('one call turn: heard, first word, handed to the voice – ms after the end of speech, who heard and who answered, once', () => {
  const r = rig();
  r.meter.spoke(1_000);
  r.at(1_900); r.meter.answered('voice.transcribe', { fileId: 'f' }, { text: 'Hallo', by: 'plan' });
  r.at(1_950); r.meter.answered('messages.send', live, { seq: 10, meta: { call: { id: 'call_1' } } });
  r.meter.seen(r.row(9)); // before the line: not its answer
  r.at(4_200); r.meter.seen(r.row(11, { meta: { model: 'gpt-6-luna', call: { id: 'call_1', participant: 'agent:ag_ava', name: 'Ava', voice: 'talker' } } }));
  r.at(4_300); r.meter.seen(r.row(12)); // a later row: the first one counts
  r.at(4_650); r.meter.spoken();
  r.meter.spoken();
  assert.deepEqual(r.notes, [{ callId: 'call_1', heardMs: 900, answerMs: 3_200, speakMs: 3_650, heardBy: 'plan', answeredBy: 'talker', model: 'gpt-6-luna' }]);
});

test('words held while the line was heard belong to its turn; the program\'s line counts as the answer; a line outside a call sends nothing', () => {
  const r = rig();
  r.meter.spoke(1_000);
  r.meter.spoke(1_500); // said while the first was heard
  r.at(2_000); r.meter.answered('voice.transcribe', {}, { text: 'a', by: 'local' });
  r.meter.answered('messages.send', live, { seq: 5, meta: { call: { id: 'call_2' } } });
  r.at(2_500); r.meter.seen(r.row(6, { authorKind: 'system', authorId: 'system', state: 'final', meta: { call: { id: 'call_2', participant: 'system', name: 'Autark' } } }));
  r.at(2_600); r.meter.spoken();
  assert.deepEqual(r.notes.map((note) => [note.heardMs, note.answeredBy, note.speakMs]), [[1_000, 'program', 1_600]]);

  const plain = rig();
  plain.meter.spoke(1_000);
  plain.meter.answered('voice.transcribe', {}, { text: 'a', by: 'plan' });
  plain.meter.answered('messages.send', live, { seq: 5, meta: {} }); // no call
  plain.meter.seen(plain.row(6));
  plain.meter.spoken();
  assert.deepEqual(plain.notes, []);
});

test('calls.turn writes one log line of numbers and labels', async (t) => {
  const table = s1Table();
  calls(table);
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  const log = new MemoryLogger();
  Object.assign(f.services as RuntimeServices, { log });
  const owner = new TestClient(f.server, OWNER);
  const note: TurnNote = { callId: 'call_1', heardMs: 900, answerMs: 3_200, speakMs: 3_650, heardBy: 'plan', answeredBy: 'talker', model: 'gpt-6-luna' };
  assert.deepEqual(await owner.call('calls.turn', note), { ok: true });
  const lines = log.entries.filter((entry) => entry.message === 'call turn');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].data, { ...note, device: 'pc' });
  await assert.rejects(owner.call('calls.turn', { ...note, heardMs: -1 }));
});
