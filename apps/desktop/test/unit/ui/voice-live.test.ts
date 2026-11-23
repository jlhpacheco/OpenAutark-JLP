// Owner 19.11.2026 ("wenn ich transkribiere anfange und dann zu einer anderen App switche, dass dann das Transkribieren
// weitergeht"): the page's "voice live" (ui/boot/voice-live.ts) – live while a dictation take, a conversation or a
// realtime call holds the microphone; the bubble's call is the realtime chat, else the listening one; both are reported
// on change only; the Android app hears {t:'voice.live', on, kind} on change, when a port arrives and when the page shows
// again. Every Dictation reports its take in `dictationLive` (ui/lib/dictation.ts). A phone page ends its talk when hidden
// only without the Android app's port (pwa-conversation.ts hideEndsTalk). A recording counts itself (recorder.ts
// recordingLive, whatever its live words do) and the app's End stops it like Stop – the take is kept.
// Owns: these assertions only. Never: a real microphone, window or app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '@preact/signals';
import { callChat, follow, isVoiceLive, liveMessage, reportToApp, voiceKind, voiceSignals, type TalkingChat } from '../../../src/ui/boot/voice-live.ts';
import { Dictation, dictationLive, type DictationDeps } from '../../../src/ui/lib/dictation.ts';
import { hideEndsTalk } from '../../../src/ui/chat/composer/pwa-conversation.ts';
import { endUnsaved, recordTake, recordingLive, stopRecordings, type RecorderLike } from '../../../src/ui/blocks/ui/recorder.ts';

test('live: any take, conversation or realtime call; the kind says call before dictation', () => {
  const none = { dictation: false, chats: [], realtime: null };
  assert.equal(isVoiceLive(none), false);
  assert.equal(voiceKind(none), null);
  assert.equal(isVoiceLive({ ...none, dictation: true }), true);
  assert.equal(voiceKind({ ...none, dictation: true }), 'dictation');
  assert.equal(voiceKind({ ...none, chats: [{ conversationId: 'a' }] }), 'call');
  assert.equal(voiceKind({ dictation: true, chats: [], realtime: 'b' }), 'call');
});

test('the bubble\'s call: the realtime chat, else the listening conversation, else the first', () => {
  const chats: TalkingChat[] = [{ conversationId: 'a' }, { conversationId: 'b', listening: true }];
  assert.equal(callChat({ dictation: false, chats, realtime: null }), 'b');
  assert.equal(callChat({ dictation: false, chats: [{ conversationId: 'a' }], realtime: null }), 'a');
  assert.equal(callChat({ dictation: false, chats, realtime: 'r' }), 'r');
  assert.equal(callChat({ dictation: true, chats: [], realtime: null }), null, 'a dictation is no call');
});

test('reports go out on change only: the same call in a new chat list or a title lookup is no new report', () => {
  const dictation = signal(false);
  const chats = signal<readonly TalkingChat[]>([]);
  const realtime = signal<string | null>(null);
  const titles = signal(new Map([['a', 'Konrad']]));
  const voice = voiceSignals({ dictation, chats, realtime, title: (id) => titles.value.get(id) ?? 'Call' });
  const live: boolean[] = [];
  const calls: string[] = [];
  follow(voice.live, (on) => live.push(on));
  follow(voice.call, (call) => calls.push(call));
  chats.value = [{ conversationId: 'a', listening: true }];
  chats.value = [{ conversationId: 'a', listening: true }]; // a new list, the same call
  titles.value = new Map([['a', 'Konrad']]);
  dictation.value = true; // still live
  chats.value = [];
  dictation.value = false;
  assert.deepEqual(live, [false, true, false]);
  assert.deepEqual(calls, ['null', '{"conversationId":"a","title":"Konrad"}', 'null']);
});

test('the Android app hears voice.live with its kind on change, at a new port and when the page shows again', () => {
  const kind = signal<'call' | 'dictation' | null>(null);
  const sent: unknown[] = [];
  const ports: Array<() => void> = [];
  const shows: Array<() => void> = [];
  let port = false;
  const stop = reportToApp(kind, {
    send: (msg) => { if (!port) return false; sent.push(msg); return true; },
    onPort: (fn) => { ports.push(fn); return () => undefined; },
    onVisible: (fn) => { shows.push(fn); return () => undefined; },
  });
  kind.value = 'dictation'; // no port yet: nothing reaches the app
  assert.deepEqual(sent, []);
  port = true;
  ports[0]!();
  kind.value = 'call';
  kind.value = null;
  shows[0]!();
  assert.deepEqual(sent, [liveMessage('dictation'), liveMessage('call'), liveMessage(null), liveMessage(null)]);
  assert.deepEqual(liveMessage('call'), { t: 'voice.live', on: true, kind: 'call' });
  assert.deepEqual(liveMessage(null), { t: 'voice.live', on: false });
  stop();
  kind.value = 'call';
  assert.equal(sent.length, 4, 'stopped');
});

test('every Dictation reports its take in dictationLive: start, finish, cancel, and two at once', async () => {
  const deps: DictationDeps = {
    problem: () => undefined,
    openMicrophone: async () => ({ stream: {} as MediaStream, close: () => undefined }),
    upload: async () => { throw new Error('unused'); },
    transcribe: async () => ({ text: '' }) as never,
    now: () => 0,
  };
  const one = new Dictation(deps);
  const two = new Dictation(deps);
  assert.equal(dictationLive.value, false);
  await one.start();
  assert.equal(dictationLive.value, true);
  await two.start();
  await one.finish();
  assert.equal(dictationLive.value, true, 'the second take still holds the microphone');
  two.cancel();
  assert.equal(dictationLive.value, false);
  const failing = new Dictation({ ...deps, openMicrophone: async () => { throw new Error('denied'); } });
  await assert.rejects(failing.start());
  assert.equal(dictationLive.value, false, 'a start that never got the microphone is not live');
});

test('a hidden phone page ends its talk only without the Android app; the desktop window never', () => {
  assert.equal(hideEndsTalk('pwa', false), true, 'the iPhone web app or a browser cannot record hidden');
  assert.equal(hideEndsTalk('pwa', true), false, 'the Android app keeps talking');
  assert.equal(hideEndsTalk('desktop', false), false);
});

test('a recording is live while it records; the app\'s End stops it like Stop (its take is kept); a discarded one is not live', () => {
  const fake = (): RecorderLike & { stops: number } => {
    const recorder = { state: 'recording', mimeType: 'audio/webm', ondataavailable: null, onstop: null, onstart: null, stops: 0,
      stop() { recorder.stops += 1; recorder.state = 'inactive'; recorder.onstop?.(new Event('stop')); } } as RecorderLike & { stops: number; state: string };
    return recorder;
  };
  const kept: number[] = [];
  const one = fake();
  void recordTake(one, { type: 'audio/webm', onEnd: (_blob, _mime, seconds) => { kept.push(seconds); } });
  assert.equal(recordingLive.value, true);
  stopRecordings();
  assert.equal(one.stops, 1);
  assert.equal(kept.length, 1, 'the take went the way of Stop');
  assert.equal(recordingLive.value, false);
  const two = fake();
  void recordTake(two, { type: 'audio/webm', onEnd: () => { kept.push(-1); } });
  endUnsaved(two);
  assert.equal(recordingLive.value, false);
  assert.equal(kept.length, 1, 'a discarded take is not kept');
});
