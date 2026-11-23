// The end of a spoken line (src/ui/lib/turn-detect.ts): without models a voice (harmonics, above
// 0.018 RMS and the noise floor) starts a line after ~96 ms and 1.1 s of silence ends it – white noise, a click, a quiet
// voice or a flat hum never start one; with Silero the model decides speech; with Smart Turn the line ends right after
// 250 ms of silence when it is finished, else after 3 s more (speech in between asks again); a failing model is dropped
// and the fallback goes on.
// Owns: these assertions only. Never: a real model, microphone or onnxruntime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnDetector, flatness, FRAME, LEVEL_SILENCE_MS, TURN_CHECK_MS, TURN_WAIT_MS, type TurnDetectorOptions } from '../../../src/ui/lib/turn-detect.ts';

const RATE = 16_000;
const samples = (ms: number) => Math.round((ms * RATE) / 1000);
const voice = (ms: number, amp = 0.1) => Float32Array.from({ length: samples(ms) }, (_, i) => {
  let v = 0;
  for (let h = 1; h <= 12; h++) v += Math.sin((2 * Math.PI * 150 * h * i) / RATE) / h;
  return amp * v;
});
let seed = 7;
const noise = (ms: number, amp: number) => Float32Array.from({ length: samples(ms) }, () => { seed = (seed * 1103515245 + 12345) % 2147483648; return amp * 3.4 * (seed / 2147483648 - 0.5); });
const silence = (ms: number) => new Float32Array(samples(ms));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Feeds the parts in 32 ms blocks (awaiting model answers between blocks); edges with their time in ms. */
async function run(options: TurnDetectorOptions, ...parts: Float32Array[]) {
  const detector = createTurnDetector(options);
  const audio = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { audio.set(part, at); at += part.length; }
  const edges: string[] = [];
  for (let i = 0; i < audio.length; i += FRAME) {
    const edge = detector.feed(audio.subarray(i, i + FRAME));
    if (edge) edges.push(`${edge}@${Math.round(((i + FRAME) * 1000) / RATE)}`);
    if (options.models) { await tick(); await tick(); }
  }
  return { edges, detector };
}
const timeOf = (edges: string[], kind: string) => Number(edges.find((edge) => edge.startsWith(kind))?.split('@')[1]);

test('flatness: a voice has harmonics, noise is flat, nothing in the band is flattest', () => {
  assert.ok(flatness(voice(32).subarray(0, FRAME)) < 0.2);
  assert.ok(flatness(noise(32, 0.1).subarray(0, FRAME)) > 0.45);
  assert.ok(flatness(new Float32Array(FRAME).fill(0.3)) > 0.9, 'a constant level is no voice');
});

test('fallback: a voice starts a line at once, 1.1 s of silence ends it; noise, a click or a quiet voice start nothing', async () => {
  const { edges } = await run({}, silence(300), voice(1000), silence(1000), voice(500), silence(1300));
  assert.deepEqual(edges.map((edge) => edge.split('@')[0]), ['start', 'end'], 'a 1 s pause keeps the line');
  assert.ok(timeOf(edges, 'start') <= 300 + 128, 'starts within ~100 ms of the voice');
  assert.ok(timeOf(edges, 'end') >= 2800 + LEVEL_SILENCE_MS, 'ends only after the silence');

  assert.deepEqual((await run({}, noise(2000, 0.2), silence(300))).edges, [], 'loud white noise (a fan, breath)');
  const click = silence(500);
  click.fill(0.9, samples(200), samples(200) + 40);
  assert.deepEqual((await run({}, click)).edges, [], 'a keystroke');
  assert.deepEqual((await run({}, voice(1000, 0.004))).edges, [], 'below the minimum level');
  const capped = (await run({ maxMs: 1000 }, voice(1800))).edges;
  assert.deepEqual(capped.map((edge) => edge.split('@')[0]), ['start', 'end', 'start'], 'the cap ends a line, the voice goes on as the next');
  assert.ok(timeOf(capped, 'end') - timeOf(capped, 'start') <= 1000 + 32);
});

test('fallback: a learned noise floor wants a voice clearly above it', async () => {
  const mixed = (ms: number, amp: number) => { const room = noise(ms, 0.03); return voice(ms, amp).map((v, i) => v + room[i]); };
  assert.deepEqual((await run({}, noise(3000, 0.03), mixed(600, 0.012))).edges, [], 'a voice drowned in the room noise');
  assert.equal((await run({}, noise(3000, 0.03), mixed(600, 0.1))).edges[0]?.split('@')[0], 'start', 'a clear voice in the same room');
});

test('VOICE fallback: a steady tonal hum (harmonic, loud) becomes the noise floor – its line ends in seconds, not at the 120 s cap; a voice above it starts the next', async () => {
  const hum = (ms: number, level: number) => {
    const tone = Float32Array.from({ length: samples(ms) }, (_, i) => { let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin((2 * Math.PI * 100 * h * i) / RATE) / h; return v; });
    const scale = level / Math.sqrt(tone.reduce((sum, v) => sum + v * v, 0) / tone.length);
    return tone.map((v) => v * scale);
  };
  const steady = await run({}, hum(12_000, 0.03));
  assert.deepEqual(steady.edges.map((edge) => edge.split('@')[0]), ['start', 'end'], 'it was speech at first, then the floor');
  assert.ok(timeOf(steady.edges, 'end') < 9_000, `ended at ${timeOf(steady.edges, 'end')} ms`);
  const room = hum(12_600, 0.03);
  const talk = voice(600, 0.3);
  room.set(room.subarray(samples(12_000)).map((v, i) => v + talk[i]), samples(12_000));
  const after = await run({}, room);
  assert.deepEqual(after.edges.map((edge) => edge.split('@')[0]), ['start', 'end', 'start'], 'a clear voice in the humming room');
  assert.ok(Number(after.edges.at(-1)?.split('@')[1]) >= 12_000, 'the voice, not the hum, starts it');
});

test('begin() opens a line without a start edge; reset() forgets it', async () => {
  const detector = createTurnDetector();
  detector.begin();
  assert.equal(detector.speaking, true);
  let end: string | null = null;
  for (let i = 0; i < 40 && !end; i++) end = detector.feed(silence(32));
  assert.equal(end, 'end');
  detector.feed(voice(200));
  assert.equal(detector.speaking, true);
  detector.reset();
  assert.equal(detector.speaking, false);
});

test('Smart Turn: finished ends the line right after the check; unfinished waits 3 s more; speech asks again', async () => {
  const asked: number[] = [];
  const finished = (p: number[]) => ({ finished: async (audio: Float32Array) => { asked.push(audio.length); return p.shift() ?? 0; } });

  const done = await run({ models: finished([0.9]) }, voice(1000), silence(1500));
  assert.deepEqual(done.edges.map((edge) => edge.split('@')[0]), ['start', 'end']);
  assert.ok(timeOf(done.edges, 'end') - 1000 <= TURN_CHECK_MS + 100, 'ends ~250 ms into the pause');
  assert.equal(asked.length, 1);
  assert.ok(asked[0] >= samples(1000) && asked[0] <= 8 * RATE, 'the line so far, at most 8 s');

  asked.length = 0;
  const open = await run({ models: finished([0.1, 0.8]) }, voice(1000), silence(2000), voice(500), silence(1000));
  assert.deepEqual(open.edges.map((edge) => edge.split('@')[0]), ['start', 'end'], 'a 2 s pause of an unfinished sentence keeps the line');
  assert.equal(asked.length, 2, 'asked again at the next pause');
  assert.ok(timeOf(open.edges, 'end') - 3500 <= TURN_CHECK_MS + 100);

  const waits = await run({ models: finished([0.1]) }, voice(1000), silence(TURN_CHECK_MS + TURN_WAIT_MS + 400));
  assert.ok(timeOf(waits.edges, 'end') >= 1000 + TURN_CHECK_MS + TURN_WAIT_MS, 'unfinished: the line ends only after the wait');
});

test('a late "finished" never ends a line it was not asked about: after reset() or when the person spoke again', async () => {
  const answers: Array<(p: number) => void> = [];
  const detector = createTurnDetector({ models: { finished: () => new Promise<number>((resolve) => answers.push(resolve)) } });
  const feed = (audio: Float32Array) => { const edges: string[] = []; for (let i = 0; i < audio.length; i += FRAME) { const edge = detector.feed(audio.subarray(i, i + FRAME)); if (edge) edges.push(edge); } return edges; };
  assert.deepEqual(feed(voice(500)), ['start']);
  feed(silence(TURN_CHECK_MS + 64));
  assert.equal(answers.length, 1, 'asked at the pause');
  detector.reset();
  answers[0](0.99);
  await tick();
  assert.deepEqual([feed(silence(64)), detector.speaking], [[], false], 'the answer about a forgotten line is dropped');

  assert.deepEqual(feed(voice(500)), ['start']);
  feed(silence(TURN_CHECK_MS + 64));
  feed(voice(200)); // the person goes on before the answer comes
  answers[1](0.99);
  await tick();
  assert.deepEqual([feed(silence(64)), detector.speaking], [[], true], 'speech after the asked pause keeps the line');
});

test('a failing model is dropped once and the fallback decides', async () => {
  const errors: unknown[] = [];
  const failing = await run({ models: { finished: async () => { throw new Error('wasm'); }, speech: async () => { throw new Error('vad'); } }, onModelError: (error) => errors.push(error) }, voice(1000), silence(1400));
  assert.deepEqual(failing.edges.map((edge) => edge.split('@')[0]), ['start', 'end']);
  assert.ok(timeOf(failing.edges, 'end') >= 1000 + LEVEL_SILENCE_MS, 'the 1.1 s silence rule');
  assert.deepEqual(errors.map((error) => (error as Error).message), ['vad', 'wasm']);
});

test('Silero decides speech when it runs: what it calls speech is a line, whatever the level', async () => {
  const quietVoice = await run({ models: { speech: async (frame) => (Math.abs(frame[100]) > 0.0005 ? 0.9 : 0.05) } }, silence(200), voice(800, 0.003), silence(1400));
  assert.deepEqual(quietVoice.edges.map((edge) => edge.split('@')[0]), ['start', 'end']);
  const notSpeech = await run({ models: { speech: async () => 0.1 } }, voice(1500));
  assert.deepEqual(notSpeech.edges, []);
});
