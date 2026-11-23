// Owner 18.11.2026 ("das soll doch einfach direkt zu uns gehen"): a phone seals its feedback itself and creates the
// letter in the team's mailbox (src/ui/feedback/direct.ts) – the team's inbox opens it like a PC's letter
// (runtime/feedback/seal.ts openReport, letter.ts itemOf); the outbox (outbox.ts) tries that first and needs no PC.
// Owns: these assertions. Never: a real mailbox or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReceiverKeys, openReport } from '../../../src/runtime/feedback/seal.ts';
import { itemOf } from '../../../src/runtime/feedback/letter.ts';
import { DirectFailed, letterOf, sealWeb, sendDirect, type Receiver } from '../../../src/ui/feedback/direct.ts';
import { FeedbackOutbox, type OutboxEntry } from '../../../src/ui/feedback/outbox.ts';

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')}`;
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4]).toString('base64')}`;

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    clientId: 'fc-abc-0123456789ab', at: 1_700_000_000_000, send: true, text: 'The list jumps. My key is password: hunter2',
    where: { view: 'tasks' } as OutboxEntry['where'], client: 'Android app 0.3.15 · Android 16 · samsung SM-S918B · 412×915 @3x · de',
    images: [JPEG, PNG], dictated: true, clientDiagnostics: 'crash at mail me@example.com',
    ...over,
  };
}

test('a phone\'s sealed letter opens with the team key and reads like a PC\'s, redacted', async () => {
  const keys = generateReceiverKeys();
  const sealed = await sealWeb(keys.publicKey, await letterOf(entry(), '0.3.15'));
  const opened = itemOf('fc-abc-0123456789ab', JSON.parse(openReport(keys.privateKey, sealed).toString('utf8')), 1);
  assert.ok(opened);
  assert.match(opened.item.text, /The list jumps/);
  assert.doesNotMatch(opened.item.text, /hunter2/, 'a password in the text is redacted on the phone');
  assert.doesNotMatch(opened.item.clientDiagnostics ?? '', /me@example\.com/);
  assert.equal(opened.item.appVersion, '0.3.15');
  assert.equal(opened.item.os, 'Android app 0.3.15 · Android 16');
  assert.equal(opened.item.view, 'tasks');
  assert.deepEqual(opened.item.images?.map((image) => image.mime), ['image/jpeg', 'image/png'], 'every image, in order (owner 21.11.2026)');
  const older = itemOf('x', JSON.parse(new TextDecoder().decode(await letterOf(entry({ images: undefined, image: JPEG }), '0.3.15'))), 1);
  assert.deepEqual(older?.item.images?.map((image) => image.mime), ['image/jpeg'], 'an entry an older build kept: its one image');
  assert.equal(opened.item.dictated, true, 'a dictated report goes as its words');
  assert.equal(JSON.parse(openReport(keys.privateKey, sealed).toString('utf8')).audio, undefined, 'never a recording (owner 20.11.2026)');
});

test('sendDirect creates feedback/<clientId> once; 409 counts as arrived; no connection is DirectFailed', async () => {
  const keys = generateReceiverKeys();
  const receiver: Receiver = { publicKey: keys.publicKey, project: 'autark-feedback-7', apiKey: 'AIza-test' };
  const urls: string[] = [];
  let status = 200;
  const run = (async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(init.credentials, 'omit');
    const body = JSON.parse(String(init.body));
    assert.equal(body.fields.v.integerValue, '1');
    assert.ok(openReport(keys.privateKey, Buffer.from(body.fields.sealed.bytesValue, 'base64')).length > 0);
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  const sent = await sendDirect(entry(), receiver, run);
  assert.deepEqual(sent, { id: 'fc-abc-0123456789ab', status: 'sent', receiptId: 'fc-abc-0123456789ab' });
  assert.match(urls[0]!, /^https:\/\/firestore\.googleapis\.com\/v1\/projects\/autark-feedback-7\/databases\/\(default\)\/documents\/feedback\?documentId=fc-abc-0123456789ab&/);
  status = 409;
  assert.ok(await sendDirect(entry(), receiver, run));
  const offline = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
  await assert.rejects(sendDirect(entry(), receiver, offline), (error: unknown) => error instanceof DirectFailed && !error.refused);
  assert.equal(await sendDirect(entry(), null, run), null, 'no receiver built in: the PC sends');
});

function outbox(direct: (e: OutboxEntry) => Promise<unknown>, pcOnline: boolean) {
  const calls: string[] = [];
  const box = new FeedbackOutbox({
    kv: null, now: () => 1_700_000_000_000, online: () => pcOnline,
    upload: async () => 'file_1',
    create: async (params) => { calls.push('create'); return { id: 'fb_1', status: 'local', text: params.text } as never; },
    send: async () => { calls.push('send'); return { id: 'fb_1', status: 'sent', receiptId: 'r1' } as never; },
    direct: direct as never,
  });
  return { box, calls };
}

test('the outbox sends straight to the team first – without the PC; it falls back to the PC or waits', async () => {
  const straight = outbox(async (e) => ({ id: e.clientId, status: 'sent', receiptId: e.clientId }), false);
  await straight.box.put(entry());
  const done = await straight.box.deliver(entry());
  assert.equal(done.kind, 'sent');
  assert.deepEqual(straight.calls, [], 'the PC was not needed');
  assert.deepEqual(await straight.box.pending(), []);

  const cannot = outbox(async () => null, true);
  assert.equal((await cannot.box.deliver(entry())).kind, 'sent');
  assert.deepEqual(cannot.calls, ['create', 'send'], 'a page that cannot seal sends through the PC');

  const away = outbox(async () => { throw new DirectFailed('no connection', false); }, false);
  await away.box.put(entry());
  assert.equal((await away.box.deliver(entry())).kind, 'held', 'no way out: it waits on the phone');
  assert.equal((await away.box.pending()).length, 1);

  const saveOnly = outbox(async () => { throw new Error('never called'); }, true);
  assert.equal((await saveOnly.box.deliver(entry({ send: false }))).kind, 'saved', 'Save (no Send) stays the PC\'s');
});
