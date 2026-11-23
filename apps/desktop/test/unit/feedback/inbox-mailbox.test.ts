// Feedback 16.11.2026 (F22–F24: three morning reports were in no inbox of this PC – the first fetcher took them): every
// team PC and company sees every letter, a letter older than LETTER_TTL_MS goes at any fetch whatever its id, a
// removed report's tombstone keeps a letter whose mailbox delete failed from coming back (swept after TTL + 1 day),
// a letter's recordings are not kept (owner 20.11.2026: a report is its words), and a letter's new facts (client, company, device diagnostics, dictated) are checked like the rest.
// Owns: these assertions. Never: contacts Google (fake mailbox).

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FeedbackService } from '../../../src/runtime/feedback/service.ts';
import { GONE, RECEIVER_KEY_ID, SERVICE_ACCOUNT_ID, SETUP_KEY, TOMBSTONE_KEEP_MS } from '../../../src/runtime/feedback/inbox.ts';
import { itemOf } from '../../../src/runtime/feedback/letter.ts';
import { LETTER_TTL_MS } from '../../../src/runtime/feedback/drop.ts';
import { generateReceiverKeys, sealReport } from '../../../src/runtime/feedback/seal.ts';
import { register as registerInbox } from '../../../src/runtime/rpc/handlers/feedback-inbox.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { INBOX_DIR } from '../../../src/shared/model/feedback-delivery.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { API_KEY, PROJECT, fakeMailbox, feedbackEnv, serviceAccount, type Env } from './fakes.ts';

const envs: Env[] = [];
after(() => { for (const env of envs) env.cleanup(); });
const DAY = 24 * 60 * 60 * 1000;
const id = (n: number) => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 2, 3]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(8, 1)]);

/** One mailbox, the team key and as many receivers (PCs or companies) as asked, each with its own data folder. */
async function teamOf(receivers = 1) {
  const keys = generateReceiverKeys();
  const account = serviceAccount();
  const box = fakeMailbox({ accountKey: account.publicKey });
  const pcs = [];
  for (let n = 0; n < receivers; n++) {
    const env = feedbackEnv();
    envs.push(env);
    await env.vault.save({ id: RECEIVER_KEY_ID, label: 'Feedback team key', kind: 'token', value: keys.privateKey });
    await env.vault.save({ id: SERVICE_ACCOUNT_ID, label: 'Feedback mailbox service account', kind: 'token', value: account.text });
    new KvRepo(env.s.db).set(SETUP_KEY.ns, SETUP_KEY.key, { project: PROJECT, publicKey: keys.publicKey, apiKey: API_KEY }, 1);
    pcs.push({ env, feedback: new FeedbackService({ services: () => env.s, receiver: null, fetch: box.fetch }), dir: path.join(env.data, INBOX_DIR) });
  }
  const letter = (docId: string, payload: Record<string, unknown>, key = keys.publicKey) => box.docs.set(docId, sealReport(key, Buffer.from(JSON.stringify({ v: 1, id: docId, createdAt: 1, appVersion: '0.3.9', os: 'win32', ...payload }))));
  return { box, letter, pcs };
}

const settle = async (box: ReturnType<typeof fakeMailbox>, gone: string) => {
  for (let wait = 0; wait < 50 && box.docs.has(gone); wait++) await new Promise((resolve) => setTimeout(resolve, 10));
};

test('two receivers on one mailbox both get every letter – whoever fetches first takes nothing away', async () => {
  const { box, letter, pcs: [pc, company] } = await teamOf(2);
  letter(id(1), { text: 'Morning report one' });
  letter(id(2), { text: 'Morning report two' });
  assert.equal((await pc.feedback.inbox.fetch()).added, 2);
  letter(id(3), { text: 'Later report' });
  assert.deepEqual(await company.feedback.inbox.fetch(), { added: 3, unreadable: 0, more: false, total: 3 });
  assert.equal((await pc.feedback.inbox.fetch()).added, 1);
  for (const one of [pc, company]) assert.deepEqual(one.feedback.inbox.list().map((item) => item.text).sort(), ['Later report', 'Morning report one', 'Morning report two']);
  assert.equal(box.docs.size, 3);
  assert.equal(box.log.some((line) => line.startsWith('delete')), false, 'no fetch deletes a readable young letter');
});

test('age deletion: a letter older than LETTER_TTL_MS goes at any fetch – also a foreign id and an unopenable one; young ones stay', async () => {
  const { box, letter, pcs: [pc] } = await teamOf();
  const now = pc.env.clock.now();
  letter(id(4), { text: 'Fetched while young' });
  await pc.feedback.inbox.fetch();
  letter(id(1), { text: 'Old, never on this PC' });
  letter(id(2), { text: 'Sealed for another key' }, generateReceiverKeys().publicKey);
  box.docs.set('junk with spaces', Buffer.from('x'));
  letter(id(3), { text: 'Young' });
  box.docs.set('young junk', Buffer.from('x'));
  for (const old of [id(1), id(2), id(4), 'junk with spaces']) box.created.set(old, now - LETTER_TTL_MS - 1);
  box.created.set(id(3), now - LETTER_TTL_MS + DAY);
  const reads = box.log.filter((line) => line === `get ${id(4)}`).length;
  const result = await pc.feedback.inbox.fetch();
  assert.deepEqual(result, { added: 2, unreadable: 2, more: false, total: 3 }, 'the old unseen readable one and the young one are stored; the unopenable one and the young foreign id are counted');
  assert.deepEqual([...box.docs.keys()].sort(), [id(3), 'young junk'].sort());
  assert.ok(box.log.includes('delete junk with spaces'), 'a foreign id is deleted by its encoded name');
  assert.deepEqual(pc.feedback.inbox.list().map((item) => item.text).sort(), ['Fetched while young', 'Old, never on this PC', 'Young'], 'a PC away for a month still gets the old letter before it goes');
  assert.equal(box.log.filter((line) => line === `get ${id(4)}`).length, reads, 'an old letter this PC has is deleted without opening it again');
});

test('a removed report whose mailbox delete failed does not come back; its tombstone goes after TTL + 1 day', async () => {
  const { box, letter, pcs: [pc] } = await teamOf();
  letter(id(1), { text: 'Remove me' });
  await pc.feedback.inbox.fetch();
  box.state.onDelete = () => { throw new TypeError('offline'); }; // the delete never reaches Google
  pc.feedback.inbox.remove(id(1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(box.docs.has(id(1)), 'the letter is still in the mailbox');
  assert.ok(existsSync(path.join(pc.dir, `${id(1)}${GONE}`)));
  assert.equal((await pc.feedback.inbox.fetch()).added, 0, 'the tombstone keeps it out');
  assert.deepEqual(pc.feedback.inbox.list(), []);
  const stone = path.join(pc.dir, `${id(1)}${GONE}`);
  const at = new Date(pc.env.clock.now() - TOMBSTONE_KEEP_MS + 1000);
  utimesSync(stone, at, at);
  pc.feedback.inbox.list();
  assert.ok(existsSync(stone), 'not before its time');
  pc.env.clock.advance(1000);
  pc.feedback.inbox.list();
  assert.equal(existsSync(stone), false, 'swept once the age deletion took the letter for sure');
  assert.equal(TOMBSTONE_KEEP_MS, LETTER_TTL_MS + DAY);
  box.state.onDelete = () => {};
  pc.feedback.inbox.remove(id(1));
  await settle(box, id(1));
  assert.equal(box.docs.has(id(1)), false, 'online, the removal deletes the letter');
});

test('a purged marked report leaves a tombstone too', async () => {
  const { letter, pcs: [pc] } = await teamOf();
  letter(id(1), { text: 'Done soon' });
  await pc.feedback.inbox.fetch();
  pc.feedback.inbox.mark(id(1), 'done');
  pc.env.clock.advance(8 * DAY);
  assert.deepEqual(pc.feedback.inbox.list(), []);
  assert.ok(existsSync(path.join(pc.dir, `${id(1)}${GONE}`)));
});

test('owner 20.11.2026: a report is its words – an older letter\'s recordings are not stored, an older inbox\'s go with their report', async () => {
  const { box, letter, pcs: [pc] } = await teamOf();
  letter(id(1), {
    text: 'Spoken report', dictated: true, client: 'Android app 0.3.15 ·\nAndroid 16 · SM-S918B', company: 'company-2', clientDiagnostics: 'java.lang.IllegalStateException',
    audio: [{ mime: 'audio/webm', base64: WEBM.toString('base64') }, { mime: 'audio/mp4', base64: MP4.toString('base64') }],
  });
  await pc.feedback.inbox.fetch();
  const [item] = pc.feedback.inbox.list();
  assert.equal(item.text, 'Spoken report');
  assert.equal('audio' in item, false);
  assert.equal(item.client, 'Android app 0.3.15 · Android 16 · SM-S918B');
  assert.equal(item.company, 'company-2');
  assert.equal(item.dictated, true);
  assert.equal(item.clientDiagnostics, 'java.lang.IllegalStateException');
  assert.deepEqual(readdirSync(pc.dir).sort(), [`${id(1)}.json`], 'only the words (and their facts) are kept');
  // A report an older inbox stored with its recordings beside it: it opens without them, and they go with it.
  writeFileSync(path.join(pc.dir, `${id(2)}.json`), JSON.stringify({
    id: id(2), receivedAt: 5, createdAt: 5, text: 'Older', appVersion: '0.3.14', os: 'win32', audio: [{ mime: 'audio/webm', size: WEBM.length, file: `${id(2)}.a1.webm` }],
  }));
  writeFileSync(path.join(pc.dir, `${id(2)}.a1.webm`), WEBM);
  writeFileSync(path.join(pc.dir, `${id(2)}.a2.m4a`), MP4);
  const older = pc.feedback.inbox.list().find((entry) => entry.id === id(2))!;
  assert.equal('audio' in older, false);
  assert.equal(pc.feedback.inbox.mark(id(2), 'done').handled?.as, 'done');
  assert.equal('audio' in JSON.parse(readFileSync(path.join(pc.dir, `${id(2)}.json`), 'utf8')), false, 'a rewrite drops the old list');
  const table = new HandlerTable();
  registerInbox(table);
  assert.equal(table.get('feedback.inboxAudio'), undefined, 'no recording is served');
  for (const n of [1, 2]) { pc.feedback.inbox.remove(id(n)); await settle(box, id(n)); }
  assert.deepEqual(readdirSync(pc.dir).sort(), [`${id(1)}${GONE}`, `${id(2)}${GONE}`], 'every file of a report goes, only tombstones are left');
});

test('a letter\'s new facts are untrusted: bounded, a company folder only as a folder name', () => {
  const opened = itemOf('x', { v: 1, text: 'a', client: 'c'.repeat(900), company: '../etc', clientDiagnostics: 'd'.repeat(20_000), dictated: 'yes', audio: 'nope' }, 1)!;
  assert.equal(opened.item.client!.length, 400);
  assert.equal(opened.item.company, undefined);
  assert.equal(opened.item.clientDiagnostics!.length, 12_000);
  assert.equal(opened.item.dictated, undefined);
  assert.deepEqual(opened.images, [], 'no image sent, none kept');
  assert.equal(opened.item.images, undefined);
});
