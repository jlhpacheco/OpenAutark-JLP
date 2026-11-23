// Feedback 16.11.2026 (F15/F22): nothing written on a phone may be lost – the page's outbox (src/ui/feedback/outbox.ts)
// keeps a sent report before anything goes out, delivers it with its clientId (a lost answer never makes a second
// report), holds it while the PC is away and flushes it on the next connect, oldest first; the draft itself survives a
// reload. Owner 21.11.2026: an entry carries several images (uploaded in order → imageFileIds); an older build's entry
// with one `image` still goes with it; a kept draft's photos come back, an older draft's boxes as covering pen lines.
// A fake store and a fake PC stand in for IndexedDB and the runtime.
// Owns: these assertions. Never: a real IndexedDB, socket or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '../../../src/ui/lib/rpc.ts';
import type { KeyValue } from '../../../src/ui/lib/take-store.ts';
import type { FeedbackReport } from '../../../src/shared/model/system.ts';
import { EMPTY_DRAFT } from '../../../src/ui/feedback/draft.ts';
import { FeedbackOutbox, OUTBOX_MAX_AGE_MS, WORDLESS_TEXT, draftOf, entryImages, newClientId, penMarks } from '../../../src/ui/feedback/outbox.ts';
import type { OutboxEntry, Outcome } from '../../../src/ui/feedback/outbox.ts';

function memoryKv(): KeyValue & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value); },
    remove: async (key) => { map.delete(key); },
    values: async (prefix) => [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
  };
}

const lost = () => new RpcError({ code: 'unavailable', message: 'Connection to the runtime was lost.' });

/** A PC that dedupes feedback.create by clientId, as the runtime does; `link` is the connection. */
function fakePc(kv: KeyValue | null, start = 1_000_000) {
  const link = { open: true };
  const reports = new Map<string, FeedbackReport>();
  const calls: string[] = [];
  const uploads: Array<{ name: string; type: string; size: number }> = [];
  let now = start;
  let next = 0;
  const pc = {
    link, reports, calls, uploads,
    tick: (ms: number) => { now += ms; },
    /** The next create is stored on the PC, but its answer is lost with the connection. */
    loseCreateAnswer: false,
    loseSendAnswer: false,
    sendFails: null as RpcError | null,
    createRefuses: null as RpcError | null,
    /** feedback.create of this clientId waits for `gate`. */
    holdId: '',
    gate: Promise.resolve(),
  };
  const outbox = new FeedbackOutbox({
    kv,
    now: () => now,
    online: () => link.open,
    upload: async (blob, name) => {
      if (!link.open) throw lost();
      uploads.push({ name, type: blob.type, size: blob.size });
      return `file_${++next}`;
    },
    create: async (params) => {
      calls.push(`create ${params.clientId}`);
      if (params.clientId === pc.holdId) await pc.gate;
      if (!link.open) throw lost();
      if (pc.createRefuses) throw pc.createRefuses;
      const known = [...reports.values()].find((report) => (report as FeedbackReport & { clientId?: string }).clientId === params.clientId);
      const report = known ?? ({ id: `fb_${++next}`, status: 'local', text: params.text, clientId: params.clientId, params } as unknown as FeedbackReport);
      reports.set(report.id, report);
      if (pc.loseCreateAnswer) { pc.loseCreateAnswer = false; link.open = false; throw lost(); }
      return report;
    },
    send: async (id) => {
      calls.push(`send ${id}`);
      if (!link.open) throw lost();
      if (pc.sendFails) throw pc.sendFails;
      const sent = { ...reports.get(id)!, status: 'sent', receiptId: '6f9619ff-8b86-4011-b42d-00cf4fc964ff' } as FeedbackReport;
      reports.set(id, sent);
      if (pc.loseSendAnswer) { pc.loseSendAnswer = false; link.open = false; throw lost(); }
      return sent;
    },
  });
  return { pc, outbox };
}

function entry(change: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    clientId: newClientId(), at: 1_000_000, send: true, text: 'The sidebar flickers', where: { view: '#/chat/ch_1', conversationId: 'ch_1' },
    client: 'Android app 0.3.15 · Android 16 · samsung SM-S918B · 412×915 @3x', ...change,
  };
}

test('a client id is short, URL-safe and new every time', () => {
  const a = newClientId(1);
  assert.match(a, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(newClientId(1), a);
});

test('the entry is stored before anything goes out, sent with its clientId, client, images and words, then deleted', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv);
  const report = entry({ images: ['data:image/jpeg;base64,QUJD', 'data:image/jpeg;base64,REVG'], dictated: true, clientDiagnostics: 'android.os.NetworkOnMainThreadException' });
  await outbox.put(report);
  assert.ok(kv.map.has(`feedback:${report.clientId}`), 'in the page storage before any upload or call');
  const outcome = await outbox.deliver(report);
  assert.equal(outcome.kind, 'sent');
  assert.deepEqual(pc.uploads.map((file) => [file.name, file.type]), [['screenshot.jpg', 'image/jpeg'], ['screenshot.jpg', 'image/jpeg']], 'the images only: a report is its words (owner 20.11.2026)');
  const stored = [...pc.reports.values()][0] as unknown as { params: Record<string, unknown> };
  assert.deepEqual(stored.params, {
    text: 'The sidebar flickers', clientId: report.clientId, client: report.client, imageFileIds: ['file_1', 'file_2'],
    view: '#/chat/ch_1', conversationId: 'ch_1', clientDiagnostics: 'android.os.NetworkOnMainThreadException', dictated: true,
  }, 'no kind: the person\'s report has none');
  assert.equal(kv.map.size, 0, 'deleted once the PC holds it');
  assert.deepEqual(await outbox.pending(), []);
});

test('offline: held in the page, flushed on the next connect, oldest first, then gone', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv);
  pc.link.open = false;
  const older = entry({ at: 1_000_000, text: 'first' });
  const newer = entry({ at: 1_000_500, text: 'second' });
  await outbox.put(newer);
  await outbox.put(older);
  assert.equal((await outbox.deliver(newer)).kind, 'held');
  assert.deepEqual(pc.calls, [], 'nothing is tried while the link is down');
  const seen: Outcome[] = [];
  await outbox.flush((outcome) => seen.push(outcome));
  assert.equal(seen.length, 0, 'still away: the round ends at once');
  pc.link.open = true;
  await outbox.flush((outcome) => seen.push(outcome));
  assert.deepEqual(seen.map((outcome) => outcome.kind), ['sent', 'sent']);
  assert.deepEqual([...pc.reports.values()].map((report) => report.text), ['first', 'second'], 'oldest first');
  assert.equal(kv.map.size, 0);
});

test('a lost create answer never makes a second report: the same clientId returns the stored one', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv);
  const report = entry();
  await outbox.put(report);
  pc.loseCreateAnswer = true;
  assert.equal((await outbox.deliver(report)).kind, 'held', 'the answer was lost with the connection');
  assert.equal(pc.reports.size, 1, 'the PC has it already');
  pc.link.open = true;
  const seen: Outcome[] = [];
  await outbox.flush((outcome) => seen.push(outcome));
  assert.deepEqual(seen.map((outcome) => outcome.kind), ['sent']);
  assert.equal(pc.reports.size, 1, 'still one report');
  assert.deepEqual(pc.calls.filter((call) => call.startsWith('create')), [`create ${report.clientId}`, `create ${report.clientId}`]);
});

test('a lost send answer keeps the entry with its report id; the next round only sends', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv);
  const report = entry();
  await outbox.put(report);
  pc.loseSendAnswer = true;
  assert.equal((await outbox.deliver(report)).kind, 'held');
  const kept = (await outbox.pending())[0]!;
  assert.ok(kept.reportId, 'create answered: only the send is left');
  pc.link.open = true;
  pc.calls.length = 0;
  await outbox.flush(() => undefined);
  assert.deepEqual(pc.calls, [`send ${kept.reportId}`]);
  assert.equal(kv.map.size, 0);
});

test('the PC answered the send with an error: its report is saved there, the entry goes (no endless resend from the page)', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv);
  pc.sendFails = new RpcError({ code: 'unavailable', message: 'The mailbox did not answer.', details: { reason: 'offline' } });
  const report = entry();
  await outbox.put(report);
  const outcome = await outbox.deliver(report);
  assert.equal(outcome.kind, 'saved');
  assert.equal(outcome.kind === 'saved' && outcome.report.status, 'local');
  assert.ok(outcome.kind === 'saved' && outcome.error instanceof RpcError);
  assert.equal(kv.map.size, 0);
});

test('Save only creates; a report refused as invalid is deleted and comes back as a draft', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv);
  const saved = entry({ send: false });
  await outbox.put(saved);
  assert.equal((await outbox.deliver(saved)).kind, 'saved');
  assert.deepEqual(pc.calls, [`create ${saved.clientId}`], 'Save never sends');
  pc.createRefuses = new RpcError({ code: 'bad_request', message: 'text is too long' });
  const bad = entry({ text: 'Words to keep', images: ['data:image/jpeg;base64,QUJD', 'data:image/jpeg;base64,REVG'], clientDiagnostics: 'trace' });
  await outbox.put(bad);
  const outcome = await outbox.deliver(bad);
  assert.equal(outcome.kind, 'refused');
  assert.equal(kv.map.size, 0, 'it would never go: not kept');
  const draft = draftOf(bad);
  assert.equal(draft.text, 'Words to keep');
  assert.deepEqual(draft.photos.map((photo) => [photo.src, photo.marks.length]), [['data:image/jpeg;base64,QUJD', 0], ['data:image/jpeg;base64,REVG', 0]], 'its images come back as photos (their marks are in them)');
  assert.equal(draft.shot, null, 'the next press takes the window anew');
  assert.equal(draft.diagnostics, 'trace');
  assert.equal(draftOf(entry({ text: '(crash report)' })).text, '', 'a placeholder text is not the person\'s words');
});

test('one delivery of an entry at a time; a flush skips the one on its way and keeps going', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv);
  const first = entry({ at: 1 });
  const second = entry({ at: 2 });
  await outbox.put(first);
  await outbox.put(second);
  let release: () => void = () => undefined;
  pc.holdId = first.clientId;
  pc.gate = new Promise<void>((resolve) => { release = resolve; });
  const running = outbox.deliver(first); // the form's own Send, waiting for the PC
  assert.equal((await outbox.deliver(first)).kind, 'held', 'already on its way');
  const seen: Outcome[] = [];
  await outbox.flush((outcome) => seen.push(outcome));
  assert.deepEqual(seen.map((outcome) => outcome.kind), ['sent'], 'the flush delivered the other one');
  release();
  assert.equal((await running).kind, 'sent');
  assert.equal(pc.reports.size, 2);
  assert.equal(pc.calls.filter((call) => call === `create ${first.clientId}`).length, 1, 'never filed twice');
});

test('entries older than a month go without a try', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv, 1_000_000 + OUTBOX_MAX_AGE_MS + 1);
  await outbox.put(entry({ at: 1_000_000 }));
  assert.deepEqual(await outbox.pending(), []);
  assert.equal(kv.map.size, 0);
  assert.deepEqual(pc.calls, []);
});

test('without page storage (blocked IndexedDB) the entry still waits in memory', async () => {
  const { pc, outbox } = fakePc(null);
  pc.link.open = false;
  const report = entry();
  await outbox.put(report);
  assert.equal((await outbox.pending()).length, 1);
  pc.link.open = true;
  await outbox.flush(() => undefined);
  assert.equal(pc.reports.size, 1);
  assert.deepEqual(await outbox.pending(), []);
});

test('storage that throws never fails a report', async () => {
  const broken: KeyValue = { get: async () => { throw new Error('quota'); }, set: async () => { throw new Error('quota'); }, remove: async () => { throw new Error('quota'); }, values: async () => { throw new Error('quota'); } };
  const { pc, outbox } = fakePc(broken);
  const report = entry();
  await outbox.put(report);
  assert.equal((await outbox.deliver(report)).kind, 'sent');
  assert.equal(pc.reports.size, 1);
  assert.equal(await outbox.loadDraft(), undefined);
});

test('the draft survives a reload, an empty one clears the key; an older draft\'s recordings stay behind', async () => {
  const kv = memoryKv();
  const { outbox } = fakePc(kv);
  await outbox.saveDraft({ ...EMPTY_DRAFT, text: 'Half written', shot: 'data:image/jpeg;base64,QUJD', dictated: true, where: { view: '#/home' } });
  const kept = await outbox.loadDraft();
  assert.equal(kept?.text, 'Half written');
  assert.equal(kept?.dictated, true);
  const take = { blob: new Blob([new Uint8Array([1, 2])], { type: 'audio/mp4' }), mime: 'audio/mp4', ms: 900 };
  kv.map.set('feedback-draft', { at: 1_000_000, draft: { ...EMPTY_DRAFT, text: 'Older', audio: [take], withAudio: true } });
  const older = await outbox.loadDraft();
  assert.equal(older?.text, 'Older');
  assert.equal(older && ('audio' in older || 'withAudio' in older), false);
  await outbox.saveDraft({ ...EMPTY_DRAFT, text: 'Half written', shot: 'data:image/jpeg;base64,QUJD', where: { view: '#/home' } });
  const again = await outbox.loadDraft();
  assert.deepEqual(again?.where, { view: '#/home' });
  await outbox.saveDraft({ ...EMPTY_DRAFT, shot: 'data:image/jpeg;base64,QUJD' });
  assert.equal(kv.map.has('feedback-draft'), false, 'a screenshot alone is no draft (the next press retakes it)');
  assert.equal(await outbox.loadDraft(), undefined);
  kv.map.set('feedback-draft', { at: 1, draft: { ...EMPTY_DRAFT, text: 'ancient' } });
  assert.equal(await (fakePc(kv, 1 + OUTBOX_MAX_AGE_MS + 1).outbox).loadDraft(), undefined, 'a month-old draft is not brought back');
});

test('owner 21.11.2026: a kept draft\'s photos come back; photos alone are a draft; an older draft\'s box covers as a pen line', async () => {
  const kv = memoryKv();
  const { outbox } = fakePc(kv);
  const pen = { tool: 'pen' as const, width: 4, points: [[1, 1], [9, 9]] as [number, number][] };
  await outbox.saveDraft({ ...EMPTY_DRAFT, photos: [{ id: 'p1', src: 'data:image/jpeg;base64,QUJD', marks: [pen] }], onStage: 'p1' });
  assert.ok(kv.map.has('feedback-draft'), 'a photo alone is worth keeping');
  const kept = await outbox.loadDraft();
  assert.deepEqual(kept?.photos, [{ id: 'p1', src: 'data:image/jpeg;base64,QUJD', marks: [pen] }]);
  assert.equal(kept?.onStage, 'p1');
  kv.map.set('feedback-draft', { at: 1_000_000, draft: { text: 'Before the update', shot: 'data:x', painted: 'data:flat', withShot: true, where: {}, marks: [{ tool: 'box', from: [30, 50], to: [10, 10] }, pen, { tool: 'blob' }] } });
  const older = await outbox.loadDraft();
  assert.deepEqual(older?.marks, [{ tool: 'pen', width: 40, points: [[10, 30], [30, 30]] }, pen], 'as tall as the box along its middle: its round ends cover it whole');
  assert.deepEqual(older?.photos, []);
  assert.equal(older?.onStage, null);
  assert.equal(older && 'painted' in older, false);
  assert.deepEqual(penMarks('nope'), []);
  assert.deepEqual(entryImages({ image: 'data:a' }), ['data:a'], 'an older build\'s entry: its one image');
  assert.deepEqual(entryImages({ images: ['data:a', 'data:b'] }), ['data:a', 'data:b']);
  assert.deepEqual(entryImages({}), []);
});

test('review 20.11.2026: an older recording-only report is held for words – never sent with its placeholder, back in an empty form', async () => {
  const kv = memoryKv();
  const { pc, outbox } = fakePc(kv);
  const old = entry({ text: WORDLESS_TEXT, image: 'data:image/jpeg;base64,QUJD', at: 1_000_000 });
  const later = entry({ text: 'Written after it', at: 1_000_001 });
  await outbox.put(old);
  await outbox.put(later);
  assert.equal((await outbox.deliver(old)).kind, 'held');
  const seen: string[] = [];
  await outbox.flush((_outcome, done) => seen.push(done.text));
  assert.deepEqual(seen, ['Written after it'], 'held for words, it blocks nothing behind it');
  assert.equal(pc.calls.some((call) => call.includes(old.clientId)), false, 'the placeholder never goes out');
  const back = await outbox.takeWordless();
  assert.equal(back?.clientId, old.clientId);
  const draft = draftOf(back!);
  assert.equal(draft.text, '', 'the placeholder is no one\'s words');
  assert.deepEqual(draft.photos.map((photo) => photo.src), ['data:image/jpeg;base64,QUJD'], 'an older entry\'s one image');
  assert.equal(await outbox.takeWordless(), undefined, 'taken out of the outbox');
});

test('review 20.11.2026: a PC of an older build refusing `dictated` gets the report again without it', async () => {
  const { pc, outbox } = fakePc(memoryKv());
  const report = entry({ dictated: true });
  const refusing = new RpcError({ code: 'bad_request', message: 'Invalid parameter "params.dictated": expected one of kind, text.' });
  const original = outbox['deps'].create;
  outbox['deps'].create = async (params) => {
    if ('dictated' in params) throw refusing; // the older PC
    return original(params);
  };
  const outcome = await outbox.deliver(report);
  assert.equal(outcome.kind, 'sent');
  const stored = [...pc.reports.values()][0] as unknown as { params: Record<string, unknown> };
  assert.equal('dictated' in stored.params, false, 'the words went, without the new flag');
  const other = new RpcError({ code: 'bad_request', message: 'Invalid parameter "params.text": expected a text.' });
  outbox['deps'].create = async () => { throw other; };
  assert.equal((await outbox.deliver(entry({ dictated: true }))).kind, 'refused', 'any other refusal stays a refusal');
});
