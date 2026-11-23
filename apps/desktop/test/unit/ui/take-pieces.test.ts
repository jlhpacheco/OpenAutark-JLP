// B-082 decision 7 (ui/lib/take-pieces.ts): a running take is cut at a pause once a piece is 25 s long, at the
// quietest 300 ms of the last 8 s at 90 s; pauses above 1.2 s shrink to 0.6 s (never soft speech, the floor adapts to
// room noise); joinPieces joins texts with one space and moves the marks along.
// Owns: these assertions only. Never: a microphone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PieceCutter, joinPieces, pcmLevel, type Piece } from '../../../src/ui/lib/take-pieces.ts';

const BLOCK_MS = 32;

/** One 32 ms block of 16 kHz PCM16 at a constant level (its RMS). */
function block(level: number): Uint8Array {
  const out = new Uint8Array(512 * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < 512; index++) view.setInt16(index * 2, Math.round(level * 32767) * (index % 2 ? 1 : -1), true);
  return out;
}

/** Pushes `ms` of `level`; the pieces that came out. */
function feed(cutter: PieceCutter, ms: number, level: number): Piece[] {
  const out: Piece[] = [];
  for (let at = 0; at < ms; at += BLOCK_MS) { const piece = cutter.push(block(level)); if (piece) out.push(piece); }
  return out;
}

const SPEECH = 0.25;

test('pcmLevel is the RMS of PCM16 bytes', () => {
  assert.ok(Math.abs(pcmLevel(block(0.25)) - 0.25) < 0.001);
  assert.equal(pcmLevel(new Uint8Array(0)), 0);
  assert.equal(pcmLevel(block(0)), 0);
});

test('no cut before 25 s; a short pause stays whole', () => {
  const cutter = new PieceCutter();
  assert.deepEqual([...feed(cutter, 20_000, SPEECH), ...feed(cutter, 1_000, 0), ...feed(cutter, 3_000, SPEECH)], []);
  const last = cutter.flush();
  assert.ok(last && Math.abs(last.ms - 24_000) < 100, `everything kept: ${last?.ms}`);
  assert.equal(cutter.flush(), null);
});

test('after 25 s the take is cut in the middle of the next 600 ms pause', () => {
  const cutter = new PieceCutter();
  assert.deepEqual(feed(cutter, 26_000, SPEECH), []);
  const pieces = feed(cutter, 700, 0);
  assert.equal(pieces.length, 1);
  const first = pieces[0];
  assert.ok(first.ms > 26_000 + 280 && first.ms < 26_000 + 400, `ends 300 ms into the pause: ${first.ms}`);
  assert.deepEqual(feed(cutter, 2_000, SPEECH), []);
  const rest = cutter.flush();
  assert.ok(rest && rest.ms > 2_000 && rest.ms < 2_500, `the rest of the pause and the next words: ${rest?.ms}`);
});

test('at 90 s without a pause the cut goes to the quietest 300 ms of the last 8 s', () => {
  const cutter = new PieceCutter();
  feed(cutter, 85_000, SPEECH);
  feed(cutter, 320, 0.05); // softer, but speech – not a pause
  const pieces = feed(cutter, 6_000, SPEECH);
  assert.equal(pieces.length, 1);
  assert.ok(Math.abs(pieces[0].ms - 85_160) < 100, `cut in the soft dip: ${pieces[0].ms}`);
  const rest = cutter.flush();
  assert.ok(rest && rest.ms > 5_000);
});

test('pauses over 1.2 s shrink to 0.6 s (half at each edge); soft speech and short pauses stay', () => {
  const cutter = new PieceCutter();
  feed(cutter, 2_000, SPEECH);
  feed(cutter, 3_000, 0);
  feed(cutter, 2_000, SPEECH);
  feed(cutter, 1_000, 0);
  feed(cutter, 2_000, 0.03); // soft speech above the quiet level
  const piece = cutter.flush();
  const expected = 2_000 + 640 + 2_000 + 1_000 + 2_000;
  assert.ok(piece && Math.abs(piece.ms - expected) < 100, `${piece?.ms} ≈ ${expected}`);
  const bytes = piece.pcm.reduce((total, chunk) => total + chunk.byteLength, 0);
  assert.equal(bytes, Math.round(piece.ms * 32));
});

test('a long silence never becomes a stream of silent pieces (review: 300 ms pieces every few blocks after 25 s of quiet)', () => {
  const cutter = new PieceCutter();
  assert.deepEqual(feed(cutter, 60_000, 0), [], 'a minute of silence at the start: no piece');
  const after = new PieceCutter();
  feed(after, 26_000, SPEECH);
  const pieces = feed(after, 60_000, 0);
  assert.equal(pieces.length, 1, 'one cut at the pause, then nothing while it stays quiet');
  feed(after, 2_000, SPEECH);
  const rest = after.flush();
  assert.ok(rest && rest.ms > 2_000 + 500 && rest.ms <= 2_016 + 1_232, `the pause shrank (at most 1.2 s left), the words stayed: ${rest?.ms}`);
});

test('the quiet level adapts to room noise (noise is a pause, speech never)', () => {
  const cutter = new PieceCutter();
  feed(cutter, 1_000, 0.009); // a fan: the floor (above the quiet minimum)
  feed(cutter, 2_000, SPEECH);
  feed(cutter, 3_000, 0.009);
  feed(cutter, 2_000, SPEECH);
  const piece = cutter.flush();
  assert.ok(piece && Math.abs(piece.ms - (1_000 + 2_000 + 640 + 2_000)) < 100, `${piece?.ms}`);
});

test('joinPieces: trimmed texts with one space, marks moved along, empty pieces skipped', () => {
  const span = (start: number, end: number) => ({ start, end, pct: 50, alts: [{ t: 'x', pct: 30 }] });
  const joined = joinPieces([
    { text: 'Hello world', marks: { uncertain: [span(6, 11)] } },
    { text: '   ' },
    { text: '  again here ', marks: { uncertain: [span(2, 7)], dictated: [{ start: 2, end: 12 }] } },
  ]);
  assert.equal(joined.text, 'Hello world again here');
  assert.deepEqual(joined.marks?.uncertain?.map((mark) => joined.text.slice(mark.start, mark.end)), ['world', 'again']);
  assert.deepEqual(joined.marks?.dictated, [{ start: 12, end: 22 }]);
  assert.deepEqual(joinPieces([{ text: ' a ' }, { text: 'b' }]), { text: 'a b' });
  assert.deepEqual(joinPieces([]), { text: '' });
});

test('quiet speech in a noisy room is speech, not one long pause (STIMME 21.11.2026: a minute was kept as 1 s)', () => {
  const cutter = new PieceCutter();
  const pieces: Piece[] = [];
  // 60 s of syllables (192 ms at 0.008) with 64 ms gaps over room noise 0.004, a 384 ms breath every 4 s
  for (let at = 0; at < 60_000; at += BLOCK_MS) {
    const breath = at % 4000 >= 3600;
    const piece = cutter.push(block(!breath && at % 256 < 192 ? 0.008 : 0.004));
    if (piece) pieces.push(piece);
  }
  const last = cutter.flush();
  if (last) pieces.push(last);
  const kept = pieces.reduce((sum, piece) => sum + piece.ms, 0);
  assert.ok(kept > 59_000, `the whole take is kept: ${kept} ms`);
  // and a long real silence after quiet speech is still shortened once the voice has fallen away
  const quiet = new PieceCutter();
  feed(quiet, 3_000, 0.008);
  feed(quiet, 40_000, 0.001);
  const rest = quiet.flush();
  assert.ok(rest && rest.ms < 10_000, `the silence shrinks: ${rest?.ms} ms`);
});

test('steady room noise alone (0.008, no speech) is still a pause: a minute of it is never uploaded as pieces', () => {
  const cutter = new PieceCutter();
  const pieces = feed(cutter, 60_000, 0.008);
  const last = cutter.flush();
  assert.deepEqual(pieces, [], 'no piece of noise while recording');
  assert.ok(last && last.ms <= 1_300, `only the last moment is left: ${last?.ms} ms`); // the pause trim's own bound (≈ LONG_PAUSE_MS)
});
