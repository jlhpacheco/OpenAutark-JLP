// 16.11.2026 (system-Q1: the team had no readable way through its inbox – ALL-FEEDBACK.md needed a hand-written
// script): `wf feedback list [--open]` one line per report (number, date, mark, where written, first line),
// `wf feedback show <no>` the whole report with its files on this PC, `wf feedback mark <no> done|irrelevant|open`,
// all by the report number both sides show; their argument checks.
// Owns: these assertions. Never: a real runtime (fake-runtime.ts) or a real inbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { FeedbackInboxItem } from '../../../src/shared/model/feedback-delivery.ts';
import { AT } from './fixtures.ts';
import { fakeRuntime, wf } from './fake-runtime.ts';

const PHONE: FeedbackInboxItem = {
  id: 'c0fd8641-9cb7-46f5-b790-b6be9ba14381', receivedAt: AT - 60_000, createdAt: AT - 120_000,
  text: 'Es hat nicht funktioniert.\nDa war irgendwas ganz Komisches mit der App.', appVersion: '0.3.9', os: 'win32 10.0.26300 x64', view: '#/home',
  client: 'Android app 0.3.15 · Android 16 · SM-S918B · 412×915', company: 'company-2', dictated: true,
  diagnostics: '2026-11-16T06:48:00Z warn engine failed', clientDiagnostics: 'android.os.NetworkOnMainThreadException\n\tat WebSocketClient.shutdown',
  images: [{ mime: 'image/jpeg', size: 150_000 }, { mime: 'image/png', size: 90_000 }],
};
const OLD: FeedbackInboxItem = {
  id: '26730442-2d55-4bab-a41e-d50da8361467', receivedAt: AT - 9 * 86_400_000, createdAt: Date.UTC(2026, 10, 8, 14, 51), kind: 'bug', text: 'hi',
  appVersion: '0.3.4', os: 'win32 10.0.26200 x64', handled: { as: 'irrelevant', at: AT - 3_600_000 },
};

async function inboxRuntime() {
  const marks: unknown[] = [];
  const runtime = await fakeRuntime({
    'feedback.inboxList': () => [PHONE, OLD],
    'feedback.inboxMark': (params) => {
      marks.push(params);
      const { id, as } = params as { id: string; as: 'done' | 'irrelevant' | null };
      const item = [PHONE, OLD].find((entry) => entry.id === id)!;
      const { handled: _old, ...rest } = item;
      return as ? { ...rest, handled: { as, at: AT } } : rest;
    },
  });
  return { runtime, marks };
}

test('wf feedback list: number, date, mark, where it was written and the first line; --open leaves marked ones out', async (t) => {
  const { runtime } = await inboxRuntime();
  t.after(() => runtime.stop());
  const list = await wf(['feedback', 'list'], { runtime });
  assert.equal(list.code, 0, list.err);
  const lines = list.out.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^C0FD8641 {2}\d{2}:\d{2} {2}\[open\] {2}Android app 0\.3\.15 · Android 16 · SM-S918B · 412×915 {2}– {2}Es hat nicht funktioniert\.$/);
  assert.match(lines[1], /^26730442 {2}2026-11-08 \d{2}:\d{2} {2}\[not relevant\] {2}PC 0\.3\.4 · win32 10\.0\.26200 x64 {2}– {2}hi$/, 'an older sender: its PC\'s version and OS');
  const open = await wf(['feedback', 'list', '--open'], { runtime });
  assert.equal(open.out.trimEnd().split('\n').length, 1);
  assert.match(open.out, /^C0FD8641/);
  const json = JSON.parse((await wf(['feedback', 'list', '--open', '--json'], { runtime })).out) as FeedbackInboxItem[];
  assert.deepEqual(json.map((item) => item.id), [PHONE.id]);
});

test('wf feedback show <no>: text, facts, both diagnostics and the report\'s files on this PC', async (t) => {
  const { runtime } = await inboxRuntime();
  t.after(() => runtime.stop());
  const show = await wf(['feedback', 'show', 'c0fd8641'], { runtime });
  assert.equal(show.code, 0, show.err);
  const dir = path.resolve('fake-profile', 'feedback-inbox');
  for (const line of [
    `Report C0FD8641 (${PHONE.id})`,
    'From: Android app 0.3.15 · Android 16 · SM-S918B · 412×915',
    'Sending PC: 0.3.9 · win32 10.0.26300 x64',
    'Company folder: company-2',
    'View: #/home',
    'Dictated: the words are a transcript – read them for what was meant.',
    'Mark: open',
    'Es hat nicht funktioniert.\nDa war irgendwas ganz Komisches mit der App.',
    'Diagnostics (the sending PC\'s log):\n2026-11-16T06:48:00Z warn engine failed',
    'Device diagnostics:\nandroid.os.NetworkOnMainThreadException\n\tat WebSocketClient.shutdown',
    `Image 1: ${path.join(dir, `${PHONE.id}.jpg`)}`,
    `Image 2: ${path.join(dir, `${PHONE.id}.2.png`)}`,
  ]) assert.ok(show.out.includes(line), `missing: ${line}\n${show.out}`);
  const old = await wf(['feedback', 'show', OLD.id], { runtime });
  assert.match(old.out, /Kind: bug/);
  assert.match(old.out, /Mark: not relevant \(/);
  assert.doesNotMatch(old.out, /Image \d:|Recording/);
  const missing = await wf(['feedback', 'show', 'ABCDEF12'], { runtime });
  assert.equal(missing.code === 0, false);
  assert.match(missing.err, /No report ABCDEF12 in the inbox on this PC/);
});

test('wf feedback mark <no> done|irrelevant|open calls feedback.inboxMark with the report\'s id', async (t) => {
  const { runtime, marks } = await inboxRuntime();
  t.after(() => runtime.stop());
  const done = await wf(['feedback', 'mark', 'C0FD8641', 'done'], { runtime });
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, 'Report C0FD8641 is marked done; it leaves the inbox on this PC 7 days from now.\n');
  const open = await wf(['feedback', 'mark', '26730442', 'open'], { runtime });
  assert.equal(open.out, 'Report 26730442 is open again.\n');
  await wf(['feedback', 'mark', PHONE.id, 'irrelevant'], { runtime });
  assert.deepEqual(marks, [{ id: PHONE.id, as: 'done' }, { id: OLD.id, as: null }, { id: PHONE.id, as: 'irrelevant' }]);
});

test('wf feedback list/show/mark: argument checks before anything connects', async () => {
  for (const [args, message] of [
    [['feedback', 'show'], /Use wf feedback show <no>/],
    [['feedback', 'mark', 'C0FD8641'], /Use wf feedback mark <no> done, irrelevant or open/],
    [['feedback', 'mark', 'C0FD8641', 'spam'], /Use wf feedback mark <no> done, irrelevant or open/],
    [['feedback', 'list', 'extra'], /takes no more words/],
    [['feedback', 'receive', '--open'], /--open belongs to wf feedback list/],
    [['feedback', 'list', '--rotate'], /--rotate belongs to wf feedback setup/],
    [['feedback', 'inbox'], /Use wf feedback setup, receive, status, list/],
  ] as const) {
    const result = await wf([...args], { info: null });
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.err, message);
    assert.deepEqual(result.reads, [], 'nothing was read or connected');
  }
});
