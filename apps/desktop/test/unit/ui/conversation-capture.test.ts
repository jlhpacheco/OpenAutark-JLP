// The voice conversation's capture and self barge-in (src/ui/chat/composer/conversation-audio.ts,
// src/ui/lib/barge-in.ts, shared/voice/conversation.ts bargeIn): the turn detector cuts a take from the 16 kHz PCM, the
// take is a WAV that starts PRE_ROLL_MS before the voice (the first word whole) and goes to the loop as one upload; a
// take is dropped when the loop starts reading; words said while the last line is heard are kept and go to the loop
// after it, in order (KI-Runde 17.11.); nothing is taken while this device reads aloud (echo guard); with echo
// cancellation on, a voice clearly above the reading's echo, held long enough, stops this device's own reading and is
// taken at once – a cough, the echo itself or a microphone without echo cancellation never does; the loop stops
// reading and listens.
// Owns: these assertions only. Never: a real microphone or speech engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../src/shared/model/chat.ts';
import { VoiceSessions } from '../../../src/shared/voice/conversation.ts';
import type { VoiceSessionView } from '../../../src/shared/voice/conversation.ts';
import { ConversationCapture, PRE_ROLL_MS } from '../../../src/ui/chat/composer/conversation-audio.ts';
import { BargeInDetector, echoCancelled } from '../../../src/ui/lib/barge-in.ts';
import { rms } from '../../../src/ui/lib/pcm.ts';
import { pcm16Samples } from '../../../src/shared/voice/wav.ts';
import type { TurnModels } from '../../../src/ui/lib/turn-detect.ts';

const BLOCK_MS = 85; // the browser capture's block (browserCapture): the detector frames it itself
const BLOCK = (BLOCK_MS * 16_000) / 1000;
const RATE = 16_000;
const harmonics = (i: number) => { let v = 0; for (let h = 1; h <= 12; h++) v += Math.sin((2 * Math.PI * 150 * h * i) / RATE) / h; return v; };
const UNIT = rms(Float32Array.from({ length: 512 }, (_, i) => harmonics(i)));
/** One 85 ms block of a voice whose RMS is `level` (0: silence); `at` keeps the waveform continuous. */
const block = (level: number, at: number) => Float32Array.from({ length: BLOCK }, (_, i) => (level / UNIT) * harmonics(at + i));

function rig(options: { aec?: boolean; bargeIn?: () => boolean; speaking?: () => boolean; turnModels?: () => Promise<TurnModels>; utterance?: (fileId: string) => Promise<void>; upload?: (index: number) => Promise<void> } = {}) {
  let now = 0;
  let sample = 0;
  let feed: ((samples: Float32Array, rate: number) => void) | undefined;
  const uploads: Array<{ blob: Blob; name: string }> = [];
  const utterances: string[] = [];
  const barged: string[] = [];
  const spoke: number[] = [];
  const stream = { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: options.aec === true }) }] } as unknown as MediaStream;
  const capture = new ConversationCapture({
    utterance: async (_id, fileId) => { utterances.push(fileId); await options.utterance?.(fileId); },
    spoke: (_id, at) => { spoke.push(at); },
    ...(options.bargeIn ? { bargeIn: (id: string) => { barged.push(id); return options.bargeIn!(); } } : {}),
  }, () => undefined, {
    openMicrophone: async (listener) => { feed = listener; return { stream, close: () => undefined }; },
    upload: async (blob, name) => { uploads.push({ blob, name }); const index = uploads.length; await options.upload?.(index); return { id: `file_${index}` }; },
    now: () => now,
    speaking: options.speaking,
    turnModels: options.turnModels,
  });
  const run = (level: number, ms: number) => { for (let t = 0; t < ms; t += BLOCK_MS) { now += BLOCK_MS; feed!(block(level, sample), RATE); sample += BLOCK; } };
  const view = (status: VoiceSessionView['status']) => capture.follow({ id: 'mic_1', conversationId: 'ch_a', status });
  return { capture, run, view, uploads, utterances, barged, spoke, now: () => now, tick: () => new Promise<void>((resolve) => setImmediate(resolve)) };
}

/** The take's samples (16 kHz floats after the 44-byte WAV header). */
const pcmOf = async (blob: Blob) => pcm16Samples(new Uint8Array(await blob.arrayBuffer()).subarray(44));

test('a take starts with the pre-roll before the voice, ends after the silence and goes to the loop as a WAV; a take the loop moved past is dropped', async () => {
  const r = rig();
  await r.capture.open();
  r.view('listening');
  r.run(0, 600);
  r.run(0.1, 800);
  r.view('speaking'); // the loop reads a reply: the take is dropped
  r.run(0.1, 100);
  r.view('listening');
  r.run(0, 1400);
  await r.tick();
  assert.equal(r.uploads.length, 0, 'nothing of the dropped take');
  r.view('listening');
  r.run(0, 600);
  r.run(0.1, 800);
  r.run(0, 1400); // the end edge: the utterance goes to the loop
  await r.tick();
  assert.deepEqual([r.uploads.map((upload) => upload.name), r.utterances], [['Utterance.wav'], ['file_1']]);
  const pcm = await pcmOf(r.uploads[0].blob);
  const firstVoice = pcm.findIndex((v) => Math.abs(v) > 0.01);
  assert.ok(firstVoice >= ((PRE_ROLL_MS - 100) * RATE) / 1000, `the take begins before the voice (${firstVoice} samples of quiet)`);
  assert.ok(pcm.length / RATE >= 0.8 + 1.1, 'the whole voice and the silence that ended it');
  r.capture.close();
});

test('the capture takes nothing while this device reads aloud (echo guard)', async () => {
  let speaking = true;
  const r = rig({ speaking: () => speaking });
  await r.capture.open();
  r.view('listening');
  r.run(0.5, 600);
  r.run(0, 1400);
  await r.tick();
  assert.equal(r.uploads.length, 0, 'silence while another line is read');
  speaking = false;
  r.run(0.5, 300);
  r.run(0, 1400);
  await r.tick();
  assert.equal(r.uploads.length, 1, 'the person is heard again');
  r.capture.close();
});

test('self barge-in: only with echo cancellation, only above the echo, only when held', async () => {
  const r = rig({ aec: true, bargeIn: () => true });
  await r.capture.open();
  r.view('speaking');
  r.run(0.05, 700); // the reading's echo (warm-up and after)
  r.run(0.3, 170); // a cough
  r.run(0.05, 300);
  assert.deepEqual(r.barged, [], 'no barge-in from the echo or a cough');
  r.run(0.4, 450);
  assert.deepEqual(r.barged, ['mic_1'], 'a held voice clearly above the echo');
  r.view('listening'); // the loop stopped reading
  r.run(0.4, 200);
  r.run(0, 1400);
  await r.tick();
  assert.deepEqual(r.utterances, ['file_1'], 'the words said over the reading go out, taken at once');

  const plain = rig({ aec: false, bargeIn: () => true });
  await plain.capture.open();
  plain.view('speaking');
  plain.run(0.05, 700);
  plain.run(0.5, 900);
  plain.run(0, 1400);
  await plain.tick();
  assert.deepEqual([plain.barged, plain.uploads.length], [[], 0], 'without echo cancellation the echo guard stays');

  const refused = rig({ aec: true, bargeIn: () => false });
  await refused.capture.open();
  refused.view('speaking');
  refused.run(0.05, 700);
  refused.run(0.5, 900);
  refused.run(0, 1400);
  await refused.tick();
  assert.equal(refused.barged.length > 0 && refused.uploads.length === 0, true, 'nothing of the loop was read: no take');
});

test('the barge-in detector learns the echo and wants a held voice above it', () => {
  const detector = new BargeInDetector({ ratio: 3, minLevel: 0.06, holdMs: 350, warmMs: 600 });
  let now = 0;
  const feed = (level: number, ms: number) => { let fired = false; for (let t = 0; t < ms; t += 85) { now += 85; fired = detector.feed(level, now) || fired; } return fired; };
  assert.equal(feed(0.1, 600), false, 'warm-up only learns');
  assert.equal(feed(0.25, 170), false, 'below three times the echo');
  assert.equal(feed(0.1, 85), false);
  assert.equal(feed(0.5, 255), false, 'not held long enough');
  assert.equal(feed(0.1, 85), false, 'a quiet block starts it over');
  assert.equal(feed(0.5, 500), true);
  detector.stop();
  assert.equal(feed(0.5, 300), false, 'a new reading warms up again');
  assert.equal(echoCancelled(undefined), false);
  assert.equal(echoCancelled({ getAudioTracks: () => { throw new Error('gone'); } } as unknown as MediaStream), false);
});

test('the loop stops its own reading on a barge-in and listens', async () => {
  const views: Array<VoiceSessionView | null> = [];
  let silenced = 0;
  const spoken: string[] = [];
  let onMessage: ((message: Message) => void) | undefined;
  let ids = 0;
  const sessions = new VoiceSessions({
    rpc: {
      call: (async (method: string) => (method === 'chats.get' ? { id: 'ch_a', title: 'Plan' } : method === 'voice.transcribe' ? { text: 'Tell me the plan' } : method === 'messages.send' ? { id: 'm1', seq: 1 } : { ok: true })) as never,
      on: ((event: string, listener: (message: Message) => void) => { if (event === 'message.created') onMessage = listener; return () => undefined; }) as never,
      subscribe: async () => () => undefined,
    },
    publish: (view) => { views.push(view); },
    speak: (_id, text) => { spoken.push(text); },
    silence: () => { silenced += 1; },
    newId: () => `id_${++ids}`,
    after: () => () => undefined,
  });
  const view = await sessions.start('ch_a');
  assert.equal(sessions.bargeIn(view.id), false, 'nothing is read yet');
  await sessions.utterance(view.id, 'file_1');
  onMessage!({ id: 'r1', conversationId: 'ch_a', seq: 2, authorId: 'ag_ava', authorKind: 'agent', kind: 'text', body: 'Here is the long plan.', state: 'final', silent: false, meta: {} } as unknown as Message);
  assert.equal(sessions.view()?.status, 'speaking');
  assert.equal(sessions.bargeIn('other'), false, 'another microphone');
  assert.equal(sessions.bargeIn(view.id), true);
  assert.deepEqual([silenced, sessions.view()?.status], [1, 'listening']);
  assert.deepEqual(spoken, ['Here is the long plan.']);
});

test('B-082: the turn models load with the conversation and decide from the next line on (Smart Turn ends it after 250 ms); failing to load keeps the level detector', async () => {
  let asked = 0;
  let heard = 0;
  const models: TurnModels = {
    speech: async (frame) => { heard += 1; return rms(frame) > 0.01 ? 0.9 : 0.05; },
    finished: async () => { asked += 1; return 0.9; },
  };
  const r = rig({ turnModels: async () => models });
  await r.capture.open();
  r.view('listening');
  const step = async (level: number, ms: number) => { for (let t = 0; t < ms; t += BLOCK_MS) { r.run(level, BLOCK_MS); await r.tick(); } };
  await step(0, 300);
  await step(0.1, 800);
  await step(0, 500); // the level detector would need 1.1 s of silence
  await r.tick();
  assert.ok(heard > 0, 'Silero hears the frames');
  assert.equal(asked, 1, 'Smart Turn asked once at the pause');
  assert.equal(r.uploads.length, 1);

  const warned: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    const failing = rig({ turnModels: async () => { throw new Error('wasm refused'); } });
    await failing.capture.open();
    failing.view('listening');
    failing.run(0, 300);
    failing.run(0.1, 800);
    failing.run(0, 1400);
    await failing.tick();
    assert.equal(failing.uploads.length, 1, 'the level detector cut the line');
    assert.equal(warned.length, 1, 'one log line');
  } finally { console.warn = warn; }
});

test('words said while the last line is heard are kept: taken while the loop transcribes, uploaded at once, handed over after the line before, in order', async () => {
  let release = () => {};
  const firstHeard = new Promise<void>((resolve) => { release = resolve; });
  let slowFirst = () => {};
  const firstUpload = new Promise<void>((resolve) => { slowFirst = resolve; });
  const r = rig({ utterance: (fileId) => (fileId === 'file_1' ? firstHeard : Promise.resolve()), upload: (index) => (index === 1 ? firstUpload : Promise.resolve()) });
  await r.capture.open();
  r.view('listening');
  r.run(0, 600);
  r.run(0.1, 800);
  r.run(0, 1400); // the first line ends: its upload starts
  const firstEnd = r.now();
  r.view('transcribing'); // the loop hears it
  r.run(0.1, 800);
  r.run(0, 1400); // said meanwhile: kept, its upload starts at once
  await r.tick();
  assert.equal(r.uploads.length, 2, 'both uploads run');
  assert.deepEqual(r.utterances, [], 'the second waits for the first, whose upload is slower');
  slowFirst();
  await r.tick();
  assert.deepEqual(r.utterances, ['file_1']);
  release();
  await r.tick();
  assert.deepEqual(r.utterances, ['file_1', 'file_2'], 'the next line, in the order said');
  assert.equal(r.spoke.length, 2, 'the end of each take’s speech goes to the sink');
  assert.ok(r.spoke[0] <= firstEnd && r.spoke[1] > firstEnd, 'at the take’s end');
  r.capture.close();
});
