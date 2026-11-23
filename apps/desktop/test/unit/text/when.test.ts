// The one time finder for free text (src/shared/text/when.ts, Quests round 20.11.2026): every phrase with its span and
// the moment it means in Europe/Berlin – the slash form, relative times, day words, long and short weekdays, written
// dates, clocks in German and English, a bare hour after a day; the owner's sentence names two phrases; month and year
// rollover, both DST weeks, the hour before 04:00; "Montags" and numbers that are no time; stripTime for the title; the
// app's one zone and date math (wallOf, wallTime with DST gaps east and west of UTC, addDays, weekdayOf).
// Owns: these assertions only. Never: a real clock (now is fixed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, findTimes, stripTime, wallOf, wallTime, weekdayOf } from '../../../src/shared/text/when.ts';

const TZ = 'Europe/Berlin';
const M = 60_000;
const NOW = Date.UTC(2026, 10, 20, 9, 0); // Fri 20.11.2026, 10:00 in Berlin (CET, +01:00)
/** Epoch ms of a Berlin wall time. */
const berlin = (date: string, clock = '00:00') => wallTime(date, Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)), TZ);

/** The phrases of `text` as "[text] → moment" lines (a day without a time ends in " day"). */
function read(text: string, now = NOW): string[] {
  return findTimes(text, now, TZ).map((phrase) => {
    const wall = wallOf(phrase.at, TZ);
    const clock = `${String(Math.floor(wall.minutes / 60)).padStart(2, '0')}:${String(wall.minutes % 60).padStart(2, '0')}`;
    return `[${phrase.text}] ${wall.date}${phrase.allDay ? ' day' : ` ${clock}`}`;
  });
}

test("the owner's sentence names two phrases – morgen and Freitag – with their spans", () => {
  const text = 'ich muss morgen Person XY schreiben, dass am Freitag wir einen Call haben';
  const found = findTimes(text, NOW, TZ);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(({ start, end, text: written }) => ({ start, end, written })), [
    { start: text.indexOf('morgen'), end: text.indexOf('morgen') + 6, written: 'morgen' },
    { start: text.indexOf('Freitag'), end: text.indexOf('Freitag') + 7, written: 'Freitag' },
  ]);
  assert.equal(found[0].at, berlin('2026-11-21'));
  assert.equal(found[0].allDay, true);
  assert.equal(found[1].at, berlin('2026-11-27'), 'Friday said on a Friday without a time is next week');
  assert.deepEqual(found.map((phrase) => phrase.allDay), [true, true], 'both are days only: the line offers them, uses neither');
  assert.equal(stripTime(text, found[0]), 'ich muss Person XY schreiben, dass am Freitag wir einen Call haben');
  assert.equal(stripTime(text, found[1]), 'ich muss morgen Person XY schreiben, dass wir einen Call haben');
});

test('slash form and relative times: exact minutes and hours, days and weeks as that day', () => {
  assert.deepEqual(read('/15:00 Paul anrufen'), ['[/15:00] 2026-11-20 15:00']);
  assert.deepEqual(read('Paul anrufen /9'), ['[/9] 2026-11-21 09:00'], 'an hour already past today is tomorrow');
  assert.equal(findTimes('in 20 min', NOW, TZ)[0].at, NOW + 20 * M);
  assert.equal(findTimes('in 2 h', NOW, TZ)[0].at, NOW + 120 * M);
  assert.equal(findTimes('in 1,5 Stunden', NOW, TZ)[0].at, NOW + 90 * M);
  assert.equal(findTimes('in einer halben Stunde', NOW, TZ)[0].at, NOW + 30 * M);
  assert.equal(findTimes('in half an hour', NOW, TZ)[0].at, NOW + 30 * M);
  assert.equal(findTimes('in zwei Stunden', NOW, TZ)[0].at, NOW + 120 * M);
  assert.deepEqual(read('in 3 Tagen'), ['[in 3 Tagen] 2026-11-23 day']);
  assert.deepEqual(read('in 2 days'), ['[in 2 days] 2026-11-22 day']);
  assert.deepEqual(read('in einer Woche'), ['[in einer Woche] 2026-11-27 day']);
  assert.deepEqual(read('in 3 Tagen um 10'), ['[in 3 Tagen um 10] 2026-11-23 10:00']);
  assert.deepEqual(read('in der Küche'), []);
  assert.deepEqual(read('in ad hoc meetings'), [], 'a number word needs its space: "in a d…" is no day');
  assert.equal(findTimes('in 2h', NOW, TZ)[0].at, NOW + 120 * M, 'digits may touch their unit');
  assert.equal(findTimes('in 10m', NOW, TZ)[0].at, NOW + 10 * M, '"in 10m": minutes');
  assert.deepEqual(read('in 10 m Höhe'), [], 'a spaced "m" is metres');
  assert.deepEqual(findTimes('back in 20 min', NOW, TZ).map((phrase) => phrase.fromNow), [true], 'a length from now is marked');
  assert.deepEqual(findTimes('in 3 Tagen um 10 oder um 9', NOW, TZ).map((phrase) => phrase.fromNow), [undefined, undefined]);
});

test('day words, unicode-aware: heute, morgen, übermorgen, today, tomorrow, tonight; "Guten Morgen" and "heute morgen" are no tomorrow', () => {
  assert.deepEqual(read('heute'), ['[heute] 2026-11-20 day']);
  assert.deepEqual(read('Morgen Paul anrufen'), ['[Morgen] 2026-11-21 day']);
  assert.deepEqual(read('übermorgen um 15 Uhr'), ['[übermorgen um 15 Uhr] 2026-11-22 15:00']);
  assert.deepEqual(read('uebermorgen'), ['[uebermorgen] 2026-11-22 day']);
  assert.deepEqual(read('tomorrow at 9am'), ['[tomorrow at 9am] 2026-11-21 09:00']);
  assert.deepEqual(read('the day after tomorrow'), ['[the day after tomorrow] 2026-11-22 day']);
  assert.deepEqual(read('tonight at 8'), ['[tonight at 8] 2026-11-20 20:00']);
  assert.deepEqual(read('Guten Morgen Paul'), []);
  assert.deepEqual(read('heute morgen war es kalt'), ['[heute morgen] 2026-11-20 day']);
  assert.deepEqual(read('Morgenrunde, morgens, heutige'), []);
});

test('weekdays: long ones anywhere, short ones only before a number; "Montags" is a habit; a past time today is next week', () => {
  assert.deepEqual(read('Montag'), ['[Montag] 2026-11-23 day']);
  assert.deepEqual(read('Montags Sport'), []);
  assert.deepEqual(read('Freitag um 11'), ['[Freitag um 11] 2026-11-20 11:00'], "today's weekday with a time still to come is today");
  assert.deepEqual(read('Freitag um 9'), ['[Freitag um 9] 2026-11-27 09:00'], "today's weekday at a past time is next week's");
  assert.deepEqual(read('nächsten Freitag'), ['[nächsten Freitag] 2026-11-27 day']);
  assert.deepEqual(read('diesen Freitag'), ['[diesen Freitag] 2026-11-20 day']);
  assert.deepEqual(read('Freitag'), ['[Freitag] 2026-11-27 day'], "today's weekday said bare is next week's");
  assert.deepEqual(read('this Friday'), ['[this Friday] 2026-11-20 day']);
  assert.deepEqual(read('am Fr 9'), ['[Fr 9] 2026-11-27 09:00']);
  assert.deepEqual(read('next Monday 3pm'), ['[next Monday 3pm] 2026-11-23 15:00']);
  assert.deepEqual(read('Freitagabend um 8'), ['[Freitagabend um 8] 2026-11-20 20:00']);
  assert.deepEqual(read('Fr 9'), ['[Fr 9] 2026-11-27 09:00']);
  assert.deepEqual(read('Di 14:30 Zahnarzt'), ['[Di 14:30] 2026-11-24 14:30']);
  assert.deepEqual(read('Mo 24.11.'), ['[Mo 24.11.] 2026-11-24 day'], 'the written date wins over the weekday next to it');
  assert.deepEqual(read('Fri 3pm'), ['[Fri 3pm] 2026-11-20 15:00']);
  assert.deepEqual(read('meet on Tue'), ['[Tue] 2026-11-24 day']);
  assert.deepEqual(read('Fr ist frei, Mo auch'), [], 'a short weekday without a number is none');
  assert.deepEqual(read('so 3 Leute, do 10 push-ups'), [], '"so" and "do" are everyday words unless written "So", "Do"');
  assert.deepEqual(read('So 10'), ['[So 10] 2026-11-22 10:00']);
});

test('written dates: dd.mm., dd.mm.yyyy, ISO, month names; a passed date without a year is next year; an impossible one is none', () => {
  assert.deepEqual(read('am 24.12.'), ['[24.12.] 2026-12-24 day']);
  assert.deepEqual(read('24.12.2026 18:00'), ['[24.12.2026 18:00] 2026-12-24 18:00']);
  assert.deepEqual(read('am 24.12. um 18 Uhr'), ['[24.12. um 18 Uhr] 2026-12-24 18:00']);
  assert.deepEqual(read('bis 1.10.'), ['[1.10.] 2027-10-01 day'], 'passed this year: next year');
  assert.deepEqual(read('ab 1.10. geht es los'), ['[1.10.] 2027-10-01 day'], '"ab 1.10." is a date, not 1:10');
  assert.deepEqual(read('20.11.'), ['[20.11.] 2026-11-20 day'], 'today counts');
  assert.deepEqual(read('3.4.27'), ['[3.4.27] 2027-04-03 day']);
  assert.deepEqual(read('2026-11-24T09:00'), ['[2026-11-24T09:00] 2026-11-24 09:00']);
  assert.deepEqual(read('24. Dezember 2026 um 10'), ['[24. Dezember 2026 um 10] 2026-12-24 10:00']);
  assert.deepEqual(read('December 24th'), ['[December 24th] 2026-12-24 day']);
  assert.deepEqual(read('3. März'), ['[3. März] 2027-03-03 day']);
  assert.deepEqual(read('Freitag, den 27.11.'), ['[Freitag, den 27.11.] 2026-11-27 day']);
  assert.deepEqual(read('Termin am 31.02.'), []);
});

test('clocks: um/at/gegen/ab, HH:MM, HH Uhr, am/pm, number words, a part of the day; German "am" is no a.m.', () => {
  assert.deepEqual(read('um 15:30'), ['[um 15:30] 2026-11-20 15:30']);
  assert.deepEqual(read('um 15.30'), ['[um 15.30] 2026-11-20 15:30']);
  assert.deepEqual(read('gegen 18 Uhr'), ['[gegen 18 Uhr] 2026-11-20 18:00']);
  assert.deepEqual(read('15 Uhr'), ['[15 Uhr] 2026-11-20 15:00']);
  assert.deepEqual(read('9:30'), ['[9:30] 2026-11-21 09:30']);
  assert.deepEqual(read('9am'), ['[9am] 2026-11-21 09:00']);
  assert.deepEqual(read('3 pm'), ['[3 pm] 2026-11-20 15:00']);
  assert.deepEqual(read('12am'), ['[12am] 2026-11-21 00:00']);
  assert.deepEqual(read('12 pm'), ['[12 pm] 2026-11-20 12:00']);
  assert.deepEqual(read('at 3:30pm'), ['[at 3:30pm] 2026-11-20 15:30']);
  assert.deepEqual(read('zehn Uhr'), ['[zehn Uhr] 2026-11-21 10:00']);
  assert.deepEqual(read('um zwölf'), ['[um zwölf] 2026-11-20 12:00']);
  assert.deepEqual(read('8 Uhr abends'), ['[8 Uhr abends] 2026-11-20 20:00']);
  assert.deepEqual(read('heute Abend um 8'), ['[heute Abend um 8] 2026-11-20 20:00']);
  assert.deepEqual(read('um 12 am Montag'), ['[um 12 am Montag] 2026-11-23 12:00']);
  assert.deepEqual(read('um 25 Uhr'), []);
  assert.deepEqual(read('at one point'), []);
});

test('a bare hour after a day: "morgen 10", "Freitag 10." – but not "morgen 3 Belege"', () => {
  assert.deepEqual(read('morgen 10'), ['[morgen 10] 2026-11-21 10:00']);
  assert.deepEqual(read('Freitag 10.'), ['[Freitag 10] 2026-11-27 10:00']);
  assert.deepEqual(read('morgen 9.30, dann Mittag'), ['[morgen 9.30] 2026-11-21 09:30']);
  assert.deepEqual(read('morgen 3 Belege hochladen'), ['[morgen] 2026-11-21 day']);
  assert.deepEqual(read('Freitag 10 Meeting'), ['[Freitag] 2026-11-27 day']);
});

test('numbers that are no time: counts, versions, years, links', () => {
  for (const text of ['3 Belege', 'Version 0.3.15', 'v1.2.30', '2026', 'um 2026', 'Seite 12', '3,5 Stunden Arbeit', 'see https://x.io/15:00 then', 'Kapitel 3 am Ende']) {
    assert.deepEqual(read(text), [], text);
  }
  assert.deepEqual(read('Kapitel 3 am Montag lesen'), ['[Montag] 2026-11-23 day']);
});

test('several phrases stay several; parts next to each other are one', () => {
  assert.deepEqual(read('Montag oder Dienstag um 10'), ['[Montag] 2026-11-23 day', '[Dienstag um 10] 2026-11-24 10:00']);
  assert.deepEqual(read('morgen Paul um 10 anrufen'), ['[morgen] 2026-11-21 day', '[um 10] 2026-11-21 10:00']);
  assert.deepEqual(read('10 Uhr am Freitag'), ['[10 Uhr am Freitag] 2026-11-27 10:00']);
});

test('month and year rollover', () => {
  const lastOfNovember = Date.UTC(2026, 10, 30, 11, 0);
  assert.deepEqual(read('morgen', lastOfNovember), ['[morgen] 2026-12-01 day']);
  const newYearsEve = Date.UTC(2026, 11, 31, 11, 0);
  assert.deepEqual(read('übermorgen', newYearsEve), ['[übermorgen] 2027-01-02 day']);
  assert.deepEqual(read('in 3 Tagen', newYearsEve), ['[in 3 Tagen] 2027-01-03 day']);
  assert.deepEqual(read('05.01.', newYearsEve), ['[05.01.] 2027-01-05 day']);
  assert.deepEqual(read('30.12.', newYearsEve), ['[30.12.] 2027-12-30 day']);
  assert.deepEqual(read('Freitag', newYearsEve), ['[Freitag] 2027-01-01 day']);
});

test('DST weeks: wall times stay wall times across the change; a skipped one moves on by the gap', () => {
  const beforeAutumn = Date.UTC(2026, 9, 24, 10, 0); // Sat 24.10., 12:00 CEST; clocks go back on 25.10.
  assert.equal(findTimes('morgen um 10', beforeAutumn, TZ)[0].at, Date.UTC(2026, 9, 25, 9, 0), 'CET');
  assert.equal(findTimes('Montag 9 Uhr', beforeAutumn, TZ)[0].at, Date.UTC(2026, 9, 26, 8, 0));
  assert.equal(findTimes('in 3 Tagen', beforeAutumn, TZ)[0].at, Date.UTC(2026, 9, 26, 23, 0), 'the start of a CET day');
  assert.equal(findTimes('in 2 h', beforeAutumn, TZ)[0].at, beforeAutumn + 120 * M, 'relative stays exact');
  const beforeSpring = Date.UTC(2027, 2, 27, 11, 0); // Sat 27.03.2027; clocks go forward on 28.03.
  assert.equal(findTimes('morgen um 10', beforeSpring, TZ)[0].at, Date.UTC(2027, 2, 28, 8, 0), 'CEST');
  assert.equal(findTimes('Sonntag um 2:30', beforeSpring, TZ)[0].at, Date.UTC(2027, 2, 28, 1, 30), '02:30 does not exist: 03:30 CEST');
});

test('before 04:00 "morgen" is the coming day – the person has not slept yet', () => {
  const night = Date.UTC(2026, 10, 21, 0, 30); // Sat 21.11., 01:30 in Berlin
  assert.deepEqual(read('morgen um 10', night), ['[morgen um 10] 2026-11-21 10:00']);
  assert.deepEqual(read('übermorgen', night), ['[übermorgen] 2026-11-22 day']);
  assert.deepEqual(read('heute', night), ['[heute] 2026-11-21 day']);
});

test('another zone reads the same words in its own wall time; an unknown zone reads as this process', () => {
  assert.equal(findTimes('morgen um 10', NOW, 'America/New_York')[0].at, Date.UTC(2026, 10, 21, 15, 0));
  assert.doesNotThrow(() => findTimes('morgen um 10', NOW, 'Not/AZone'));
});

test('spans point into the original text, umlauts, ß and combining marks included', () => {
  const text = 'Straße fegen übermorgen';
  const [phrase] = findTimes(text, NOW, TZ);
  assert.equal(text.slice(phrase.start, phrase.end), 'übermorgen');
  const decomposed = 'Muss übermorgen weg';
  const [split] = findTimes(decomposed, NOW, TZ);
  assert.equal(decomposed.slice(split.start, split.end), 'übermorgen');
});

test('wallOf: local date, minute of the day (midnight is 0, not 24) and weekday; an unknown zone reads as this process', () => {
  assert.deepEqual(wallOf(Date.UTC(2026, 9, 24, 22, 0), TZ), { date: '2026-10-25', minutes: 0, weekday: 0 });
  assert.deepEqual(wallOf(Date.UTC(2026, 9, 24, 22, 0), 'UTC'), { date: '2026-10-24', minutes: 22 * 60, weekday: 6 });
  assert.deepEqual(wallOf(Date.UTC(2026, 9, 25, 23, 59), TZ), { date: '2026-10-26', minutes: 59, weekday: 1 });
  assert.deepEqual(wallOf(Date.UTC(2026, 9, 24, 22, 30), 'America/New_York'), { date: '2026-10-24', minutes: 18 * 60 + 30, weekday: 6 });
  assert.deepEqual(wallOf(NOW, 'Not/AZone'), wallOf(NOW));
});

test('wallTime across DST: wall times stay; a skipped one moves on by the gap east and west of UTC, also a skipped midnight', () => {
  assert.equal(wallTime('2026-10-24', 9 * 60, TZ), Date.UTC(2026, 9, 24, 7, 0), 'CEST: UTC+2');
  assert.equal(wallTime('2026-10-25', 9 * 60, TZ), Date.UTC(2026, 9, 25, 8, 0), 'CET: UTC+1 the day it changes');
  assert.equal(wallTime('2026-10-24', 9 * 60, 'America/New_York'), Date.UTC(2026, 9, 24, 13, 0));
  assert.equal(wallTime('2026-03-29', 150, TZ), Date.UTC(2026, 2, 29, 1, 30), 'Berlin 02:30 is skipped: 03:30 CEST');
  assert.equal(wallTime('2026-03-08', 150, 'America/New_York'), Date.UTC(2026, 2, 8, 7, 30), 'New York 02:30 is skipped: 03:30 EDT');
  assert.equal(wallTime('2026-09-06', 0, 'America/Santiago'), Date.UTC(2026, 8, 6, 4, 0), 'Santiago skips midnight: the day starts at 01:00');
  assert.equal(wallTime('2026-03-08', 0, 'America/Havana'), Date.UTC(2026, 2, 8, 5, 0), 'Havana skips midnight: 01:00');
  assert.equal(wallTime('2026-04-05', 0, 'America/Santiago'), Date.UTC(2026, 3, 5, 4, 0), 'a midnight after a repeated hour: the new day');
  assert.equal(wallTime('2026-04-06', 0, 'Australia/Lord_Howe'), Date.UTC(2026, 3, 5, 13, 30), 'a 30-minute change');
  assert.equal(wallTime('2026-10-25', 150, TZ), Date.UTC(2026, 9, 25, 1, 30), 'a repeated 02:30 is one of its two instants');
});

test('addDays crosses months and years; weekdayOf names Sunday 0', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOf('2026-11-01'), 0);
  assert.equal(weekdayOf('2026-10-31'), 6);
});

test('stripTime: the phrase and a preposition before it go, the rest is tidied', () => {
  const strip = (text: string) => stripTime(text, findTimes(text, NOW, TZ)[0]);
  assert.equal(strip('Paul am Freitag anrufen'), 'Paul anrufen');
  assert.equal(strip('Zahnarzt um 15 Uhr'), 'Zahnarzt');
  assert.equal(strip('Morgen, 9 Uhr: Paul'), 'Paul');
  assert.equal(strip('Paul anrufen – morgen'), 'Paul anrufen');
  assert.equal(strip('Bericht bis Freitag, den 27.11. fertig'), 'Bericht fertig');
  assert.equal(strip('Report for tomorrow 9am, then lunch'), 'Report, then lunch');
  assert.equal(strip('Freitag 10.'), '');
  assert.equal(stripTime('ohne Zeit', { start: 4, end: 4 }), 'ohne Zeit');
});
