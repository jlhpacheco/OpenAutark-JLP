// The message list's rows (src/ui/chat/message-rows.ts): consecutive status lines and agents' quiet lines form one burst,
// and a jump (C4) to a line of a collapsed burst lands on its newest line the person sees –
// agents' edit and delete notices (C6) are hidden in the burst, so they are never the target. A call is one
// bubble at its row: the rows its lines name fold into it and show there in full (callEntries), every other row – a later
// answer too – stays a row. A task thread's kept line (a person's whole line, details.quote) is a row of its own.
// Owns: these assertions only. Never: renders (MessageList.tsx looks the line up in the DOM).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Message } from '../../../src/shared/model/chat.ts';
import { callLength, type CallRecord } from '../../../src/shared/model/call.ts';
import { KEPT_LINES, burstLineFor, burstView, callEntries, groupRows, isQuietLine, keptFolds, quietLineText, quoteOf, rowHas } from '../../../src/ui/chat/message-rows.ts';

const text = (seq: number): Message => ({
  id: `msg_${seq}`, conversationId: 'cv_rows', seq, authorId: 'human', authorKind: 'human', kind: 'text', body: `#${seq}`, attachments: [], mentions: [],
  priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: seq,
}) as Message;
const status = (seq: number, details: Record<string, unknown> = {}): Message => ({
  ...text(seq), authorId: 'system', authorKind: 'system', kind: 'status', silent: true, body: `line ${seq}`,
  meta: { status: { type: 'note', text: `line ${seq}`, details } },
}) as Message;
/** An agents-only notice as chat/message-edits.ts writes it. */
const notice = (seq: number, edited: number): Message => status(seq, { edited: `msg_${edited}`, seq: edited });

test('consecutive status lines form one burst between messages', () => {
  const rows = groupRows([text(1), status(2), status(3), text(4), status(5)]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.messages.map((message) => message.id).join('+'))),
    ['msg_1', 'msg_2+msg_3', 'msg_4', 'msg_5']);
  assert.equal(rowHas(rows[1], 'msg_3'), true);
  assert.equal(rowHas(rows[0], 'msg_3'), false);
});

test('a jump into a burst whose newest line is an edit notice lands on the newest line the person sees', () => {
  const rows = groupRows([text(1), status(2), status(3), notice(4, 1), text(5)]);
  assert.equal(burstLineFor(rows, 'msg_2'), 'msg_3', 'the hidden notice is skipped');
  assert.equal(burstLineFor(rows, 'msg_4'), 'msg_3', 'a link to the notice itself lands on the burst too');
  assert.equal(burstLineFor(rows, 'msg_1'), undefined, 'a message outside any burst has its own element');
  assert.equal(burstLineFor(rows, 'msg_9'), undefined, 'not in the rows');
});

test('a burst of notices only shows nothing to land on', () => {
  const rows = groupRows([text(1), notice(2, 1), notice(3, 1)]);
  assert.equal(burstLineFor(rows, 'msg_2'), undefined);
});

/** A call's row (runtime/calls/call-log.ts) whose lines name these messages. */
const callRow = (seq: number, id: string, lines: number[], endedAt?: number): Message => {
  const call: CallRecord = { id, participant: 'device:pc', name: 'laptop', startedAt: seq, ...(endedAt ? { endedAt } : {}), lines: lines.map((line) => ({ at: line, from: 'device:pc', name: 'Gerd', text: `#${line}`, messageId: `msg_${line}` })) };
  return { ...status(seq), meta: { status: { type: 'note', text: 'Call from laptop' }, call } } as Message;
};
const said = (seq: number, id: string): Message => ({ ...text(seq), meta: { call: { id, participant: 'device:pc', name: 'laptop' } } });

test('a call is one bubble at its row: the rows its lines name fold into it, wherever they stand', () => {
  const late = agentMsg(7, { meta: { call: { id: 'call_a', participant: 'agent:ag_tom', name: 'Tom' } } }); // after the call ended: not in its lines
  const rows = groupRows([said(1, 'call_a'), callRow(2, 'call_a', [1, 3, 5], 6), text(3), status(4), agentMsg(5), status(6), late]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.kind)), ['call', 'status', 'msg_7'], 'the status lines around a folded line are one burst');
  assert.deepEqual(rows[0].kind === 'call' && [rows[0].callId, rows[0].messages.map((message) => message.id)], ['call_a', ['msg_2', 'msg_1', 'msg_3', 'msg_5']], 'the row first, then its lines – one synced before the row too');
  assert.equal(burstLineFor(rows, 'msg_5'), 'msg_2', 'a jump to a line lands on the bubble');
  assert.equal(rowHas(rows[0], 'msg_3'), true);
});

test('the bubble shows a folded row as itself – in full, with its files – and a line whose row is not loaded by its kept words', () => {
  const long = 'x'.repeat(3000);
  const answer = agentMsg(5, { body: long, attachments: [{ fileId: 'f_cut', name: 'cut.mp4', mime: 'video/mp4', size: 9 }] });
  const row = callRow(2, 'call_a', [1, 5], 6); // line 1's row is not loaded on this device
  const [bubble] = groupRows([row, answer]);
  assert.equal(bubble.kind, 'call');
  const entries = callEntries(bubble.kind === 'call' ? bubble.messages : []);
  assert.deepEqual(entries.map((entry) => [entry.line.messageId, entry.message?.id]), [['msg_1', undefined], ['msg_5', 'msg_5']], 'in the lines\' order');
  assert.equal(entries[0].line.text, '#1', 'the words the call row keeps');
  assert.equal(entries[1].message?.body.length, 3000, 'the whole answer, not the capped line');
  assert.equal(entries[1].message?.attachments[0].name, 'cut.mp4');
  assert.deepEqual(callEntries([text(9)]), [], 'no call row: nothing');
  const view = readFileSync(new URL('../../../src/ui/chat/call/CallTranscript.tsx', import.meta.url), 'utf8'); // a .tsx file does not load here
  assert.match(view, /callEntries\(props\.messages\)/);
  assert.match(view, /message\s*\?\s*<MessageItem key=\{message\.id\} message=\{message\}/, 'a loaded row renders as its message');
});

test('lines of a call whose row is not loaded, or that its lines do not name, stay rows', () => {
  const rows = groupRows([said(1, 'call_a'), said(2, 'call_a'), callRow(3, 'call_b', []), said(4, 'call_b')]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.kind)), ['msg_1', 'msg_2', 'call', 'msg_4']);
  assert.deepEqual(rows[2].kind === 'call' && rows[2].messages.map((message) => message.id), ['msg_3']);
});

test('how long a call ran', () => {
  assert.equal(callLength(282_000), '4:42');
  assert.equal(callLength(59_400), '0:59');
  assert.equal(callLength(3_725_000), '1:02:05');
  assert.equal(callLength(-5), '0:00');
});

// D5: live work leaves the seq rows (the live block at the bottom shows it), every live run of the
// chat is listed by start, and one message per finished run carries its "Worked … · N steps" line.
// Root cause fixed: the live block sat at the turn's start seq, above approvals and cards it caused.
const agentMsg = (seq: number, patch: Partial<Message> = {}): Message => ({ ...text(seq), authorId: 'ag_tom', authorKind: 'agent', ...patch }) as Message;

test('13.11.2026: only messages – a row an older version left streaming is a plain row like any answer', () => {
  const old = agentMsg(2, { state: 'streaming', runId: 'run_1', body: 'Half' });
  const rows = groupRows([text(1), old, status(3), agentMsg(4, { runId: 'run_0' })]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.kind)), ['msg_1', 'msg_2', 'status', 'msg_4']);
});

test('an agent\'s quiet line joins the status burst as a compact row; loud lines, the person\'s and a call\'s stay rows of their own', () => {
  const quiet = agentMsg(2, { silent: true, body: 'Ich habe die Aufgabe an Lena gegeben. Sie meldet sich mit dem Ergebnis.' });
  const said = agentMsg(5, { silent: true, meta: { call: { id: 'call_b', participant: 'agent:ag_tom', name: 'Tom' } } });
  const rows = groupRows([text(1), quiet, status(3), agentMsg(4), said, { ...text(6), silent: true }]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.messages.map((message) => message.id).join('+'))),
    ['msg_1', 'msg_2+msg_3', 'msg_4', 'msg_5', 'msg_6']);
  assert.equal(isQuietLine(quiet), true);
  assert.equal(isQuietLine(agentMsg(7)), false, 'a normal agent line is a bubble');
  assert.equal(burstLineFor(rows, 'msg_2'), 'msg_3', 'a jump to the quiet line lands on its burst');
  assert.equal(quietLineText(quiet, 'Tom'), 'Tom: Ich habe die Aufgabe an Lena gegeben');
});

test('a quiet line that carries files is a result: it stays a bubble, never a row in the burst', () => {
  const image = agentMsg(2, { silent: true, body: '', attachments: [{} as Message['attachments'][number]] });
  assert.equal(isQuietLine(image), false);
  const rows = groupRows([status(1), image, status(3)]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.messages.map((message) => message.id).join('+'))), ['msg_1', 'msg_2', 'msg_3']);
});

test('one burst has one shape for one line and for many: nothing above an opened line appears or moves when the next arrives', () => {
  const quiet = agentMsg(2, { silent: true, body: 'Ich lese die Logs.' });
  const shape = (items: ReturnType<typeof burstView>) => items.map((item) => (item.kind === 'line' ? item.id : `${item.kind} ${item.count}`));
  const none = new Set<string>();
  // One line: its row, nothing above or below it.
  assert.deepEqual(shape(burstView([quiet], false, none)), ['msg_2']);
  // Two lines: the earlier one folds into a row in its place, the newest stands under it; open, a hide row comes last.
  assert.deepEqual(shape(burstView([quiet, status(3)], false, none)), ['earlier 1', 'msg_3']);
  assert.deepEqual(shape(burstView([quiet, status(3)], true, none)), ['msg_2', 'msg_3', 'hide 1']);
  // A line opened before the second arrives: the same rows above it as before (none), the new line only below it.
  const opened = new Set([quiet.id]);
  assert.deepEqual(shape(burstView([quiet], false, opened)), ['msg_2']);
  assert.deepEqual(shape(burstView([quiet, status(3)], false, opened)), ['msg_2', 'msg_3']);
  assert.deepEqual(shape(burstView([quiet, status(3), status(4)], false, opened)), ['msg_2', 'msg_3', 'msg_4']);
  // The newest of three opened: the row above it stays the one fold row, the next line comes below.
  const newest = new Set(['msg_4']);
  assert.deepEqual(shape(burstView([quiet, status(3), status(4)], false, none)), ['earlier 2', 'msg_4']);
  assert.deepEqual(shape(burstView([quiet, status(3), status(4)], false, newest)), ['earlier 2', 'msg_4']);
  assert.deepEqual(shape(burstView([quiet, status(3), status(4), status(5)], false, newest)), ['earlier 2', 'msg_4', 'msg_5']);
});

test('a person\'s line kept in a task\'s thread (details.quote): its own row, never in a burst; folded past a few lines', () => {
  const whole = 'Please sign the build.\nThen send the link to Anna.\nAnd tell me when it is out.';
  const kept = { ...status(2, { taskId: 'task_1', quote: { conversationId: 'ch_9', messageId: 'msg_77', seq: 77, authorId: 'human', at: 5 } }), body: whole,
    meta: { status: { type: 'note' as const, text: whole, details: { taskId: 'task_1', quote: { conversationId: 'ch_9', messageId: 'msg_77', seq: 77, authorId: 'human', at: 5 } } } } } as Message;
  assert.deepEqual(quoteOf(kept), { text: whole, authorId: 'human', at: 5, conversationId: 'ch_9', messageId: 'msg_77' });
  assert.equal(quoteOf(status(3)), undefined, 'a plain status line');
  assert.equal(quoteOf(text(4)), undefined);
  const rows = groupRows([status(1), kept, status(3)]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.messages.map((message) => message.id).join('+'))), ['msg_1', 'msg_2', 'msg_3']);
  assert.equal(keptFolds(whole), false, `${KEPT_LINES} lines or fewer show whole`);
  assert.equal(keptFolds(Array.from({ length: KEPT_LINES + 1 }, (_, n) => `line ${n}`).join('\n')), true);
  assert.equal(keptFolds('x'.repeat(400)), true, 'one long line folds too');
});
