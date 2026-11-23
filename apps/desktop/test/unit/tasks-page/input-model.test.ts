// The input line's time rule (src/ui/tasks/input-model.ts; owner 20.11.2026: "morgen … dass am Freitag" must not be
// read as Friday): a single phrase with a clock time is used at once and its × drops it; a day alone ("Freitag",
// "morgen") or two or more phrases are offered until the person picks one; Enter makes one to-do per non-empty line,
// each title without the used phrase when it stands in that line; a calendar slot gives every line its time (the used
// phrase still leaves its title); the hint under the line says which way it goes; a day alone is that day without
// minutes, a clock time at 00:00 carries minutes so it stays a time; the detail's time field sends the same rule as a
// patch. Phrases come from the real finder.
// Owns: these assertions only. Never: the DOM, rpc or a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTimes } from '../../../src/shared/text/when.ts';
import { NO_CHOICE, drop, lineHint, lineTodos, pick, timePatch, usedPhrase } from '../../../src/ui/tasks/input-model.ts';

const TZ = 'Europe/Berlin';
const H = 3_600_000;
const MIDNIGHT = Date.UTC(2026, 10, 19, 23); // Fri 20 Nov 2026 00:00 in Berlin
const NOW = MIDNIGHT + 9 * H + 40 * 60_000;
const times = (text: string) => findTimes(text, NOW, TZ);

test('one phrase with a clock time is used at once; its × drops it and a click on it uses it again', () => {
  const text = 'Steuerberater anrufen morgen um 10';
  const phrases = times(text);
  assert.equal(phrases.length, 1);
  const used = usedPhrase(phrases, NO_CHOICE);
  assert.equal(used?.at, MIDNIGHT + 34 * H, 'tomorrow 10:00');
  assert.deepEqual(lineTodos(text, used), [{ title: 'Steuerberater anrufen', at: MIDNIGHT + 34 * H }]);
  const dropped = drop(NO_CHOICE, phrases[0]);
  assert.equal(usedPhrase(phrases, dropped), undefined, '× : no time');
  assert.deepEqual(lineTodos(text, undefined), [{ title: text }], 'the title keeps every word then');
  assert.equal(usedPhrase(phrases, pick(dropped, phrases[0]))?.at, MIDNIGHT + 34 * H, 'picked again');
});

test('a day alone is only offered: one click uses it, else the assistant decides (the owner\'s line without "morgen")', () => {
  const text = 'Person XY schreiben, dass wir am Freitag einen Call haben';
  const phrases = times(text);
  assert.deepEqual(phrases.map((phrase) => [phrase.text, phrase.allDay]), [['Freitag', true]]);
  assert.equal(usedPhrase(phrases, NO_CHOICE), undefined, 'not taken at once');
  assert.deepEqual(lineTodos(text, undefined), [{ title: text }], 'the line stays whole for the assistant');
  assert.equal(lineHint(text, phrases, undefined), 'Click the day to use it – or the assistant decides');
  const friday = usedPhrase(phrases, pick(NO_CHOICE, phrases[0]));
  assert.deepEqual(lineTodos(text, friday, undefined, TZ), [{ title: 'Person XY schreiben, dass wir einen Call haben', at: friday!.at }], 'clicked: that day, without minutes');
  assert.equal(usedPhrase(times('Steuer morgen'), NO_CHOICE), undefined, '"morgen" alone waits too');
});

test('the owner\'s sentence: two phrases, none used until the person picks one', () => {
  const text = 'ich muss morgen Person XY schreiben, dass wir am Freitag einen Call haben';
  const phrases = times(text);
  assert.equal(phrases.length, 2, phrases.map((phrase) => phrase.text).join(' | '));
  assert.equal(usedPhrase(phrases, NO_CHOICE), undefined);
  assert.equal(lineHint(text, phrases, undefined), 'Pick the time you mean – or the assistant decides');
  const tomorrow = usedPhrase(phrases, pick(NO_CHOICE, phrases[0]));
  assert.equal(tomorrow?.text, 'morgen');
  assert.equal(lineTodos(text, tomorrow)[0]?.title, 'ich muss Person XY schreiben, dass wir am Freitag einen Call haben', 'only the picked phrase leaves the title');
});

test('several lines typed or pasted: one to-do per non-empty line, the used phrase only in its own line', () => {
  const text = 'Milch kaufen\n\n  Anna anrufen /18:00\r\nSteuer';
  const used = usedPhrase(times(text), NO_CHOICE);
  assert.equal(used?.text, '/18:00');
  assert.deepEqual(lineTodos(text, used, undefined, TZ), [{ title: 'Milch kaufen' }, { title: 'Anna anrufen', at: MIDNIGHT + 18 * H }, { title: 'Steuer' }]);
  assert.equal(lineHint(text, times(text), used), '3 to-dos – one per line');
  const slot = MIDNIGHT + 15 * H;
  assert.deepEqual(lineTodos('Eins\nZwei', undefined, slot).map((todo) => [todo.title, todo.at, todo.minutes]), [['Eins', slot, 30], ['Zwei', slot, 30]], 'a slot: every line at its time');
  assert.deepEqual(lineTodos('Milch kaufen Brot holen', undefined), [{ title: 'Milch kaufen Brot holen' }], 'one line (a dictation) stays one to-do');
});

test('a calendar slot gives the time; Enter on an empty line makes nothing; the hint follows the line', () => {
  const slot = MIDNIGHT + 15 * H;
  assert.deepEqual(lineTodos('Anna anrufen', undefined, slot), [{ title: 'Anna anrufen', at: slot, minutes: 30 }]);
  const text = 'Anna anrufen /18:00';
  const used = usedPhrase(times(text), NO_CHOICE);
  assert.deepEqual(lineTodos(text, used, slot), [{ title: 'Anna anrufen', at: slot, minutes: 30 }], 'the slot wins, the phrase still leaves the title');
  assert.deepEqual(lineTodos('   \n ', undefined), []);
  assert.equal(lineHint('', [], undefined), 'A time in your words goes on the calendar · /15:00 works too');
  assert.equal(lineHint(text, times(text), used), 'or click a time in the calendar');
  assert.match(lineHint('Milch kaufen', [], undefined), /^No time – it goes on your list/);
});

test('a picked day is that day without minutes; a clock time at 00:00 carries minutes, so it stays a time', () => {
  const phrases = times('Steuer morgen');
  const day = usedPhrase(phrases, pick(NO_CHOICE, phrases[0]));
  assert.deepEqual(lineTodos('Steuer morgen', day, undefined, TZ), [{ title: 'Steuer', at: MIDNIGHT + 24 * H }]);
  const midnight = usedPhrase(times('Backup /00:00'), NO_CHOICE);
  assert.equal(midnight?.allDay, undefined, 'a clock time');
  assert.deepEqual(lineTodos('Backup /00:00', midnight, undefined, TZ), [{ title: 'Backup', at: midnight!.at, minutes: 30 }]);
});

test('the detail\'s time field: a clock time keeps the to-do\'s length, a day alone has none, nothing clears it', () => {
  const [clock] = times('morgen 15 Uhr');
  assert.deepEqual(timePatch({ minutes: 45 }, clock, TZ), { at: MIDNIGHT + 39 * H, minutes: 45 });
  assert.deepEqual(timePatch({}, clock, TZ), { at: MIDNIGHT + 39 * H, minutes: null });
  const [day] = times('Montag');
  assert.deepEqual(timePatch({ minutes: 45 }, day, TZ), { at: day.at, minutes: null }, 'that day, no time');
  assert.deepEqual(timePatch({ minutes: 45 }, null, TZ), { at: null, minutes: null });
  const [midnight] = times('/00:00');
  assert.deepEqual(timePatch({}, midnight, TZ), { at: midnight.at, minutes: 30 }, '00:00 stays a time');
});
