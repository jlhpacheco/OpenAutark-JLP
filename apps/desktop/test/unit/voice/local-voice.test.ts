// B-047 D14 the PC's local voice in a page's speech output (src/ui/chat/composer/device-speech.ts):
// sentences split for voice.speak (short pieces joined, long ones cut at a space), the next sentence asked
// while the current one plays, the line ends once after its last sentence, a failed call or playback hands
// the rest of the line to speechSynthesis, a cut line asks and plays nothing more, and without a local
// voice everything stays with speechSynthesis (regression: German answers were read by robotic Windows
// voices even with a neural voice on the PC). VOICE 19.11.2026: a sentence later than LATE_MS after it is due hands the
// rest of the line to the device's voice at once (the call never stalls on a slow link), a refused call rests the PC's
// voice for REST_MS, and only a system voice picked by name keeps the device's voice (no local voice chosen is no opt-out).
// Owns: these assertions only. Never: real audio or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSpeech, LATE_MS, localVoiceEngine, MAX_SENTENCE, sentences, systemVoicePicked, type LocalVoiceDeps, type SpeechEngine } from '../../../src/ui/chat/composer/device-speech.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { active?: boolean; failAt?: number; playFails?: boolean } = {}) {
  const asked: string[] = [];
  const playing: Array<{ ended: () => void; stopped: boolean }> = [];
  const fallback: string[] = [];
  let fallbackEnd: (() => void) | undefined;
  let fallbackStops = 0;
  const synthesis: SpeechEngine = { play: (text, _reading, ended) => { fallback.push(text); fallbackEnd = ended; }, stop: () => { fallbackStops++; } };
  const deps: LocalVoiceDeps = {
    active: () => options.active ?? true,
    speak: async ({ text }) => {
      asked.push(text);
      if (options.failAt !== undefined && asked.length - 1 === options.failAt) throw new Error('busy');
      return { audio: Buffer.from([0, 0, 255, 127]).toString('base64'), sampleRate: 44_100, durationMs: 1 };
    },
    play: async (_samples, _rate, ended) => {
      if (options.playFails) throw new Error('audio output is not allowed yet');
      const entry = { ended, stopped: false };
      playing.push(entry);
      return () => { entry.stopped = true; };
    },
  };
  const engine = localVoiceEngine(deps, synthesis);
  return { engine, asked, playing, fallback, fallbackEnd: () => fallbackEnd?.(), fallbackStops: () => fallbackStops };
}

test('sentences: split after . ! ? and line breaks, short pieces join, long ones are cut at a space', () => {
  assert.deepEqual(sentences('Hallo Gerd, wie geht es dir heute? Mir geht es gut. Ja.\nDas Meeting ist um 14 Uhr.'),
    ['Hallo Gerd, wie geht es dir heute?', 'Mir geht es gut. Ja. Das Meeting ist um 14 Uhr.']);
  assert.deepEqual(sentences('Ok.'), ['Ok.']);
  const long = sentences(`${'wort '.repeat(150)}ende.`);
  assert.ok(long.length >= 2 && long.every((piece) => piece.length <= MAX_SENTENCE && !piece.startsWith(' ')));
});

test('sentence by sentence: the next one is asked while one plays; the line ends once after the last', async () => {
  const h = harness();
  let ended = 0;
  h.engine.play('Das ist der erste Satz für den Test. Das ist der zweite Satz für den Test. Das ist der dritte Satz für den Test.', { language: 'de-DE' }, () => { ended++; });
  await tick(); await tick();
  assert.equal(h.playing.length, 1);
  assert.deepEqual(h.asked, ['Das ist der erste Satz für den Test.', 'Das ist der zweite Satz für den Test.'], 'the second is asked while the first plays');
  h.playing[0].ended();
  await tick(); await tick();
  assert.equal(h.playing.length, 2);
  assert.equal(h.asked.length, 3);
  h.playing[1].ended();
  await tick(); await tick();
  h.playing[2].ended();
  await tick();
  assert.equal(ended, 1);
  assert.deepEqual(h.fallback, []);
});

test('a failed call hands the rest of the line to speechSynthesis; so does audio that cannot play', async () => {
  const h = harness({ failAt: 1 });
  let ended = 0;
  h.engine.play('Das ist der erste Satz für den Test. Das ist der zweite Satz für den Test. Das ist der dritte Satz für den Test.', {}, () => { ended++; });
  await tick(); await tick();
  h.playing[0].ended();
  await tick(); await tick();
  assert.deepEqual(h.fallback, ['Das ist der zweite Satz für den Test. Das ist der dritte Satz für den Test.']);
  h.fallbackEnd();
  assert.equal(ended, 1);
  const muted = harness({ playFails: true });
  muted.engine.play('Ein ganzer Satz für den Test.', {}, () => {});
  await tick(); await tick();
  assert.deepEqual(muted.fallback, ['Ein ganzer Satz für den Test.']);
});

test('a cut line stops its audio and asks for nothing more; the queue moves on', async () => {
  const h = harness();
  const speech = new DeviceSpeech(h.engine);
  const reader = speech.channel();
  const done: string[] = [];
  reader.speak('Das ist der erste Satz für den Test. Das ist der zweite Satz für den Test. Das ist der dritte Satz für den Test.', () => done.push('first'));
  await tick(); await tick();
  reader.cancel();
  assert.equal(h.playing[0].stopped, true);
  const asked = h.asked.length;
  h.playing[0].ended();
  await tick(); await tick();
  assert.equal(h.asked.length, asked, 'nothing more after the cut');
  assert.deepEqual(done, [], 'a cancelled line never reports done');
  assert.equal(speech.speaking(), false);
});

test("the audio output is opened in the reader's own call, before voice.speak is awaited (review fix: a phone's tap was over)", () => {
  const order: string[] = [];
  const synthesis: SpeechEngine = { play: () => order.push('fallback'), stop: () => {} };
  const engine = localVoiceEngine({
    active: () => true,
    prepare: () => order.push('prepare'),
    speak: async () => { order.push('speak'); return { audio: '', sampleRate: 0, durationMs: 0 }; },
    play: async () => () => {},
  }, synthesis);
  engine.play('Ein ganzer Satz für den Test.', {}, () => {});
  assert.deepEqual(order, ['prepare', 'speak'], 'prepared synchronously, first');
  const idle = localVoiceEngine({ active: () => false, prepare: () => order.push('idle-prepare'), speak: async () => ({ audio: '', sampleRate: 0, durationMs: 0 }), play: async () => () => {} }, synthesis);
  idle.play('Hallo.', {}, () => {});
  assert.ok(!order.includes('idle-prepare'), 'no output opened without a local voice');
});

test('without a local voice every line stays with speechSynthesis', async () => {
  const h = harness({ active: false });
  let ended = 0;
  h.engine.play('Hallo.', {}, () => { ended++; });
  assert.deepEqual(h.fallback, ['Hallo.']);
  assert.deepEqual(h.asked, []);
  h.fallbackEnd();
  assert.equal(ended, 1);
  h.engine.stop();
  assert.equal(h.fallbackStops(), 1);
});

test('VOICE: a sentence later than LATE_MS after it is due goes to the device voice with the rest of its line; the next line asks the PC again', async () => {
  assert.equal(LATE_MS, 1_500);
  const asked: string[] = [];
  const fallback: string[] = [];
  let answer!: () => void;
  const engine = localVoiceEngine({
    active: () => true,
    speak: ({ text }) => { asked.push(text); return new Promise((resolve) => { answer = () => resolve({ audio: Buffer.from([0, 0]).toString('base64'), sampleRate: 24_000, durationMs: 1 }); }); },
    play: async (_samples, _rate, ended) => { setTimeout(ended, 0); return () => {}; },
  }, { play: (text, _reading, ended) => { fallback.push(text); ended(); }, stop: () => {} }, { lateMs: 20 });
  let ended = 0;
  engine.play('Das ist der erste Satz für den Test. Das ist der zweite Satz für den Test.', {}, () => { ended++; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(fallback, ['Das ist der erste Satz für den Test. Das ist der zweite Satz für den Test.'], 'the whole line, at once');
  assert.equal(ended, 1);
  answer(); // the PC's late sentence is dropped
  await tick();
  engine.play('Kurz.', {}, () => { ended++; });
  assert.equal(asked.at(-1), 'Kurz.', 'a late line rests nothing: the next one asks the PC');
  answer();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ended, 2);
  assert.equal(fallback.length, 1, 'read by the PC in time');
});

test('VOICE: a refused call rests the PC voice for restMs – those lines go straight to the device voice', async () => {
  let clock = 0;
  let refuse = true;
  const asked: string[] = [];
  const fallback: string[] = [];
  const engine = localVoiceEngine({
    active: () => true,
    now: () => clock,
    speak: async ({ text }) => { asked.push(text); if (refuse) throw new Error('No local voice is downloaded on this PC'); return { audio: '', sampleRate: 0, durationMs: 0 }; },
    play: async () => () => {},
  }, { play: (text, _reading, ended) => { fallback.push(text); ended(); }, stop: () => {} }, { restMs: 60_000 });
  engine.play('Erster Satz für den Test hier.', {}, () => {});
  await tick(); await tick();
  assert.deepEqual(fallback, ['Erster Satz für den Test hier.']);
  clock = 59_000;
  engine.play('Zweiter Satz für den Test hier.', {}, () => {});
  assert.deepEqual(asked, ['Erster Satz für den Test hier.'], 'resting: no round trip to the PC');
  assert.equal(fallback.length, 2);
  clock = 60_001;
  refuse = false;
  engine.play('Dritter Satz für den Test hier.', {}, () => {});
  assert.equal(asked.at(-1), 'Dritter Satz für den Test hier.', 'after the rest the PC is asked again');
});

test('VOICE: only a system voice picked by name keeps the device voice; a speaker number or nothing reads with the PC', () => {
  assert.equal(systemVoicePicked('Microsoft Katja - German (Germany)'), true);
  assert.equal(systemVoicePicked('3'), false);
  assert.equal(systemVoicePicked(''), false);
  assert.equal(systemVoicePicked(null), false);
  assert.equal(systemVoicePicked(undefined), false);
});
