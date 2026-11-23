// B-055 Q2/Q3, the team side: the service account JWT (RS256, verified with the account's public key), one token
// per fetch, fetch → open → store (16.11.2026: the letter stays in the mailbox for the team's other PCs and companies;
// removing a report deletes its letter), unreadable letters kept locally (and, below the cap, in the mailbox), ids we
// never make left alone, untrusted letters checked, the RPC methods owner-only. Owner 21.11.2026: a letter's `images`
// are stored as <id>.<ext>, <id>.2.<ext>, …; an older sender's `screenshot` and an item an older build stored with
// one read as the first image.
// Owns: these assertions. Never: contacts Google.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { FeedbackService } from '../../../src/runtime/feedback/service.ts';
import { RECEIVER_KEY_ID, SERVICE_ACCOUNT_ID, SETUP_KEY, UNREADABLE_DIR } from '../../../src/runtime/feedback/inbox.ts';
import { itemOf } from '../../../src/runtime/feedback/letter.ts';
import { INBOX_DIR } from '../../../src/shared/model/feedback-delivery.ts';
import { DATASTORE_SCOPE, parseServiceAccount, serviceJwt } from '../../../src/runtime/feedback/google.ts';
import { generateReceiverKeys, sealReport } from '../../../src/runtime/feedback/seal.ts';
import { TOKEN_URL } from '../../../src/runtime/feedback/transport.ts';
import { register as registerInbox } from '../../../src/runtime/rpc/handlers/feedback-inbox.ts';
import { allowedScope, HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { API_KEY, PROJECT, fakeMailbox, feedbackEnv, serviceAccount, verifyJwt, type Env } from './fakes.ts';

const envs: Env[] = [];
after(() => { for (const env of envs) env.cleanup(); });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

async function team(options: { vault?: boolean } = {}) {
  const env = feedbackEnv();
  envs.push(env);
  const keys = generateReceiverKeys();
  const account = serviceAccount();
  const box = fakeMailbox({ accountKey: account.publicKey });
  if (options.vault !== false) {
    await env.vault.save({ id: RECEIVER_KEY_ID, label: 'Feedback team key', kind: 'token', value: keys.privateKey });
    await env.vault.save({ id: SERVICE_ACCOUNT_ID, label: 'Feedback mailbox service account', kind: 'token', value: account.text });
    new KvRepo(env.s.db).set(SETUP_KEY.ns, SETUP_KEY.key, { project: PROJECT, publicKey: keys.publicKey, apiKey: API_KEY }, 1);
  }
  const letter = (id: string, payload: Record<string, unknown>, key = keys.publicKey) => box.docs.set(id, sealReport(key, Buffer.from(JSON.stringify({ v: 1, id, ...payload }))));
  const feedback = new FeedbackService({ services: () => env.s, receiver: null, fetch: box.fetch });
  const dir = path.join(env.data, INBOX_DIR);
  return { env, keys, account, box, letter, feedback, dir };
}

test('the JWT: RS256 signed by the service account, iss/scope/aud/iat/exp as Google expects', () => {
  const account = serviceAccount();
  const parsed = parseServiceAccount(account.text);
  const now = Date.UTC(2026, 9, 29, 20);
  const { header, claims } = verifyJwt(serviceJwt(parsed, now), account.publicKey);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'abc123def456' });
  assert.deepEqual(claims, { iss: account.email, scope: DATASTORE_SCOPE, aud: TOKEN_URL, iat: now / 1000, exp: now / 1000 + 3600 });
  assert.equal(DATASTORE_SCOPE, 'https://www.googleapis.com/auth/datastore');
  assert.throws(() => verifyJwt(serviceJwt(parsed, now), serviceAccount().publicKey), /bad signature/);
  for (const bad of ['{', '{"type":"user"}', JSON.stringify({ ...JSON.parse(account.text), private_key: 'x' }), JSON.stringify({ ...JSON.parse(account.text), client_email: 'nobody' })]) {
    assert.throws(() => parseServiceAccount(bad), /service account|not JSON|private key/);
  }
});

test('fetch: open each letter and write its files; the letter stays for the team\'s other PCs – one token for the whole fetch', async () => {
  const { env, box, letter, feedback, dir } = await team();
  letter('11111111-1111-4111-8111-111111111111', { createdAt: 5, kind: 'bug', text: 'Sidebar flickers\nwhen resizing', appVersion: '0.2.8', os: 'win32 10.0 x64', view: 'chat', screenshot: { mime: 'image/png', base64: PNG.toString('base64') } });
  letter('22222222-2222-4222-8222-222222222222', { createdAt: 6, kind: 'idea', text: 'Dark charts', appVersion: '0.2.8', os: 'darwin 25 arm64', fromAgent: true,
    images: [{ mime: 'image/jpeg', base64: JPEG.toString('base64') }, { mime: 'image/png', base64: PNG.toString('base64') }] });
  const result = await feedback.inbox.fetch();
  assert.deepEqual(result, { added: 2, unreadable: 0, more: false, total: 2 });
  assert.deepEqual(box.log, ['list start', 'get 11111111-1111-4111-8111-111111111111', 'get 22222222-2222-4222-8222-222222222222']);
  assert.equal(box.docs.size, 2, 'the letters stay: another PC or company with the team key fetches them too');
  assert.equal(box.state.tokens, 1);
  const list = box.calls.find((call) => call.method === 'GET' && !call.url.pathname.endsWith('1111'))!;
  assert.equal(list.url.searchParams.get('pageSize'), '50');
  assert.equal(list.url.searchParams.get('mask.fieldPaths'), 'v', 'the list carries names only');
  assert.equal(list.headers.authorization, 'Bearer ya29.fake-access-token');
  assert.equal(list.init?.redirect, 'error');
  assert.deepEqual(readdirSync(dir).sort(), ['11111111-1111-4111-8111-111111111111.json', '11111111-1111-4111-8111-111111111111.png',
    '22222222-2222-4222-8222-222222222222.2.png', '22222222-2222-4222-8222-222222222222.jpg', '22222222-2222-4222-8222-222222222222.json']);
  const items = feedback.inbox.list();
  assert.deepEqual(items.map((item) => item.text), ['Dark charts', 'Sidebar flickers\nwhen resizing'], 'newest first');
  const first = items.find((item) => item.kind === 'bug')!;
  assert.deepEqual(first, { id: '11111111-1111-4111-8111-111111111111', receivedAt: env.clock.now(), createdAt: 5, kind: 'bug', text: 'Sidebar flickers\nwhen resizing', appVersion: '0.2.8', os: 'win32 10.0 x64', view: 'chat', images: [{ mime: 'image/png', size: PNG.length }] }, 'an older sender\'s screenshot is the one image');
  const second = items.find((item) => item.kind === 'idea')!;
  assert.equal(second.fromAgent, true);
  assert.deepEqual(second.images, [{ mime: 'image/jpeg', size: JPEG.length }, { mime: 'image/png', size: PNG.length }]);
  assert.deepEqual(feedback.inbox.image(first.id, 0), { mime: 'image/png', dataBase64: PNG.toString('base64') });
  assert.deepEqual(feedback.inbox.image(second.id, 1), { mime: 'image/png', dataBase64: PNG.toString('base64') });
  assert.deepEqual(feedback.inbox.image(second.id, 0), { mime: 'image/jpeg', dataBase64: JPEG.toString('base64') });
  assert.throws(() => feedback.inbox.image(second.id, 2), /no such image/);
  const again = await feedback.inbox.fetch();
  assert.deepEqual(again, { added: 0, unreadable: 0, more: false, total: 2 }, 'a second fetch reads nothing it has');
  assert.equal(box.log.filter((line) => line.startsWith('get')).length, 2);
  assert.deepEqual(feedback.inbox.remove(first.id), { ok: true });
  assert.deepEqual(readdirSync(dir).sort(), ['11111111-1111-4111-8111-111111111111.gone', '22222222-2222-4222-8222-222222222222.2.png',
    '22222222-2222-4222-8222-222222222222.jpg', '22222222-2222-4222-8222-222222222222.json'], 'the report goes, its tombstone stays');
  for (let wait = 0; wait < 50 && box.docs.has(first.id); wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([...box.docs.keys()], ['22222222-2222-4222-8222-222222222222'], 'a removed report\'s letter leaves the mailbox, so no fetch brings it back');
  assert.throws(() => feedback.inbox.image(first.id, 0), /no such image/);
  feedback.inbox.remove(second.id);
  assert.deepEqual(readdirSync(dir).sort(), ['11111111-1111-4111-8111-111111111111.gone', '22222222-2222-4222-8222-222222222222.gone'], 'every image of a report goes with it');
  assert.throws(() => feedback.inbox.remove('../workforce'), /Invalid report id/);
});

test('pages, letters for another key, damaged ones and ids we never make; a stored letter is not read again', async () => {
  const { box, letter, feedback, dir } = await team();
  for (let index = 0; index < 55; index++) letter(`aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`, { createdAt: index, text: `Report ${index}`, appVersion: '1', os: 'x' });
  letter('bbbbbbbb-0000-4000-8000-000000000000', { text: 'Sealed for an earlier key' }, generateReceiverKeys().publicKey);
  box.docs.set('cccccccc-0000-4000-8000-000000000000', Buffer.from('WFB1 damaged'));
  box.docs.set('odd.id with space', Buffer.from('junk'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'dddddddd-0000-4000-8000-000000000000.json'), JSON.stringify({ id: 'dddddddd-0000-4000-8000-000000000000', receivedAt: 1, createdAt: 1, text: 'Stored before', appVersion: '', os: '' }));
  letter('dddddddd-0000-4000-8000-000000000000', { text: 'Stored before' });
  const result = await feedback.inbox.fetch();
  assert.deepEqual(result, { added: 55, unreadable: 3, more: false, total: 56 });
  assert.equal(box.log.filter((line) => line.startsWith('list')).length, 2, 'two pages of 50');
  assert.equal(box.log.includes('get dddddddd-0000-4000-8000-000000000000'), false, 'already on this PC: not read again');
  assert.equal(box.docs.has('bbbbbbbb-0000-4000-8000-000000000000') && box.docs.has('cccccccc-0000-4000-8000-000000000000'), true, 'unopenable letters stay for a team PC with the newer key');
  assert.equal(box.docs.size, 59, 'the 55 new letters, the stored one, the two unopenable ones and the id no sender of ours makes stay');
  await feedback.inbox.fetch();
  assert.equal(box.log.filter((line) => line === 'get bbbbbbbb-0000-4000-8000-000000000000').length, 1, 'the local copy marks an unopenable letter seen');
  assert.deepEqual(readdirSync(path.join(dir, UNREADABLE_DIR)).sort(), ['bbbbbbbb-0000-4000-8000-000000000000.wfb', 'cccccccc-0000-4000-8000-000000000000.wfb']);
  assert.deepEqual(readFileSync(path.join(dir, UNREADABLE_DIR, 'cccccccc-0000-4000-8000-000000000000.wfb')), Buffer.from('WFB1 damaged'), 'kept as it came');
});

test('a refused service account stops before anything is deleted; no team key means no request at all', async () => {
  const { box, letter, feedback } = await team();
  letter('11111111-1111-4111-8111-111111111111', { text: 'Waiting' });
  box.state.token = 400;
  await assert.rejects(feedback.inbox.fetch(), (error: Error) => {
    assert.match(error.message, /refused the feedback service account/);
    assert.doesNotMatch(error.message, /upstream|invalid_grant/);
    return true;
  });
  assert.equal(box.docs.size, 1);
  const none = await team({ vault: false });
  await assert.rejects(none.feedback.inbox.fetch(), /no team key/);
  assert.equal(none.box.calls.length, 0);
  assert.deepEqual(none.feedback.inbox.list(), []);
  assert.equal(none.feedback.inbox.receiving(), false);
});

test('two fetches at once share one run', async () => {
  const { letter, feedback, box } = await team();
  letter('11111111-1111-4111-8111-111111111111', { text: 'Once' });
  const [a, b] = await Promise.all([feedback.inbox.fetch(), feedback.inbox.fetch()]);
  assert.deepEqual(a, b);
  assert.equal(box.log.filter((line) => line.startsWith('get')).length, 1);
});

test('an opened letter is untrusted: only v1 reports, bounded text, known kinds, real PNG/JPEG/WebP images', () => {
  assert.equal(itemOf('x', { v: 2, text: 'a' }, 1), undefined);
  assert.equal(itemOf('x', { v: 1, text: '   ' }, 1), undefined);
  assert.equal(itemOf('x', 'text', 1), undefined);
  const long = itemOf('x', { v: 1, text: 'y'.repeat(30_000), kind: 'rant', os: 'o'.repeat(500), createdAt: 'yesterday', fromAgent: 'yes' }, 7)!.item;
  assert.equal(long.text.length, 20_000);
  assert.equal(long.kind, undefined);
  assert.equal(long.os.length, 120);
  assert.equal(long.createdAt, 7);
  assert.equal(long.fromAgent, undefined);
  const svg = Buffer.from('<svg onload="alert(1)"/>').toString('base64');
  assert.equal(itemOf('x', { v: 1, text: 'a', screenshot: { mime: 'image/svg+xml', base64: svg } }, 1)!.item.images, undefined);
  assert.equal(itemOf('x', { v: 1, text: 'a', screenshot: { mime: 'image/png', base64: svg } }, 1)!.item.images, undefined, 'the bytes must be a PNG');
  const jpeg = itemOf('x', { v: 1, text: 'a', screenshot: { mime: 'image/jpeg', base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]).toString('base64') } }, 1)!;
  assert.deepEqual(jpeg.item.images, [{ mime: 'image/jpeg', size: 5 }]);
  const png = { mime: 'image/png', base64: PNG.toString('base64') };
  const many = itemOf('x', { v: 1, text: 'a', images: [png, { mime: 'image/svg+xml', base64: svg }, 'junk', ...Array.from({ length: 8 }, () => png)] }, 1)!;
  assert.equal(many.item.images?.length, 4, 'a bad image is dropped, never the report; at most 6 are read');
  assert.equal(many.images.length, 4);
  assert.equal(itemOf('x', { v: 1, text: 'a', images: [], screenshot: png }, 1)!.item.images, undefined, 'a letter with `images` has no other');
});

test("RPC: the inbox is the owner's and the owner's secure phone's, setup the owner's; ids are checked", async () => {
  const table = new HandlerTable();
  registerInbox(table);
  const widest: ClientScope = { kind: 'device', deviceId: 'dev_x', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
  const lan: ClientScope = { ...widest, secure: false };
  const person = { kind: 'person', personId: 'per_anna000000', deviceId: 'dev_anna00000001', tokenId: 'tok_1', secure: true } as unknown as ClientScope;
  for (const method of ['feedback.inboxList', 'feedback.inboxFetch', 'feedback.inboxRemove', 'feedback.inboxMark', 'feedback.inboxImage'] as const) {
    const entry = table.get(method)!;
    assert.deepEqual(entry.scope, { capability: 'settings', secure: true }, method); // 16.11.2026: Settings › Feedback on the phone
    assert.equal(allowedScope(entry.scope, widest), true, method);
    assert.equal(allowedScope(entry.scope, lan), false, `${method}: never over plain LAN http`);
    assert.equal(allowedScope(entry.scope, person), false, `${method}: never a person of the organisation`);
    assert.equal(allowedScope(entry.scope, { kind: 'owner' }), true, method);
  }
  assert.equal(table.get('feedback.setup')!.scope, 'owner');
  assert.equal(allowedScope(table.get('feedback.setup')!.scope, widest), false, 'setup stays on the PC');
  const removed: string[] = [];
  const ctx = { scope: { kind: 'owner' }, extras: { feedback: { inbox: { remove: (id: string) => { removed.push(id); return { ok: true }; } } } } } as unknown as HandlerContext;
  await assert.rejects(Promise.resolve().then(() => table.get('feedback.inboxRemove')!.handler({ id: '../../etc' } as never, ctx)), /report id/);
  await assert.rejects(Promise.resolve().then(() => table.get('feedback.inboxRemove')!.handler({ id: 'a', extra: 1 } as never, ctx)), /params\.extra/);
  await table.get('feedback.inboxRemove')!.handler({ id: '11111111-1111-4111-8111-111111111111' } as never, ctx);
  assert.deepEqual(removed, ['11111111-1111-4111-8111-111111111111']);
  await assert.rejects(Promise.resolve().then(() => table.get('feedback.inboxList')!.handler(undefined as never, { ...ctx, extras: { feedback: {} } } as unknown as HandlerContext)), /not available/);
  const asked: Array<[string, number]> = [];
  const images = { ...ctx, extras: { feedback: { inbox: { image: (id: string, index: number) => { asked.push([id, index]); return { mime: 'image/png', dataBase64: '' }; } } } } } as unknown as HandlerContext;
  await table.get('feedback.inboxImage')!.handler({ id: '11111111-1111-4111-8111-111111111111', index: 5 } as never, images);
  assert.deepEqual(asked, [['11111111-1111-4111-8111-111111111111', 5]]);
  for (const index of [-1, 6, 1.5, '0']) {
    await assert.rejects(Promise.resolve().then(() => table.get('feedback.inboxImage')!.handler({ id: '11111111-1111-4111-8111-111111111111', index } as never, images)), /parameter "index"/);
  }
});

test('an item an older build stored with its one screenshot reads as images[0]; a mark keeps it readable', async () => {
  const { feedback, dir } = await team();
  const id = '33333333-3333-4333-8333-333333333333';
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, receivedAt: 1, createdAt: 1, text: 'Old', appVersion: '0.3.10', os: 'x', screenshot: { mime: 'image/png', size: PNG.length } }));
  writeFileSync(path.join(dir, `${id}.png`), PNG);
  const [item] = feedback.inbox.list();
  assert.deepEqual(item!.images, [{ mime: 'image/png', size: PNG.length }]);
  assert.equal('screenshot' in item!, false);
  assert.deepEqual(feedback.inbox.image(id, 0), { mime: 'image/png', dataBase64: PNG.toString('base64') });
  feedback.inbox.mark(id, 'done');
  assert.deepEqual(feedback.inbox.image(id, 0).mime, 'image/png');
});

test('review 21.11.2026: removing a report takes only its own files – never those of an id that starts the same', async () => {
  const { letter, feedback, dir } = await team();
  const png = { mime: 'image/png', base64: PNG.toString('base64') };
  const jpeg = { mime: 'image/jpeg', base64: JPEG.toString('base64') };
  for (const id of ['abc', 'abc-def', 'abc-2']) letter(id, { createdAt: 1, text: `Report ${id}`, appVersion: '1', os: 'x', images: [png, jpeg] });
  assert.equal((await feedback.inbox.fetch()).added, 3);
  assert.deepEqual(readdirSync(dir).sort(), ['abc-2.2.jpg', 'abc-2.json', 'abc-2.png', 'abc-def.2.jpg', 'abc-def.json', 'abc-def.png', 'abc.2.jpg', 'abc.json', 'abc.png'],
    'the second image of abc never takes the name of report abc-2\'s first');
  feedback.inbox.remove('abc');
  assert.deepEqual(readdirSync(dir).sort(), ['abc-2.2.jpg', 'abc-2.json', 'abc-2.png', 'abc-def.2.jpg', 'abc-def.json', 'abc-def.png', 'abc.gone']);
  assert.deepEqual(feedback.inbox.image('abc-2', 1), { mime: 'image/jpeg', dataBase64: JPEG.toString('base64') });
  assert.deepEqual(feedback.inbox.list().map((item) => item.id).sort(), ['abc-2', 'abc-def']);
});
