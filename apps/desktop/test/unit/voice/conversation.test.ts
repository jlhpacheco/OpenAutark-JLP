// The voice conversation loop (shared/voice/conversation.ts): an utterance is transcribed and sent in the
// listening chat (marked live), the agent's reply is read aloud and the microphone listens again; nothing
// heard asks to say it again; speech while a reply is awaited goes out at once; parallel chats (simplest
// form): the chat started or focused last hears, replies are read one at a time with another chat's title in
// front; talking over the reading stops it; a take said while a line is heard or a reply is read waits and goes out in
// its order once the loop is free; B-082: every line is heard live (`live: true`), a line that cannot be heard
// goes as its recording and the call goes on. Each talking chat is a
// call (calls.start/end, its id on every line; a page without calls talks too); the wait for a reply goes on while an
// agent of the chat works and opens again when one starts later. B-081: a start with a callId takes that call and reads
// every new agent line (the opening first); another holder in the call row ends the chat quietly; the speaker's name
// goes in front when the speaker changes. Owner 19.11.2026: a device joined beside the holder reads nothing until it hears a
// line; the device that heard the person's newest line of the call reads the reply, another one goes quiet; a quiet device
// drops a take that repeats what others just said (the other device's voice); a joined device ends quietly when the call ends.
// Owns: these assertions only. Never: a microphone, a speech output or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VOICE_SESSIONS, REPEAT_HINT, SESSIONS_FULL, VoiceSessions, echoOf, speakable } from '../../../src/shared/voice/conversation.ts';
import type { ConversationRpc, VoiceSessionEntry, VoiceSessionView } from '../../../src/shared/voice/conversation.ts';
import type { Message } from '../../../src/shared/model/chat.ts';

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

function setup(heard: string[] = [], options: { noCalls?: boolean; joined?: boolean; runtimeCall?: string; shown?: (conversationId: string) => Promise<Array<{ fileId: string; name: string; mime: string; size: number }>> } = {}) {
  const listeners = new Map<string, Array<(message: Message) => void>>();
  const sent: Array<{ conversationId: string; body: string; live?: boolean; call?: string; attachments?: string[] }> = [];
  const transcribed: Array<Record<string, unknown>> = [];
  const ended: string[] = [];
  const starts: Array<Record<string, unknown>> = [];
  const working = new Set<string>();
  const timers: Array<() => void> = [];
  const spoken: string[] = [];
  const states: Array<{ mic: VoiceSessionView | null; error?: string; chats: VoiceSessionEntry[] }> = [];
  let seq = 10;
  let silenced = 0;
  let id = 0;
  let transcribeError: Error | undefined;
  let sendError: Error | undefined;
  const rpc: ConversationRpc = {
    call: (async (method: string, params: Record<string, unknown>) => {
      if (method === 'chats.get') return { id: params.id, title: params.id === 'ch_b' ? 'Research' : 'Main', working: working.has(params.id as string) ? ['ag_tom'] : [] };
      if (method === 'voice.transcribe') { transcribed.push(params); if (transcribeError) throw transcribeError; return { text: heard.shift() ?? '' }; }
      if (method === 'calls.start') {
        starts.push(params);
        if (options.noCalls) throw new Error('forbidden');
        return { callId: (params.callId as string | undefined) ?? `call_${params.conversationId as string}`, ...(options.joined ? { holder: '/device:dev_phone', joined: true } : { holder: '/device:pc' }) };
      }
      if (method === 'calls.end') { ended.push(params.callId as string); return { ok: true }; }
      if (method === 'messages.send') {
        if (sendError) throw sendError;
        const speech = params.speech as { live?: boolean; call?: string } | undefined;
        const files = (params.attachments as Array<{ fileId: string }> | undefined)?.map((attachment) => attachment.fileId);
        sent.push({ conversationId: params.conversationId as string, body: params.body as string, live: speech?.live, ...(speech?.call ? { call: speech.call } : {}), ...(files ? { attachments: files } : {}) });
        const call = speech?.call ?? options.runtimeCall; // runtimeCall: the runtime opens the device's call for a line that names none
        return { seq: ++seq, meta: call ? { call: { id: call } } : {} };
      }
      throw new Error(`unexpected ${method}`);
    }) as ConversationRpc['call'],
    on: ((event: string, listener: (message: Message) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => undefined;
    }) as ConversationRpc['on'],
    subscribe: async () => () => undefined,
  };
  const voice = new VoiceSessions({
    rpc,
    publish: (mic, error, chats) => states.push({ mic, error, chats }),
    speak: (_micId, text) => spoken.push(text),
    silence: () => { silenced += 1; },
    newId: () => `id${++id}`,
    after: (_ms, fn) => { timers.push(fn); return () => { const at = timers.indexOf(fn); if (at >= 0) timers.splice(at, 1); }; },
    language: () => 'de',
    nameOf: (agentId) => ({ ag_ava: 'Ava', ag_ben: 'Ben' } as Record<string, string>)[agentId],
    ...(options.shown ? { shown: options.shown } : {}),
  });
  const emit = (event: 'message.created' | 'message.updated', message: Message) => { for (const listener of listeners.get(event) ?? []) listener(message); };
  const reply = (conversationId: string, body: string, state: Message['state'] = 'final', authorId?: string) => {
    emit('message.created', { id: `m${++seq}`, conversationId, seq, authorKind: 'agent', authorId, kind: 'text', state, body, meta: {} } as unknown as Message);
  };
  /** The person's line of the call said on another device. */
  const said = (conversationId: string, callId: string, body: string, authorId = 'human') => {
    emit('message.created', { id: `m${++seq}`, conversationId, seq, authorKind: 'human', authorId, kind: 'text', state: 'final', body, meta: { call: { id: callId, participant: 'device:dev_other', name: 'Other' } } } as unknown as Message);
  };
  return {
    voice, sent, spoken, states, reply, emit, said, ended, starts, working, transcribed,
    /** The reply timers run out now. */
    elapse: async () => { for (const fn of timers.splice(0)) fn(); await tick(); },
    mic: () => voice.view(),
    silenced: () => silenced,
    failTranscription: (error: Error | undefined) => { transcribeError = error; },
    failSend: (error: Error | undefined) => { sendError = error; },
  };
}

test('utterance → transcription → a live message; the reply is read and the microphone listens again', async () => {
  const t = setup(['Wie wird das Wetter?']);
  const view = await t.voice.start('ch_a');
  assert.equal(view.status, 'listening');
  await t.voice.utterance(view.id, 'f1');
  assert.deepEqual(t.sent, [{ conversationId: 'ch_a', body: 'Wie wird das Wetter?', live: true, call: 'call_ch_a' }], 'the line of the chat\'s call');
  assert.equal(t.voice.sessions()[0].status, 'responding');
  assert.equal(t.mic()?.status, 'listening', 'the person may talk while the reply is awaited');
  t.reply('ch_a', 'Sonnig mit **20 Grad**.', 'streaming');
  assert.deepEqual(t.spoken, []);
  t.reply('ch_a', 'Sonnig mit **20 Grad**.');
  assert.deepEqual(t.spoken, [speakable('Sonnig mit **20 Grad**.')]);
  assert.equal(t.mic()?.status, 'speaking');
  t.voice.spokenDone(view.id);
  assert.equal(t.mic()?.status, 'listening');
});

// KI-Runde FIXES-3 E3 (18.11.2026): the main work's call answer as it came in the real run (Codex, line 08) – a bold
// heading, a paragraph, a link to a file. What is read is its words, and a line that ends without a stop still ends there.
test('a main work\'s answer with Markdown is read as speech: no markup, the link\'s words, a pause after a line without a stop', async () => {
  const t = setup(['Schick mir die Website-Texte.']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  t.reply('ch_a', 'Hier ist die fertige Startseitenfassung:\n\n**Gestaltung, Druck und Webauftritt**\n\nWir unterstützen dich bei Gestaltung, Druck und deinem Webauftritt. Kontaktiere uns – wir freuen uns auf dein Projekt.\n\n[Textdatei öffnen](C:/Users/x/work/calls/website/startseite-neu.txt)');
  assert.deepEqual(t.spoken, ['Hier ist die fertige Startseitenfassung: Gestaltung, Druck und Webauftritt. Wir unterstützen dich bei Gestaltung, Druck und deinem Webauftritt. Kontaktiere uns – wir freuen uns auf dein Projekt. Textdatei öffnen']);
  assert.equal(speakable('- Website: 2.000 €\n- Logo: 1.500 €'), 'Website: 2.000 €. Logo: 1.500 €', 'each list line is its own piece');
});

// KI-Runde 17.11.2026, fix after the review: a take that arrived while the reply was read was dropped without a trace.
test('no words heard asks to say it again; an utterance while a reply is read waits and goes out when the reading ends', async () => {
  const t = setup(['', 'hello', 'said over the reply']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  assert.equal(t.mic()?.hint, REPEAT_HINT);
  assert.equal(t.sent.length, 0);
  await t.voice.utterance(view.id, 'f2');
  t.reply('ch_a', 'Hi.');
  assert.deepEqual(t.spoken, ['Hi.']);
  await t.voice.utterance(view.id, 'f3'); // said while the reply is read: kept, not heard yet
  assert.deepEqual(t.sent.map((line) => line.body), ['hello']);
  t.voice.spokenDone(view.id);
  await tick();
  assert.deepEqual(t.transcribed.map((params) => params.fileId), ['f1', 'f2', 'f3']);
  assert.deepEqual(t.sent.map((line) => line.body), ['hello', 'said over the reply']);
});

test('speech while a reply is awaited goes out at once; that reply is then not read', async () => {
  const t = setup(['first', 'second']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  await t.voice.utterance(view.id, 'f2');
  await tick();
  assert.deepEqual(t.sent.map((line) => line.body), ['first', 'second']);
});

test('parallel chats: the newest listens, another chat reply is read with its title, focus moves by start', async () => {
  const t = setup(['to research', 'to main']);
  await t.voice.start('ch_a');
  const view = await t.voice.start('ch_b');
  assert.equal(t.mic()?.conversationId, 'ch_b');
  assert.deepEqual(t.voice.sessions().map((chat) => [chat.conversationId, chat.listening]), [['ch_b', true], ['ch_a', false]]);
  await t.voice.utterance(view.id, 'f1');
  assert.equal(t.sent[0].conversationId, 'ch_b');
  await t.voice.start('ch_a'); // focus
  assert.equal(t.mic()?.conversationId, 'ch_a');
  await t.voice.utterance(view.id, 'f2');
  assert.equal(t.sent[1].conversationId, 'ch_a');
  t.reply('ch_b', 'Found three papers.');
  t.reply('ch_a', 'Done.');
  assert.deepEqual(t.spoken, ['Research: Found three papers.']);
  t.voice.spokenDone(view.id);
  assert.deepEqual(t.spoken, ['Research: Found three papers.', 'Done.']);
  await t.voice.start('ch_c');
  await assert.rejects(t.voice.start('ch_d'), new RegExp(SESSIONS_FULL.slice(0, 20)));
  assert.equal(t.voice.sessions().length, MAX_VOICE_SESSIONS);
});

test('talking over the reading stops it and drops what waits; ending the reading chat silences it', async () => {
  const t = setup(['a']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  t.reply('ch_a', 'One.');
  assert.equal(t.voice.bargeIn(view.id), true);
  assert.equal(t.silenced(), 1);
  assert.equal(t.mic()?.status, 'listening');
  assert.equal(t.voice.bargeIn(view.id), false, 'nothing is read');
  t.voice.stop('ch_a');
  assert.equal(t.mic(), null);
  assert.equal(t.voice.active, false);
  assert.deepEqual(t.ended, ['call_ch_a'], 'ending the chat ends its call');
});

test('a page that cannot start calls talks without one', async () => {
  const t = setup(['hallo'], { noCalls: true });
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  assert.deepEqual(t.sent, [{ conversationId: 'ch_a', body: 'hallo', live: true }]);
  t.voice.stop('ch_a');
  assert.deepEqual(t.ended, []);
});

test('a call the runtime opened for a line (calls.start failed) is the one the end reaches', async () => {
  const t = setup(['hallo', 'noch was'], { noCalls: true, runtimeCall: 'call_runtime' });
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  t.reply('ch_a', 'Hallo!');
  t.voice.spokenDone(view.id);
  await t.voice.utterance(view.id, 'f2');
  assert.deepEqual(t.sent.map((line) => line.call), [undefined, 'call_runtime'], 'the next line names it');
  t.voice.stop('ch_a');
  assert.deepEqual(t.ended, ['call_runtime']);
});

test('the wait for a reply goes on while an agent of the chat works, ends when none does, and opens again when one starts', async () => {
  const t = setup(['Mach den Export']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  t.working.add('ch_a'); // e.g. a row that streams on the agent's home PC
  await t.elapse();
  assert.equal(t.voice.sessions()[0].status, 'responding', 'still waiting after the reply time');
  t.working.delete('ch_a');
  await t.elapse();
  assert.equal(t.voice.sessions()[0].status, 'listening', 'nobody works on it: the wait ends');
  t.reply('ch_a', '', 'streaming'); // an agent starts its answer later
  assert.equal(t.voice.sessions()[0].status, 'responding');
  t.reply('ch_a', 'Export ist fertig.');
  assert.deepEqual(t.spoken, ['Export ist fertig.']);
  assert.notEqual(t.voice.sessions()[0].status, 'responding');
});

test('B-082: lines are heard live; a line that cannot be heard goes as its recording and the call goes on', async () => {
  const t = setup(['Und dann?']);
  const view = await t.voice.start('ch_a');
  t.failTranscription(new Error('Speech to text is not set up yet.'));
  await t.voice.utterance(view.id, 'f1');
  await tick();
  assert.deepEqual(t.transcribed, [{ fileId: 'f1', live: true, language: 'de' }]);
  assert.equal(t.voice.active, true, 'the conversation goes on');
  assert.deepEqual(t.sent, [{ conversationId: 'ch_a', body: '', live: true, call: 'call_ch_a', attachments: ['f1'] }], 'the line as its recording, a line of the call');
  assert.equal(t.voice.sessions()[0].status, 'responding', 'the reply to it is awaited');
  assert.deepEqual([t.ended, t.states.at(-1)?.error], [[], undefined]);
  t.reply('ch_a', 'Verstanden.');
  assert.deepEqual(t.spoken, ['Verstanden.']);
  t.voice.spokenDone(view.id);
  t.failTranscription(undefined);
  await t.voice.utterance(view.id, 'f2');
  assert.deepEqual(t.sent.at(-1), { conversationId: 'ch_a', body: 'Und dann?', live: true, call: 'call_ch_a' }, 'the next line is heard again');
});

test('B-082: a line neither heard nor sent asks to say it again; the conversation goes on and listens', async () => {
  const t = setup();
  const view = await t.voice.start('ch_a');
  t.failTranscription(new Error('The plan is used up.'));
  t.failSend(new Error('The connection dropped.'));
  await t.voice.utterance(view.id, 'f1');
  await tick();
  assert.deepEqual([t.voice.active, t.sent, t.ended], [true, [], []]);
  assert.deepEqual([t.mic()?.status, t.mic()?.hint], ['listening', REPEAT_HINT]);
  assert.equal(t.voice.sessions()[0].status, 'listening', 'no reply is awaited for a line that never went out');
});

test('B-081: a start with a callId takes that call; the opening line and every new agent line are read, the name when the speaker changes', async () => {
  const t = setup();
  const view = await t.voice.start('ch_a', 'call_ring');
  assert.deepEqual(t.starts, [{ conversationId: 'ch_a', callId: 'call_ring' }]);
  t.reply('ch_a', 'Gerd, kurz zum Logo.', 'final', 'ag_ava'); // the opening line, before the person said anything
  assert.deepEqual(t.spoken, ['Gerd, kurz zum Logo.']);
  t.voice.spokenDone(view.id);
  t.reply('ch_a', 'Und das Budget reicht.', 'final', 'ag_ben');
  t.voice.spokenDone(view.id);
  t.reply('ch_a', 'Danke, Ben.', 'final', 'ag_ava');
  assert.deepEqual(t.spoken, ['Gerd, kurz zum Logo.', 'Ben: Und das Budget reicht.', 'Ava: Danke, Ben.']);
});

test('B-081: another device took the call (its row shows another holder) – the chat ends quietly, without calls.end', async () => {
  const t = setup();
  await t.voice.start('ch_a', 'call_ring');
  const row = (participant: string) => ({ id: 'm_row', conversationId: 'ch_a', seq: 1, authorKind: 'system', kind: 'status', state: 'final', body: '', meta: { call: { id: 'call_ring', participant, name: 'x', startedAt: 1, lines: [] } } }) as unknown as Message;
  t.emit('message.updated', row('device:pc')); // its own row: nothing happens
  assert.equal(t.voice.active, true);
  t.emit('message.updated', row('device:dev_phone'));
  assert.equal(t.voice.active, false);
  assert.deepEqual(t.ended, [], 'the call goes on on the phone');
  assert.equal(t.states.at(-1)?.error, undefined, 'no error');
  const fails = setup(undefined, { noCalls: true });
  await assert.rejects(fails.voice.start('ch_a', 'call_gone'), /forbidden/, 'a call that cannot be taken does not start a conversation without it');
});

test('B-081: a pin goes into a talking chat as a line of its call and its reply is read; a chat that does not talk takes none', async () => {
  const t = setup(['und das hier']);
  assert.equal(t.voice.add('ch_a', 'Pinned on localhost (tab web-1):'), false, 'nothing talks yet');
  const view = await t.voice.start('ch_a');
  assert.equal(t.voice.add('ch_b', 'Pinned on localhost (tab web-1):'), false, 'another chat does not talk');
  assert.equal(t.voice.add('ch_a', '  '), false);
  assert.equal(t.voice.add('ch_a', 'Pinned on localhost (tab web-1):\nbutton · button.buy'), true);
  assert.deepEqual(t.sent, [{ conversationId: 'ch_a', body: 'Pinned on localhost (tab web-1):\nbutton · button.buy', live: true, call: 'call_ch_a' }]);
  await t.voice.utterance(view.id, 'f1'); // said while the pin's reply is awaited: out at once, as speech is
  await tick();
  assert.deepEqual(t.sent.map((line) => line.body), ['Pinned on localhost (tab web-1):\nbutton · button.buy', 'und das hier']);
  t.reply('ch_a', 'Zwei Pixel kleiner?');
  assert.deepEqual(t.spoken, ['Zwei Pixel kleiner?']);
});

// KI-Runde 17.11.2026: words said while the last line was still heard were thrown away.
test('an utterance said while the last one is heard is kept and goes out as the next line', async () => {
  const t = setup(['Erstens', 'Zweitens']);
  const view = await t.voice.start('ch_a');
  const first = t.voice.utterance(view.id, 'file_1');
  const second = t.voice.utterance(view.id, 'file_2'); // the first is still being heard
  await Promise.all([first, second]);
  await tick();
  assert.deepEqual(t.transcribed.map((params) => params.fileId), ['file_1', 'file_2']);
  assert.deepEqual(t.sent.map((line) => line.body), ['Erstens', 'Zweitens']);
});

// KI-Runde 17.11.2026, fix after the review: the capture hands takes over strictly one after another, so a take that
// arrived while the reply of the one before was read was lost exactly when the call voice answered quickly.
test('three takes in the capture\'s order: the first reply is read while the second is heard, and the third still goes out', async () => {
  const sent: string[] = [];
  const spoken: string[] = [];
  const waits = new Map<string, (text: string) => void>();
  const listeners: Array<(message: Message) => void> = [];
  let seq = 10;
  const rpc = {
    call: async (method: string, params: Record<string, unknown>) => {
      if (method === 'chats.get') return { id: 'ch_a', title: 'Main', working: [] };
      if (method === 'calls.start') return { callId: 'call_a', holder: '/device:pc' };
      if (method === 'voice.transcribe') return await new Promise((resolve) => waits.set(params.fileId as string, (text) => resolve({ text })));
      if (method === 'messages.send') { sent.push(params.body as string); return { seq: ++seq, meta: { call: { id: 'call_a' } } }; }
      return { ok: true };
    },
    on: (event: string, listener: (message: Message) => void) => { if (event === 'message.created') listeners.push(listener); return () => undefined; },
    subscribe: async () => () => undefined,
  } as unknown as ConversationRpc;
  const voice = new VoiceSessions({ rpc, publish: () => undefined, speak: (_micId, text) => spoken.push(text), silence: () => undefined, newId: () => `id${++seq}`, after: () => () => undefined, language: () => 'de' });
  const view = await voice.start('ch_a');
  const chain = (async () => { await voice.utterance(view.id, 'A'); await voice.utterance(view.id, 'B'); await voice.utterance(view.id, 'C'); })();
  await tick();
  waits.get('A')!('erster Teil');
  await tick(); // A's line went out; B is being heard now
  for (const listener of listeners) listener({ id: 'm_a', conversationId: 'ch_a', seq: ++seq, authorKind: 'agent', authorId: 'ag_ava', kind: 'text', state: 'final', body: 'Antwort auf A.', meta: {} } as unknown as Message);
  assert.deepEqual(spoken, ['Antwort auf A.'], 'the reply is read while B is still heard');
  waits.get('B')!('zweiter Teil');
  await chain;
  await tick();
  assert.equal(waits.has('C'), false, 'C waits for the reading to end instead of being thrown away');
  voice.spokenDone(view.id);
  await tick();
  waits.get('C')!('dritter Teil');
  await tick();
  assert.deepEqual(sent, ['erster Teil', 'zweiter Teil', 'dritter Teil']);
});

test('a take held while a held take is heard stays when a reply starts reading meanwhile, and is heard after it (review r2-1 blocker)', async () => {
  const sent: string[] = [];
  const spoken: string[] = [];
  const waits = new Map<string, (text: string) => void>();
  const listeners: Array<(message: Message) => void> = [];
  let seq = 10;
  const rpc = {
    call: async (method: string, params: Record<string, unknown>) => {
      if (method === 'chats.get') return { id: 'ch_a', title: 'Main', working: [] };
      if (method === 'calls.start') return { callId: 'call_a', holder: '/device:pc' };
      if (method === 'voice.transcribe') return await new Promise((resolve) => waits.set(params.fileId as string, (text) => resolve({ text })));
      if (method === 'messages.send') { sent.push(params.body as string); return { seq: ++seq, meta: { call: { id: 'call_a' } } }; }
      return { ok: true };
    },
    on: (event: string, listener: (message: Message) => void) => { if (event === 'message.created') listeners.push(listener); return () => undefined; },
    subscribe: async () => () => undefined,
  } as unknown as ConversationRpc;
  const voice = new VoiceSessions({ rpc, publish: () => undefined, speak: (_micId, text) => spoken.push(text), silence: () => undefined, newId: () => `id${++seq}`, after: () => () => undefined, language: () => 'de' });
  const reply = (body: string) => { for (const listener of listeners) listener({ id: `m${++seq}`, conversationId: 'ch_a', seq, authorKind: 'agent', authorId: 'ag_ava', kind: 'text', state: 'final', body, meta: {} } as unknown as Message); };
  const view = await voice.start('ch_a');
  const a = voice.utterance(view.id, 'A');
  await tick();
  waits.get('A')!('eins');
  await a;
  await tick();
  reply('Antwort eins.');
  await voice.utterance(view.id, 'B'); // held: a reply is read
  voice.spokenDone(view.id); // the reading ends: B is heard
  await tick();
  await voice.utterance(view.id, 'C'); // held: B is being heard
  reply('Antwort zwei.'); // a reply starts reading while B is heard
  waits.get('B')!('zwei');
  await tick();
  assert.equal(waits.has('C'), false, 'C waits while the reply is read');
  voice.spokenDone(view.id);
  await tick();
  assert.ok(waits.has('C'), 'C is heard once the reading ended');
  waits.get('C')!('drei');
  await tick();
  assert.deepEqual(sent, ['eins', 'zwei', 'drei']);
  assert.deepEqual(spoken, ['Antwort eins.', 'Antwort zwei.']);
});

test('the program\'s line in my call (no model can answer) is read; a system line of another call or of a page without a call is not', async () => {
  const t = setup(['Hallo?']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'file_1');
  await tick();
  const system = (seq: number, call?: string) => ({ id: `s${seq}`, conversationId: 'ch_a', seq, authorKind: 'system', authorId: 'system', kind: 'text', state: 'final', body: 'Gerade kann kein Modell antworten.', silent: false, meta: call ? { call: { id: call, participant: 'system', name: 'Autark' } } : {} }) as unknown as Message;
  t.emit('message.created', system(90, 'call_other'));
  assert.deepEqual(t.spoken, []);
  t.emit('message.created', system(91, 'call_ch_a'));
  assert.deepEqual(t.spoken, ['Gerade kann kein Modell antworten.']);

  const noCall = setup(['Hallo?'], { noCalls: true }); // a person's page talks without a call row
  const other = await noCall.voice.start('ch_a');
  await noCall.voice.utterance(other.id, 'file_1');
  await tick();
  noCall.emit('message.created', system(92));
  assert.deepEqual(noCall.spoken, [], 'a system line without a call is not the program speaking in my call');
});

// KI-Runde 17.11.2026, decision 7.3: the live voice writes its line while it speaks, and nothing was read until it ended.
test('the live voice\'s row: every finished sentence is read as it completes, the rest when the row is final', async () => {
  const t = setup(['Wie weit ist der Build?']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'file_1');
  await tick();
  const voiced = (seq: number, body: string, state: Message['state'], call = 'call_ch_a') => ({
    id: 'm_voice', conversationId: 'ch_a', seq, authorKind: 'agent', authorId: 'ag_ava', kind: 'text', state, body, silent: false,
    meta: { via: 'voice', call: { id: call, participant: 'agent:ag_ava', name: 'Ava', voice: 'talker' } },
  }) as unknown as Message;
  t.emit('message.created', voiced(90, 'Der Build läuft noch', 'streaming'));
  assert.deepEqual(t.spoken, [], 'nothing is read while the first sentence is unfinished');
  t.emit('message.updated', voiced(90, 'Der Build läuft noch durch. Danach', 'streaming'));
  assert.deepEqual(t.spoken, ['Der Build läuft noch durch.'], 'the finished sentence goes at once');
  t.voice.spokenDone(view.id);
  t.emit('message.updated', voiced(90, 'Der Build läuft noch durch. Danach schicke ich die Zahlen.', 'final'));
  assert.deepEqual(t.spoken, ['Der Build läuft noch durch.', 'Danach schicke ich die Zahlen.'], 'only what was not read yet');

  const once = setup(['Und sonst?']);
  const second = await once.voice.start('ch_a');
  await once.voice.utterance(second.id, 'file_1');
  await tick();
  once.emit('message.created', voiced(90, 'Alles ruhig hier, nichts Neues.', 'final'));
  assert.deepEqual(once.spoken, ['Alles ruhig hier, nichts Neues.'], 'a row that was final at once is read whole');
});

// Owner 19.11.2026: what this device shows on the call (camera, screen, a cut-out) goes with the line; a picture that cannot be
// made stays behind and the line still goes.
test('a picture shown on the call goes with the spoken line; a failing one stays behind', async () => {
  let fail = false;
  const t = setup(['Was ist das hier?', 'Und das?'], { shown: async (conversationId) => {
    if (fail) throw new Error('no frame');
    return conversationId === 'ch_a' ? [{ fileId: 'f_screen', name: 'Screen.jpg', mime: 'image/jpeg', size: 10 }] : [];
  } });
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  assert.deepEqual(t.sent[0], { conversationId: 'ch_a', body: 'Was ist das hier?', live: true, call: 'call_ch_a', attachments: ['f_screen'] });
  fail = true;
  await t.voice.utterance(view.id, 'f2');
  await tick();
  assert.equal(t.sent[1]?.body, 'Und das?');
  assert.equal(t.sent[1]?.attachments, undefined);
});

// ------------------------------------------------------------------ owner 19.11.2026: several devices in one call

test('owner 19.11.2026: a device joined beside the holder reads nothing until it hears a line; then the device that heard the newest line reads', async () => {
  const t = setup(['Und wie sieht es aus?'], { joined: true });
  const view = await t.voice.start('ch_a');
  assert.deepEqual(t.starts, [{ conversationId: 'ch_a' }], 'it finds the call it joined');
  t.reply('ch_a', 'Antwort an das Handy.');
  assert.deepEqual(t.spoken, [], 'the holder heard the last line: it reads');
  await t.voice.utterance(view.id, 'f1');
  assert.deepEqual(t.sent.map((line) => [line.body, line.call]), [['Und wie sieht es aus?', 'call_ch_a']], 'its microphone feeds the call');
  t.reply('ch_a', 'Antwort an den PC.');
  assert.deepEqual(t.spoken, ['Antwort an den PC.']);
  t.voice.spokenDone(view.id);
  t.said('ch_a', 'call_ch_a', 'Am Handy gefragt');
  t.reply('ch_a', 'Antwort ans Handy.');
  assert.deepEqual(t.spoken, ['Antwort an den PC.'], 'quiet: the other device heard the newest line and reads');
  assert.equal(t.voice.sessions()[0].status, 'listening');
});

test('owner 19.11.2026: a line heard on another device stops this one\'s reading; a take that repeats what others just said goes nowhere, a new sentence makes it the reader again', async () => {
  const t = setup(['Erste Frage', 'Antwort ans Handy', 'Ganz neue Frage zum Logo']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  t.reply('ch_a', 'Eine lange Antwort.');
  assert.equal(t.mic()?.status, 'speaking');
  t.said('ch_a', 'call_ch_a', 'Am Handy gefragt');
  assert.equal(t.silenced(), 1, 'its reading stops at once');
  assert.equal(t.mic()?.status, 'listening');
  t.reply('ch_a', 'Antwort ans Handy.');
  assert.deepEqual(t.spoken, ['Eine lange Antwort.']);
  await t.voice.utterance(view.id, 'f2'); // its microphone hears the other device reading
  assert.equal(t.sent.length, 1, 'the echo goes nowhere');
  assert.equal(t.mic()?.hint, undefined, 'and asks nothing');
  t.said('ch_a', 'call_other', 'Eine andere Leitung'); // a line of another call changes nothing
  await t.voice.utterance(view.id, 'f3');
  assert.deepEqual(t.sent.map((line) => line.body), ['Erste Frage', 'Ganz neue Frage zum Logo']);
  t.reply('ch_a', 'Das Logo ist fertig.');
  assert.deepEqual(t.spoken, ['Eine lange Antwort.', 'Das Logo ist fertig.'], 'it heard the newest line: it reads again');
});

test('owner 21.11.2026: another person\'s line in the call leaves my reading – every person hears the replies', async () => {
  const t = setup(['Meine Frage']);
  const view = await t.voice.start('ch_a');
  await t.voice.utterance(view.id, 'f1');
  t.reply('ch_a', 'Eine lange Antwort.');
  t.said('ch_a', 'call_ch_a', 'Momo fragt auch', 'per_momo00001');
  assert.equal(t.silenced(), 0, 'my reading goes on');
  t.reply('ch_a', 'Antwort an Momo.');
  t.voice.spokenDone(view.id);
  assert.deepEqual(t.spoken, ['Eine lange Antwort.', 'Antwort an Momo.']);
});

test('owner 19.11.2026: a joined device ends quietly when the call ends, not when another device takes it over; the holder stays while devices join', async () => {
  const row = (call: Record<string, unknown>) => ({ id: 'm_row', conversationId: 'ch_a', seq: 1, authorKind: 'system', kind: 'status', state: 'final', body: '', meta: { call: { id: 'call_ch_a', name: 'x', startedAt: 1, lines: [], ...call } } }) as unknown as Message;
  const joined = setup([], { joined: true });
  await joined.voice.start('ch_a');
  joined.emit('message.updated', row({ participant: 'device:dev_laptop', joined: [{ participant: 'device:dev_phone', name: 'Pixel' }] }));
  assert.equal(joined.voice.active, true, 'another device took the call over: this one is still in');
  joined.emit('message.updated', row({ participant: 'device:dev_laptop', endedAt: 2 }));
  assert.equal(joined.voice.active, false, 'the call is over');
  assert.deepEqual(joined.ended, [], 'nothing left to end');
  const holder = setup();
  await holder.voice.start('ch_a');
  holder.emit('message.updated', row({ participant: 'device:pc', joined: [{ participant: 'device:dev_phone', name: 'Pixel' }] }));
  assert.equal(holder.voice.active, true);
});

test('owner 19.11.2026 echoOf: a take is an echo when most of its word pairs were just said by others; a new sentence with common words is not', () => {
  assert.equal(echoOf('Das Budget reicht bis März', ['Das Budget reicht bis März, sagt Ben.']), true);
  assert.equal(echoOf('das budget reicht bis', ['Das Budget reicht bis März.']), true, 'a piece of it, as the microphone caught it');
  assert.equal(echoOf('Und was ist mit dem Logo für die Website?', ['Das Budget reicht bis März und die Website ist fertig.']), false);
  assert.equal(echoOf('Ja', ['Ja, genau.']), true, 'one or two words: by word');
  assert.equal(echoOf('Nein', ['Ja, genau.']), false);
  assert.equal(echoOf('', ['Ja']), false);
  assert.equal(echoOf('Das Budget reicht', []), false);
});

test('owner 19.11.2026 (review): a line whose chat ended while its picture was taken does not go out – it would bring the device back into the call', async () => {
  let release: () => void = () => undefined;
  const t = setup(['Noch ein Satz'], { shown: () => new Promise((resolve) => { release = () => resolve([]); }) });
  const view = await t.voice.start('ch_a');
  const said = t.voice.utterance(view.id, 'f1');
  await tick();
  t.voice.stop('ch_a');
  release();
  await said;
  await tick();
  assert.deepEqual(t.sent, []);
  assert.deepEqual(t.ended, ['call_ch_a']);
});
