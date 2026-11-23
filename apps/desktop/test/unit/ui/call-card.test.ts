// B-085: the call look – the call card's words and phase (src/ui/chat/call/call-card-model.ts), the call row's words
// (B-081's ring states kept), the level meters behind the speaking ring (levels.ts), Mute (mute.ts) and realtime voice
// honouring it: muted blocks go out as silence of the same length, levels reach the meters, 'speaking' / 'done' move
// the phase (realtime-call.ts).
// Owns: these assertions only. Never: a DOM, a real microphone, speaker or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallRecord, RealtimePull } from '../../../src/shared/model/call.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { callEnd, callHeading, callMeta, callSince, captionOf, nameList, phaseOf, runningCall, statusLine } from '../../../src/ui/chat/call/call-card-model.ts';
import { LevelMeter, PlaybackMeter, micMeter, playMeter, ringScale, speakerOf } from '../../../src/ui/chat/call/levels.ts';
import { callMuted, heardSamples, setCallMuted } from '../../../src/ui/chat/call/mute.ts';
import { RealtimeCall, realtimePhase, startRealtime, stopRealtime, type RealtimeDeps } from '../../../src/ui/chat/call/realtime-call.ts';
import { time } from '../../../src/ui/lib/format.ts';
import { Pcm16Encoder } from '../../../src/ui/lib/pcm.ts';

const T0 = new Date(2026, 10, 8, 21, 24).getTime();
const record = (over: Partial<CallRecord> = {}): CallRecord => ({ id: 'call_1', participant: 'device:pc', name: 'PC', startedAt: T0, lines: [], ...over });
const row = (call: CallRecord) => ({ kind: 'status', meta: { call } }) as unknown as Pick<Message, 'kind' | 'meta'>;
const names: Record<string, string> = { ag_ava: 'Ava', ag_ben: 'Ben', ag_cy: 'Cy', ag_dee: 'Dee' };
const nameOf = (id: string) => names[id];

test('card phase: realtime phases, playing audio counts as speaking, the voice conversation maps its phases', () => {
  assert.equal(phaseOf('connecting', undefined, true), 'connecting');
  assert.equal(phaseOf('listening', undefined, true), 'speaking');
  assert.equal(phaseOf('listening', undefined, false), 'listening');
  assert.equal(phaseOf('speaking', 'listening'), 'speaking');
  assert.equal(phaseOf(undefined, 'starting'), 'connecting');
  assert.equal(phaseOf(undefined, 'listening'), 'listening');
  assert.equal(phaseOf(undefined, 'transcribing'), 'working');
  assert.equal(phaseOf(undefined, 'responding'), 'working');
  assert.equal(phaseOf(undefined, 'speaking'), 'speaking');
  assert.equal(phaseOf(undefined, undefined), 'connecting');
  assert.equal(phaseOf(undefined, 'on hold'), 'held', 'another conversation listens (shell-state voicePhase)');
  assert.equal(phaseOf(undefined, 'reply waiting'), 'waiting');
  assert.equal(statusLine('held', T0, T0 + 83_000), 'On hold · 1:23');
  assert.equal(statusLine('waiting', T0, T0 + 5_000), 'Reply waiting · 0:05');
});

test('card status: "Listening · 1:23", "Connecting…" alone, a phase alone before the call row is there', () => {
  assert.equal(statusLine('listening', T0, T0 + 83_000), 'Listening · 1:23');
  assert.equal(statusLine('speaking', T0, T0 + 5_000), 'Speaking · 0:05');
  assert.equal(statusLine('working', T0, T0 + 3_725_000), 'Working… · 1:02:05');
  assert.equal(statusLine('connecting', T0, T0 + 9_000), 'Connecting…');
  assert.equal(statusLine('listening', undefined, T0), 'Listening');
});

test('card call: the newest running row, its talk counted from the answer of a ring', () => {
  const ended = record({ id: 'call_0', endedAt: T0 + 1000 });
  const running = record({ id: 'call_1' });
  const ringing = record({ id: 'call_2', ring: { by: 'ag_ava', why: 'Logo', until: T0 + 45_000 } });
  assert.equal(runningCall([row(ended), row(running), row(ringing)], T0 + 2000)?.id, 'call_1');
  assert.equal(runningCall([row(ended)], T0 + 2000), undefined);
  assert.equal(runningCall([{ kind: 'text', meta: {} } as unknown as Pick<Message, 'kind' | 'meta'>], T0), undefined);
  assert.equal(callSince(running), T0);
  assert.equal(callSince(record({ ring: { by: 'ag_ava', why: 'x', until: T0 + 45_000, answeredAt: T0 + 7000 } })), T0 + 7000);
});

test('card caption: name and side, markdown stripped, a long line keeps its end', () => {
  assert.equal(captionOf(undefined), undefined);
  assert.deepEqual(captionOf({ at: T0, from: 'agent:ag_ava', name: 'Ava', text: 'The **budget** is fine.' }), { name: 'Ava', side: 'agent', text: 'The budget is fine.' });
  assert.equal(captionOf({ at: T0, from: 'device:pc', name: 'You', text: 'ok' })?.side, 'person');
  const long = captionOf({ at: T0, from: 'device:pc', name: 'You', text: `${'a'.repeat(300)} END` })!;
  assert.equal(long.text.length, 160);
  assert.ok(long.text.startsWith('…') && long.text.endsWith(' END'));
  assert.equal(captionOf({ at: T0, from: 'device:pc', name: 'You', text: '   ' }), undefined);
});

test('call row: "Call from Ava" for a ring, "Call with" the agents of the call and those heard, else the chat', () => {
  assert.equal(callHeading(record({ ring: { by: 'ag_ava', why: 'x', until: T0 } }), nameOf), 'Call from Ava');
  assert.equal(callHeading(record({ ring: { by: 'ag_gone', why: 'x', until: T0 } }), nameOf), 'Call from an agent');
  assert.equal(callHeading(record({ agents: ['ag_ava'], lines: [{ at: T0, from: 'agent:ag_ben', name: 'Ben', text: 'hi' }, { at: T0, from: 'device:pc', name: 'You', text: 'yo' }] }), nameOf), 'Call with Ava and Ben');
  assert.equal(callHeading(record(), nameOf, 'Launch plan'), 'Call with Launch plan');
  assert.equal(callHeading(record(), nameOf), 'Call');
  assert.equal(nameList(['Ava', 'Ben', 'Cy', 'Dee']), 'Ava, Ben and 2 more');
  assert.equal(nameList(['Ava']), 'Ava');
});

test('call row: meta "21:24 · 3 lines", older days with their day; end words keep B-081 states', () => {
  const line = { at: T0, from: 'device:pc', name: 'You', text: 'x' };
  assert.equal(callMeta(record({ lines: [line, line, line] }), T0 + 60_000), `${time(T0)} · 3 lines`);
  assert.equal(callMeta(record({ lines: [line] }), T0 + 60_000), `${time(T0)} · 1 line`);
  assert.match(callMeta(record(), T0 + 2 * 86_400_000), new RegExp(`, ${time(T0)} · Nothing said$`));
  const joined = [{ participant: 'device:dev_phone', name: 'Pixel' }, { participant: 'device:dev_tab', name: 'Tab' }];
  assert.equal(callMeta(record({ lines: [line], joined }), T0 + 60_000), `${time(T0)} · 1 line · PC, Pixel and Tab`, 'owner 19.11.2026: the devices in a running call');
  assert.equal(callMeta(record({ lines: [line], joined, endedAt: T0 + 1000 }), T0 + 60_000), `${time(T0)} · 1 line`, 'an ended call names none');
  assert.equal(callEnd(record(), T0 + 5000), 'Running');
  assert.equal(callEnd(record({ endedAt: T0 + 282_000 }), T0 + 300_000), '4:42');
  const ring = { by: 'ag_ava', why: 'x', until: T0 + 45_000 };
  assert.equal(callEnd(record({ ring }), T0 + 1000), 'Ringing');
  assert.equal(callEnd(record({ ring }), T0 + 46_000), 'Missed');
  assert.equal(callEnd(record({ ring: { ...ring, declined: { at: T0 + 2000, name: 'Pixel' } } }), T0 + 3000), 'Declined');
  assert.equal(callEnd(record({ ring: { ...ring, answeredAt: T0 + 10_000 }, endedAt: T0 + 70_000 }), T0 + 80_000), '1:00');
});

test('levels: a meter rises at once and falls; playback counts while its piece plays; speaker and ring scale', () => {
  const meter = new LevelMeter();
  meter.push(0.8, 1000);
  assert.equal(meter.read(1000), 0.8);
  assert.ok(Math.abs(meter.read(1250) - 0.2) < 1e-9);
  assert.equal(meter.read(2000), 0);
  meter.push(0.3, 2000);
  meter.push(0.1, 2010);
  assert.ok(meter.read(2010) > 0.25, 'a quieter block does not cut a louder one short');

  const play = new PlaybackMeter();
  play.queue(0.6, 1000, 100);
  play.queue(0.4, 1100, 100);
  assert.equal(play.read(900), 0);
  assert.equal(play.playing(900), true);
  assert.equal(play.read(1050), 0.6);
  assert.equal(play.read(1150), 0.4);
  assert.equal(play.read(1200), 0);
  assert.equal(play.playing(1200), false);
  play.queue(0.5, 2000, 100);
  play.clear();
  assert.equal(play.read(2050), 0);

  assert.equal(speakerOf(0.1, 0.5), 'agent');
  assert.equal(speakerOf(0.6, 0.5), 'person');
  assert.equal(speakerOf(0.1, 0.1), undefined);
  assert.equal(ringScale(0), 1);
  assert.equal(ringScale(2), 1.18);
});

test('mute: silence of the same length while muted, the block itself otherwise', () => {
  const block = new Float32Array([0.5, -0.5, 0.25]);
  assert.equal(heardSamples(block, false), block);
  const quiet = heardSamples(block, true);
  assert.equal(quiet.length, 3);
  assert.ok(quiet.every((sample) => sample === 0));
});

class FakeSource { buffer: { duration: number } | null = null; onended: (() => void) | null = null; connect() {} start() {} stop() {} }
class FakeOutput {
  currentTime = 0;
  destination = {};
  createBuffer(_channels: number, length: number, rate: number) { const data = new Float32Array(length); return { duration: length / rate, getChannelData: () => data }; }
  createBufferSource() { return new FakeSource(); }
  async close() {}
}

function fakeDeps() {
  const sent: string[] = [];
  const pulls: Array<(pull: RealtimePull) => void> = [];
  let onSamples: ((samples: Float32Array, rate: number) => void) | undefined;
  const deps: RealtimeDeps = {
    call: (async (method: string, params: Record<string, unknown>) => {
      if (method === 'calls.realtimeOpen') return { sessionId: 'rts_1', model: 'gpt-realtime', agentId: 'ag_ava' };
      if (method === 'calls.realtimePull') return new Promise((resolve) => pulls.push(resolve));
      if (method === 'calls.realtimeSend') sent.push(String(params.audio));
      return { ok: true };
    }) as RealtimeDeps['call'],
    openMicrophone: async (listener) => { onSamples = listener; return { stream: {} as MediaStream, close: () => undefined }; },
    newOutput: () => new FakeOutput() as unknown as AudioContext,
  };
  return { deps, sent, pulls, feed: (samples: Float32Array) => onSamples!(samples, 24_000) };
}

test('realtime + mute: muted blocks go out as silence of the same length, the mic meter stays quiet; a new call starts unmuted', async () => {
  const { deps, sent, feed } = fakeDeps();
  await startRealtime('ch_mute', () => undefined, deps);
  assert.equal(callMuted.value, false);
  assert.equal(realtimePhase.value, 'listening');
  micMeter.clear();
  feed(new Float32Array(2400).fill(0.5));
  assert.equal(sent.length, 1);
  assert.ok(atob(sent[0]).split('').some((char) => char.charCodeAt(0) !== 0), 'unmuted: the voice goes out');
  assert.ok(micMeter.read(performance.now()) > 0.5);
  setCallMuted(true);
  micMeter.clear();
  feed(new Float32Array(2400).fill(0.5));
  assert.equal(sent.length, 2);
  const quiet = atob(sent[1]);
  assert.equal(quiet.length, 4800, 'the stream goes on at the same pace');
  assert.ok(quiet.split('').every((char) => char.charCodeAt(0) === 0), 'muted: silence');
  assert.equal(micMeter.read(performance.now()), 0);
  stopRealtime();
  assert.equal(callMuted.value, false);
});

test('realtime + mute: a session that ends by itself (provider drop, TAKEN_OVER) leaves the next voice unmuted', async () => {
  const { deps, pulls } = fakeDeps();
  let reason: string | undefined;
  await startRealtime('ch_drop', (why) => { reason = why; }, deps);
  setCallMuted(true);
  pulls.shift()!({ events: [], next: 0, closed: 'TAKEN_OVER' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reason, 'TAKEN_OVER');
  assert.equal(callMuted.value, false);
});

test('realtime phase and playback meter: speaking on the answer, its audio queued on the meter, listening after done', async () => {
  const { deps, pulls } = fakeDeps();
  const session = new RealtimeCall('ch_phase', deps);
  realtimePhase.value = 'connecting';
  await session.start(() => undefined);
  assert.equal(realtimePhase.value, 'listening');
  playMeter.clear();
  const pcm = new Pcm16Encoder(24_000, 24_000).push(new Float32Array(2400).fill(0.25));
  const audio = btoa(String.fromCharCode(...pcm));
  pulls.shift()!({ events: [{ seq: 1, type: 'speaking' }, { seq: 2, type: 'audio', data: audio }], next: 2 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(realtimePhase.value, 'speaking');
  assert.equal(playMeter.playing(performance.now()), true);
  assert.ok(playMeter.read(performance.now()) > 0.5);
  pulls.shift()!({ events: [{ seq: 3, type: 'done' }], next: 3 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(realtimePhase.value, 'listening');
  session.stop();
  assert.equal(playMeter.playing(performance.now()), false, 'stopping cuts the queued audio off the meter');
});
