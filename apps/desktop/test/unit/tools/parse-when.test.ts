// The agents' one time reader (src/runtime/tools/builtin/util.ts parseWhen, Quests round 20.11.2026): ISO with a zone as
// written, a zone-less ISO time or date as a wall time in the given zone (a bare date at 00:00 there, not UTC), and words
// through the app's one finder (shared/text/when.ts) when they are exactly one time phrase – two phrases or words left
// over are no time; Date.parse's lenient guesses ("1", "2026", "foo 2026") are none either.
// Owns: these assertions only. Never: a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../../../src/runtime/tools/builtin/util.ts';

const TZ = 'Europe/Berlin';
const NOW = Date.UTC(2026, 10, 20, 9, 0); // Fri 20.11.2026, 10:00 in Berlin

test('ISO: a zone as written; without one a wall time in the zone; a bare date is 00:00 there', () => {
  assert.equal(parseWhen('2026-11-24T09:00:00Z', NOW, TZ), Date.UTC(2026, 10, 24, 9, 0));
  assert.equal(parseWhen('2026-11-24T09:00:00.000+02:00', NOW, TZ), Date.UTC(2026, 10, 24, 7, 0));
  assert.equal(parseWhen('Tue, 24 Nov 2026 09:00:00 GMT', NOW, TZ), Date.UTC(2026, 10, 24, 9, 0));
  assert.equal(parseWhen('2026-11-24T09:00', NOW, TZ), Date.UTC(2026, 10, 24, 8, 0));
  assert.equal(parseWhen('2026-11-24 09:00:30.5', NOW, TZ), Date.UTC(2026, 10, 24, 8, 0, 30, 500));
  assert.equal(parseWhen('2026-11-24', NOW, TZ), Date.UTC(2026, 10, 23, 23, 0));
  assert.equal(parseWhen('2026-11-24', NOW, 'America/New_York'), Date.UTC(2026, 10, 24, 5, 0));
  assert.equal(parseWhen('2026-02-30', NOW, TZ), undefined);
  assert.equal(parseWhen('2026-11-24T24:00', NOW, TZ), undefined);
});

test('words: exactly one time phrase is that time', () => {
  assert.equal(parseWhen('tomorrow 9:00', NOW, TZ), Date.UTC(2026, 10, 21, 8, 0));
  assert.equal(parseWhen('morgen um 9', NOW, TZ), Date.UTC(2026, 10, 21, 8, 0));
  assert.equal(parseWhen('Fr 15 Uhr', NOW, TZ), Date.UTC(2026, 10, 20, 14, 0));
  assert.equal(parseWhen('on Monday', NOW, TZ), Date.UTC(2026, 10, 22, 23, 0));
  assert.equal(parseWhen('am 24.12.', NOW, TZ), Date.UTC(2026, 11, 23, 23, 0));
  assert.equal(parseWhen('in 20 min', NOW, TZ), NOW + 20 * 60_000);
  assert.equal(parseWhen('in 2 Stunden', NOW, TZ), NOW + 2 * 3_600_000);
});

test('no time: two phrases, words left over, and the lenient guesses Date.parse used to make', () => {
  for (const value of ['morgen oder Freitag', 'tomorrow morning-ish', 'tomorrow-ish', 'soon', 'call Paul tomorrow', '1', '12', '2026', 'foo 2026', 'Version 0.3.15']) {
    assert.equal(parseWhen(value, NOW, TZ), undefined, value);
  }
});

test('the forms it read before stay as they were', () => {
  assert.equal(parseWhen(NOW + 5, NOW), NOW + 5);
  assert.equal(parseWhen('PT2H', NOW), NOW + 2 * 3_600_000);
  assert.equal(parseWhen('+24h', NOW), NOW + 24 * 3_600_000);
  assert.equal(parseWhen('in 30m', NOW), NOW + 30 * 60_000);
  assert.equal(parseWhen('2d', NOW), NOW + 2 * 86_400_000);
  assert.equal(parseWhen('in 2 days', NOW), NOW + 2 * 86_400_000, 'the strict relative form stays exact');
});
