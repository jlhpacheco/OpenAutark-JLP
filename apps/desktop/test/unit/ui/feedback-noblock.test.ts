// Owner 24.11.2026 ("kein PC hat Vorrang, jeder PC ist gleich"; after a lost connection to the runtime the dock said "Not
// sent", could not be closed and "Send again" never connected): the feedback dock closes in every state, the desktop window
// sends itself straight to the mailbox like a phone and waits for no runtime, "Send again" shows only while a new try can go,
// and a report that waits in the window goes out by itself later (src/ui/feedback: FeedbackPanel.tsx, outbox.ts, delivery.ts, direct.ts).
// Owns: these assertions. Never: a real mailbox, runtime or window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RpcError } from '../../../src/ui/lib/rpc.ts';
import { canSendAgain, heldText, sendAgainFailedLine } from '../../../src/ui/feedback/delivery.ts';
import { DirectFailed, letterOf, sealWeb } from '../../../src/ui/feedback/direct.ts';
import { generateReceiverKeys, openReport } from '../../../src/runtime/feedback/seal.ts';
import { CONTEXT_WAIT_MS, FeedbackOutbox, runtimeContext } from '../../../src/ui/feedback/outbox.ts';
import type { OutboxEntry, Outcome } from '../../../src/ui/feedback/outbox.ts';
import type { KeyValue } from '../../../src/ui/lib/take-store.ts';

const read = (file: string) => readFileSync(new URL(`../../../src/ui/feedback/${file}`, import.meta.url), 'utf8');

function entry(change: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    clientId: 'fc-lq3k9-0123456789abcdef01234567', at: 1_000_000, send: true, text: 'The sidebar flickers', where: { view: '#/chat/ch_1' },
    client: 'Autark 0.3.20 · Windows 11 · 1440×900 · en', ...change,
  };
}

function memoryKv(): KeyValue & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map, get: async (key) => map.get(key), set: async (key, value) => { map.set(key, value); }, remove: async (key) => { map.delete(key); },
    values: async (prefix) => [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
  };
}

test('the dock\'s close arrow stands in every state – also after Send (held, not sent) – and closes without losing the report', () => {
  const panel = read('FeedbackPanel.tsx');
  const doneDock = panel.slice(panel.indexOf('if (held || done) {'), panel.indexOf('const listening ='));
  assert.ok(doneDock.length > 100, 'the result dock was found');
  const arrow = doneDock.indexOf('class="icon-button feedback-close"');
  assert.ok(arrow >= 0, 'the result dock has the same arrow as the draft');
  assert.match(doneDock.slice(arrow, arrow + 250), /onClick=\{props\.onClose\}/);
  assert.ok(arrow < doneDock.indexOf('feedback-done'), 'before the line, where the draft has it');
  assert.doesNotMatch(doneDock.slice(arrow, arrow + 250), /disabled/, 'never disabled by a send on its way');
  const draftDock = panel.slice(panel.indexOf('const listening ='));
  const draftArrow = draftDock.indexOf('class="icon-button feedback-close"');
  assert.ok(draftArrow >= 0);
  assert.doesNotMatch(draftDock.slice(draftArrow, draftArrow + 250), /disabled/, 'nor while sending');
  assert.match(panel, /Owner 24\.11\.2026 \("kein PC hat Vorrang/, 'the file header says so');
});

test('"Send again" shows only while a new try can go: online, and no "Send again" of this result failed', () => {
  assert.equal(canSendAgain('local', true), true);
  assert.equal(canSendAgain('local', true, true), false, 'a failed one takes it away');
  assert.equal(canSendAgain('local', true, false, false), false, 'offline: nothing to try');
  assert.equal(canSendAgain('local', true, false, true), true, 'back online: it is there again');
  assert.equal(canSendAgain('sent', true), false);
  assert.equal(canSendAgain('local', undefined), false);
  const panel = read('FeedbackPanel.tsx');
  assert.match(panel, /canSendAgain\(report\.status, sending, againFailed, online\)/);
  assert.match(panel, /catch \(err\) \{\s*setAgainFailed\(true\);\s*setError\(sendAgainFailedLine\(err\)\);/, 'a failure hides the button and says why');
});

test('a failed "Send again" says the report goes by itself; a held report says where it waits', () => {
  for (const reason of ['offline', 'timeout', 'server']) {
    assert.equal(sendAgainFailedLine(new RpcError({ code: 'unavailable', message: 'x', details: { reason } })), 'Still not sent – it goes by itself when the connection is back.');
  }
  assert.equal(sendAgainFailedLine(new RpcError({ code: 'unavailable', message: 'The mailbox refused the report.', details: { reason: 'refused' } })), 'The mailbox refused the report.');
  assert.equal(heldText('window'), 'Saved in this window – it goes by itself as soon as there is a connection.');
});

test('the desktop window sends itself like a phone: no bridge condition on direct, the online listener, the first flush', () => {
  const outbox = read('outbox.ts');
  assert.doesNotMatch(outbox, /bridge \? \{\}/, 'direct is not left to the runtime in the window');
  assert.match(outbox, /direct: async \(entry: OutboxEntry\) =>/);
  assert.doesNotMatch(outbox, /!bridge\) window\.addEventListener/);
  assert.match(outbox, /window\.addEventListener\('online'/);
  assert.match(outbox, /setInterval\(\(\) => \{ void flushFeedback\(\); \}, FLUSH_EVERY_MS\)/);
  assert.doesNotMatch(outbox, /if \(online\(\) \|\| !bridge\) void flushFeedback\(\)/, 'the window flushes at start whether or not the runtime answers');
  const delivery = read('delivery.ts');
  assert.match(delivery, /const sendsItself = builtInReceiver\(\) !== null;/, 'Send, not Save, without asking the runtime');
});

test('a report that waits while the runtime is away and the internet is gone goes out by itself, quietly, once a try works – no runtime call', async () => {
  const kv = memoryKv();
  let internet = false;
  const runtime: string[] = [];
  const arrived: string[] = [];
  const outbox = new FeedbackOutbox({
    kv, now: () => 1_000_500, online: () => false, // the link to the company's runtime is dead throughout
    upload: async () => { runtime.push('upload'); return 'f'; },
    create: async () => { runtime.push('create'); throw new Error('no runtime'); },
    send: async () => { runtime.push('send'); throw new Error('no runtime'); },
    direct: async (e) => {
      if (!internet) throw new DirectFailed('Feedback could not be sent right now; it goes by itself later.', false);
      arrived.push(e.clientId);
      return { id: e.clientId, status: 'sent', receiptId: e.clientId };
    },
  });
  const report = entry();
  await outbox.put(report);
  assert.equal((await outbox.deliver(report)).kind, 'held');
  assert.equal(kv.map.size, 1, 'kept in the window');
  const outcomes: Outcome[] = [];
  const kinds = () => outcomes.map((outcome) => outcome.kind);
  await outbox.flush((outcome) => outcomes.push(outcome));
  assert.deepEqual(kinds(), [], 'still away: nothing said, nothing lost');
  internet = true;
  await outbox.flush((outcome) => outcomes.push(outcome)); // the interval / the online event
  assert.deepEqual(kinds(), ['sent']);
  assert.deepEqual(arrived, [report.clientId]);
  assert.deepEqual(runtime, [], 'the runtime was never asked');
  assert.equal(kv.map.size, 0);
});

test('a direct send whose answer got lost and a later runtime try file the same report under the same clientId', async () => {
  const creates: string[] = [];
  let tries = 0;
  const outbox = new FeedbackOutbox({
    kv: null, now: () => 1_000_500, online: () => true,
    upload: async () => 'f',
    create: async (params) => { creates.push(params.clientId ?? ''); return { id: 'fb_1', status: 'local', text: params.text } as never; },
    send: async () => ({ id: 'fb_1', status: 'sent', receiptId: 'fc-lq3k9-0123456789abcdef01234567' }) as never,
    direct: async () => { tries += 1; throw new DirectFailed('Feedback could not be sent right now; it goes by itself later.', false); },
  });
  const report = entry();
  assert.equal((await outbox.deliver(report)).kind, 'sent');
  assert.equal(tries, 1);
  assert.deepEqual(creates, [report.clientId], 'the runtime files it under the id the mailbox letter has (409 there = it arrived)');
});

test('the runtime\'s part goes along only when it is quick; late, failing or missing it never holds the report', async () => {
  const quick = await runtimeContext('words', async (text) => ({ text: `${text}!`, diagnostics: 'warn x', company: 'company-2' }));
  assert.deepEqual(quick, { text: 'words!', diagnostics: 'warn x', company: 'company-2' });
  assert.equal(await runtimeContext('words', async () => { throw new Error('link lost'); }), undefined);
  const started = Date.now();
  const late = await runtimeContext('words', () => new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 400)), 30);
  assert.equal(late, undefined);
  assert.ok(Date.now() - started < 300, 'it did not wait for the slow runtime');
  assert.ok(CONTEXT_WAIT_MS <= 2000, 'a moment, not a wait');
});

test('the window\'s letter carries the runtime\'s part, redacted again; without it the page\'s own redaction stands alone', async () => {
  const keys = generateReceiverKeys();
  const open = async (context?: Parameters<typeof letterOf>[2]) => JSON.parse(openReport(keys.privateKey, await sealWeb(keys.publicKey, await letterOf(entry({ text: 'My key is password: hunter2' }), '0.3.20', context))).toString('utf8'));
  const withContext = await open({ text: 'Words as the runtime blacked them out', diagnostics: '2026-11-24 error engine failed: password = hunter2', company: 'company-2' });
  assert.equal(withContext.text, 'Words as the runtime blacked them out', 'the runtime\'s version of the words');
  assert.match(withContext.diagnostics, /engine failed/);
  assert.doesNotMatch(withContext.diagnostics, /hunter2/, 'redacted here again');
  assert.equal(withContext.company, 'company-2');
  const without = await open();
  assert.doesNotMatch(without.text, /hunter2/, 'page redaction alone still blacks out a password');
  assert.equal(without.diagnostics, undefined);
  assert.equal(without.company, undefined);
});
