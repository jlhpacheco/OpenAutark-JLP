// The one time finder for free text, German and English (Quests round 20.11.2026, the design page's parseWhen grown up):
// every phrase that names a time – "/15:00", "in 20 min", "in 3 Tagen", "heute", "morgen um 10", "Fr 9", "am Freitag",
// "next Monday 3pm", "24.12.", "24. Dezember", "um 15:30", "15 Uhr", "9am" – with its span in the text and the moment it
// means in the person's zone. A day without a time is that whole day (allDay; `at` is its start) – the input line offers
// such a phrase instead of using it, a phrase with a clock time it uses at once. Today's weekday said bare means next
// week ("Freitag" on a Friday); with a clock time still to come today, or as "diesen Freitag", it is today. A phrase is one
// contiguous span, so "ich muss morgen XY schreiben, dass wir am Freitag einen Call haben" names two – which one the text
// means is the reader's call (the input line uses a phrase only when it is the only one; an agent's `when` must be exactly
// one). stripTime is the text without a used phrase (a to-do's title); wallOf/wallTime/addDays/weekdayOf are the app's one
// zone and date math (the finder's, the schedules', the calendar's and the day settings').
// Owns: the phrase rules, stripTime, wallOf/wallTime/addDays/weekdayOf. Never: a clock (now is given), I/O, or deciding
// between phrases.

import { NUMBER_WORDS } from './durations.ts';
import { DAY_BOUNDARY_HOUR } from '../model/day-settings.ts';

/** One time phrase: where it stands in the text (end exclusive) and the moment it means (epoch ms). */
export interface TimePhrase {
  start: number;
  end: number;
  at: number;
  allDay?: boolean; // a day without a time: `at` is the start of that day
  fromNow?: boolean; // a length from now ("in 20 min"): `at` is now plus it
  text: string; // the phrase as written
}

interface Atom {
  kind: 'day' | 'short' | 'clock' | 'exact';
  start: number; // in the folded text
  end: number;
  date?: string; // a day's calendar date (YYYY-MM-DD)
  dated?: boolean; // written out as a date – it wins over a weekday next to it ("Fr 24.11.")
  weekday?: number; // 0 = Sunday
  next?: boolean; // "nächsten Freitag", "next Friday": never today
  thisWeek?: boolean; // "diesen Freitag", "this Friday": today when it is today
  minutes?: number; // a clock's minute of the day
  open?: boolean; // an hour 1–11 without am/pm that "Abend" moves to the afternoon
  evening?: boolean; // "Abend", "tonight", "nachmittags": an open clock in the phrase is p.m.
  at?: number; // an exact moment ("in 20 min")
}

interface Ctx { now: number; zone?: string; today: string; minutes: number; weekday: number; upper: (index: number) => boolean }
type Groups = Record<string, string | undefined>;

const MIN = 60_000;
const B = '(?<![\\p{L}\\p{N}])'; // a word starts (JS \b knows ASCII only)
const E = '(?![\\p{L}\\p{N}])'; // a word ends
const alternation = (map: Readonly<Record<string, number>>) => Object.keys(map).sort((a, b) => b.length - a.length).join('|');

const WEEKDAYS: Readonly<Record<string, number>> = {
  sonntag: 0, sunday: 0, montag: 1, monday: 1, dienstag: 2, tuesday: 2, mittwoch: 3, wednesday: 3, donnerstag: 4, thursday: 4,
  freitag: 5, friday: 5, samstag: 6, sonnabend: 6, saturday: 6,
};
/** Short weekdays: they name a day only before a number ("Fr 9", "Mo 24.11.", "Fri 3pm"). */
const SHORT: Readonly<Record<string, number>> = {
  so: 0, sun: 0, mo: 1, mon: 1, di: 2, tue: 2, tues: 2, mi: 3, wed: 3, do: 4, thu: 4, thur: 4, thurs: 4, fr: 5, fri: 5, sa: 6, sat: 6,
};
/** "so 3 Leute", "do 10 push-ups": these two are everyday words – as weekdays they are written "So", "Do". */
const COMMON_WORDS = new Set(['so', 'do']);
const MONTHS: Readonly<Record<string, number>> = {
  januar: 0, january: 0, jan: 0, februar: 1, february: 1, feb: 1, marz: 2, maerz: 2, march: 2, mar: 2, april: 3, apr: 3, mai: 4,
  may: 4, juni: 5, june: 5, jun: 5, juli: 6, july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8, oktober: 9,
  october: 9, okt: 9, oct: 9, november: 10, nov: 10, dezember: 11, december: 11, dez: 11, dec: 11,
};
const CLOCK_WORDS: Readonly<Record<string, number>> = Object.fromEntries(Object.entries(NUMBER_WORDS).filter(([, n]) => n <= 23));
const AMOUNTS: Readonly<Record<string, number>> = { ...NUMBER_WORDS, ein: 1, eine: 1, einer: 1, einem: 1, einen: 1, a: 1, an: 1 };
const UNITS = 'minuten|minutes|minute|mins|min|stunden|stunde|std|hours|hour|hrs|hr|h|tagen|tage|tag|days|day|d|wochen|woche|weeks|week';
const NEXT = 'naechste[nmrs]?|nachste[nmrs]?|kommende[nmrs]?|diese[nmrs]?|next|this|coming';
const EVENING = 'abends?|nachmittags?|nachts?|evening|afternoon|night';
const PART = `${EVENING}|morgens|fruh|vormittags?|mittags?|morning`;
/** "9 am Freitag" is German "am", not a.m. */
const GERMAN_AM = `\\s+(?:${alternation(WEEKDAYS)}|den|dem|ende|anfang|wochenende|morgen|${PART}|\\d)${E}`;
const MARK = `uhr${E}|o'?clock|a\\.?m${E}\\.?(?!${GERMAN_AM})|p\\.?m${E}\\.?`;
/** After a clock: its mark, then a part of the day ("8 Uhr abends"). */
const TAIL = `(?:\\s*(?<mk>${MARK}))?(?:\\s+(?<pt>${PART})${E})?`;
const HOUR = '(?<h>\\d{1,2})(?::(?<cm>\\d{2})|\\.(?<dm>\\d{2}))?(?!\\d|[.:]\\d)';
const EVENING_IN = new RegExp(`${B}(?:${EVENING}|tonight)${E}`, 'u');
/** What may stand between the parts of one phrase: "morgen um 10", "Freitag, den 24.11.", "heute Abend um 8", ISO's T. */
const GAP = new RegExp(`^(?:[\\s,]|${B}(?:am|on|um|at|den|the|t|${PART})${E})*$`, 'u');
/** A bare hour right after a day ("morgen 10", "Fr 9"); after a long day only at the end of a clause. */
const BARE = /^\s+(?<h>\d{1,2})(?:[.:](?<cm>\d{2}))?(?!\d|[.:]\d)/;
const CLAUSE_END = /^\s*(?:$|[,;:!?)\]–—-]|\.(?!\d))/;
const LEAD = /(?:^|\s)(?:am|um|at|on|gegen|bis|ab|by|until|für|fuer|fur|for)\s+$/iu;

const pattern = (source: string) => new RegExp(source, 'gu');
const RULES: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray, c: Ctx, s: string) => Partial<Atom> | undefined]> = [
  [pattern('(?<=^|\\s)\\/(?<h>\\d{1,2})(?::(?<cm>\\d{2}))?(?=\\s|$)'), (m, _c, s) => clockOf(m, s)],
  [pattern(`${B}in\\s+(?:(\\d+(?:[.,]\\d+)?)\\s*|(${alternation(AMOUNTS)})\\s+)?(halben?\\s+stunde|half\\s+an\\s+hour|${UNITS})${E}`), (m, c) => relative(m[1] ?? m[2], m[3], c)],
  [pattern(`${B}in\\s+(\\d+(?:[.,]\\d+)?)m${E}`), (m, c) => relative(m[1], 'min', c)], // "in 10m" – a spaced "in 10 m" stays metres
  [pattern(`${B}(?<!(?:guten|am|jeden|den|der|dem|im|diesen|einen|schonen)\\s+)(heute\\s+morgen|u(?:e)?bermorgen|(?:the\\s+)?day\\s+after\\s+tomorrow|morgen|tomorrow|heute|today|tonight)${E}`), (m, c) => dayWord(m[1], c)],
  [pattern(`${B}(?:(${NEXT})\\s+)?(${alternation(WEEKDAYS)})(abend|nachmittag|nacht|morgen|vormittag|mittag)?${E}`),
    (m) => ({ kind: 'day', weekday: WEEKDAYS[m[2]], next: !!m[1] && !/^(?:diese|this)/.test(m[1]), thisWeek: !!m[1] && /^(?:diese|this)/.test(m[1]), evening: /^(?:abend|nachmittag|nacht)$/.test(m[3] ?? '') })],
  [pattern(`${B}(?:(next|this)\\s+|(?<=${B}(?:on|by|until|till)\\s+))(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)${E}`), (m) => ({ kind: 'day', weekday: SHORT[m[2]], next: m[1] === 'next', thisWeek: m[1] === 'this' })],
  [pattern(`${B}(${alternation(SHORT)})\\.?(?=,?\\s*\\d)`), (m, c) => (COMMON_WORDS.has(m[1]) && !c.upper(m.index) ? undefined : { kind: 'short', weekday: SHORT[m[1]] })],
  [pattern('(?<![\\p{L}\\p{N}.]|version\\s)(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}|\\d{2})?(?!\\.?\\d)'), (m, c) => dateOf(m[3], Number(m[2]) - 1, Number(m[1]), c)],
  [pattern('(?<![\\p{N}.-])(\\d{4})-(\\d{2})-(\\d{2})(?!\\d)'), (m, c) => dateOf(m[1], Number(m[2]) - 1, Number(m[3]), c)],
  [pattern(`${B}(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s+(?:of\\s+)?(${alternation(MONTHS)})${E}\\.?(?:\\s+(\\d{4})(?!\\d))?`), (m, c) => dateOf(m[3], MONTHS[m[2]], Number(m[1]), c)],
  [pattern(`${B}(${alternation(MONTHS)})${E}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4})(?!\\d))?`), (m, c) => dateOf(m[3], MONTHS[m[1]], Number(m[2]), c)],
  [pattern(`${B}(?:um|at|gegen|ab)\\s+${HOUR}${TAIL}`), (m, _c, s) => clockOf(m, s)],
  [pattern(`(?<![\\p{N}:.,])(?<!\\p{L}(?<!\\dt))(?<h>\\d{1,2}):(?<cm>\\d{2})(?!\\d|:\\d)${TAIL}`), (m, _c, s) => clockOf(m, s)], // ISO's "…24T09:00" too
  [pattern(`(?<![\\p{L}\\p{N}:.,])(?<h>\\d{1,2})(?:\\.(?<dm>\\d{2}))?\\s*(?<mk>${MARK})(?:\\s+(?<pt>${PART})${E})?`), (m, _c, s) => clockOf(m, s)],
  [pattern(`${B}(?:(?:um|gegen|at)\\s+)?(?<w>${alternation(CLOCK_WORDS)})\\s+(?<mk>${MARK})(?:\\s+(?<pt>${PART})${E})?`), (m, _c, s) => clockOf(m, s)],
  [pattern(`${B}(?:um|gegen)\\s+(?<w>${alternation(CLOCK_WORDS)})${E}${TAIL}`), (m, _c, s) => clockOf(m, s)],
];

/** Every time phrase of `text`, in order, with the moment it means at `now` in `zone` (the process zone without one). */
export function findTimes(text: string, now: number, zone?: string): TimePhrase[] {
  const { s, from, to } = fold(text);
  const wall = wallOf(now, zone);
  const c: Ctx = { now, zone, today: wall.date, minutes: wall.minutes, weekday: wall.weekday, upper: (i) => text[from[i]] !== text[from[i]].toLowerCase() };
  const out: TimePhrase[] = [];
  for (const group of join(atomsOf(s, c), s)) {
    const phrase = resolve(group, s, c);
    if (!phrase) continue;
    const start = from[phrase.start];
    const end = to[phrase.end - 1];
    out.push({ start, end, at: phrase.at, ...(phrase.allDay ? { allDay: true } : {}), ...(phrase.fromNow ? { fromNow: true } : {}), text: text.slice(start, end) });
  }
  return out;
}

/** `text` without the phrase at `span` and a preposition right before it (am, um, at, on, gegen, bis, ab, by, until, für, for), tidied. */
export function stripTime(text: string, span: { start: number; end: number }): string {
  const head = text.slice(0, span.start);
  const lead = LEAD.exec(head);
  return `${lead ? head.slice(0, lead.index) : head} ${text.slice(span.end)}`
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/gu, '$1')
    .replace(/^[\s,.;:!?–—-]+|[\s,;:–—-]+$/gu, '');
}

/** The local date (YYYY-MM-DD), minute of the day and weekday (0 = Sunday) of `at` in `zone` (the process zone without one). */
export function wallOf(at: number, zone?: string): { date: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(formatOf(zone).formatToParts(at).map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), weekday: weekdayOf(date) };
}

/**
 * Epoch ms of the wall time `minutes` after local midnight of `date` in `zone`: a wall time a DST change skips moves on by
 * the gap (02:30 on a spring night is 03:30, a skipped midnight is 01:00), a repeated one is one of its two instants.
 */
export function wallTime(date: string, minutes: number, zone?: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * MIN; // the wall time read as if the zone were UTC
  const first = wall - offsetAt(wall, zone);
  const second = wall - offsetAt(first, zone);
  // The two readings differ only next to a DST change; when the second one does not read back as the wall time, the
  // change skips it – the later reading is the one after the gap (east and west of UTC alike).
  return first === second || second + offsetAt(second, zone) === wall ? second : Math.max(first, second);
}

/** `date` (YYYY-MM-DD) plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The weekday of a calendar date (0 = Sunday). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The zone's offset (local minus UTC, ms) at `ms`, to the minute. */
function offsetAt(ms: number, zone?: string): number {
  const local = wallOf(ms, zone);
  const [y, m, d] = local.date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) + local.minutes * MIN - Math.floor(ms / MIN) * MIN;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatOf(zone: string | undefined): Intl.DateTimeFormat {
  const key = zone ?? '';
  let format = formats.get(key);
  if (!format) {
    const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    try { format = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: zone || undefined }); } catch { format = new Intl.DateTimeFormat('en-CA', options); } // an unknown zone reads as the process zone
    formats.set(key, format);
  }
  return format;
}

/** The text lowercased and folded (ä→a, ß→ss, marks dropped, links blanked) with, per folded character, its place in the text. */
function fold(text: string): { s: string; from: number[]; to: number[] } {
  let s = '';
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const folded = char.toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/\p{M}+/gu, '');
    if (!folded && to.length) to[to.length - 1] = i + char.length; // a combining mark belongs to the letter before it
    for (let k = 0; k < folded.length; k++) { from.push(i); to.push(i + char.length); }
    s += folded;
    i += char.length;
  }
  return { s: s.replace(/https?:\/\/\S+/g, (url) => ' '.repeat(url.length)), from, to };
}

/** Every part a rule reads, earliest first; of two overlapping parts the one that starts first (then the longer) stays. */
function atomsOf(s: string, c: Ctx): Atom[] {
  const found: Atom[] = [];
  for (const [rule, read] of RULES) {
    for (const m of s.matchAll(rule)) {
      const atom = read(m, c, s);
      if (atom) found.push({ ...atom, start: m.index, end: m.index + m[0].length } as Atom);
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Atom[] = [];
  for (const atom of found) if (!kept.length || atom.start >= kept[kept.length - 1].end) kept.push(atom);
  return kept;
}

/** Parts next to each other (only GAP between them) are one phrase: at most one day (a weekday and a date together) and one clock. */
function join(atoms: Atom[], s: string): Atom[][] {
  const groups: Atom[][] = [];
  for (const atom of atoms) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    if (group && last && fits(group, atom) && atom.start - last.end <= 30 && GAP.test(s.slice(last.end, atom.start))) group.push(atom);
    else groups.push([atom]);
  }
  return groups;
}

function fits(group: Atom[], atom: Atom): boolean {
  if (atom.kind === 'exact' || group[0].kind === 'exact') return false;
  if (atom.kind === 'clock') return !group.some((part) => part.kind === 'clock');
  const days = group.filter((part) => part.kind !== 'clock');
  return !days.length || (atom.dated === true && days.every((part) => part.weekday !== undefined));
}

/** A phrase's span (folded) and moment; undefined for a short weekday without its number. */
function resolve(group: Atom[], s: string, c: Ctx): { start: number; end: number; at: number; allDay: boolean; fromNow?: boolean } | undefined {
  const start = group[0].start;
  let end = group[group.length - 1].end;
  if (group[0].kind === 'exact') return { start, end, at: group[0].at!, allDay: false, fromNow: true };
  const day = group.find((part) => part.dated) ?? group.find((part) => part.kind !== 'clock');
  let clock: Partial<Atom> | undefined = group.find((part) => part.kind === 'clock');
  if (day && !clock) {
    const bare = BARE.exec(s.slice(end));
    if (bare && (day.kind === 'short' || CLAUSE_END.test(s.slice(end + bare[0].length)))) {
      clock = clockOf(bare, s);
      if (clock) end += bare[0].length;
    }
  }
  if (day?.kind === 'short' && !clock) return undefined;
  let minutes = clock?.minutes ?? 0;
  if (clock?.open && minutes < 720 && (group.some((part) => part.evening) || clock.evening || EVENING_IN.test(s.slice(start, end)))) minutes += 720;
  if (!day) { // a clock alone: today, or tomorrow when that time has passed
    const today = wallTime(c.today, minutes, c.zone);
    return { start, end, at: today > c.now ? today : wallTime(addDays(c.today, 1), minutes, c.zone), allDay: false };
  }
  const date = day.date ?? weekdayDate(day, c);
  if (!clock) return { start, end, at: wallTime(!day.date && date === c.today && !day.thisWeek ? addDays(date, 7) : date, 0, c.zone), allDay: true }; // today's weekday said bare: next week's
  const at = wallTime(date, minutes, c.zone);
  // Today's weekday at a time already past means next week's.
  return { start, end, at: !day.date && date === c.today && at <= c.now ? wallTime(addDays(date, 7), minutes, c.zone) : at, allDay: false };
}

function weekdayDate(day: Atom, c: Ctx): string {
  const ahead = (day.weekday! - c.weekday + 7) % 7;
  return addDays(c.today, ahead === 0 && day.next ? 7 : ahead);
}

/** A clock from a match's named groups (h or w, cm or dm, mk, pt); undefined when it is none. */
function clockOf(m: RegExpExecArray, s: string): Partial<Atom> | undefined {
  const g: Groups = m.groups ?? {};
  if (g.dm !== undefined && s[m.index + m[0].length] === '.' && Number(g.dm) <= 12) return undefined; // "ab 1.10." is a date
  let hour = g.w !== undefined ? CLOCK_WORDS[g.w] : Number(g.h);
  const minute = Number(g.cm ?? g.dm ?? 0);
  const mark = (g.mk ?? '').replace(/[.\s]/g, '');
  const meridiem = mark === 'am' || mark === 'pm';
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (mark === 'pm' ? 12 : 0);
  }
  if (!(hour <= 23) || minute > 59) return undefined;
  return { kind: 'clock', minutes: hour * 60 + minute, open: !meridiem && hour >= 1 && hour < 12, evening: g.pt !== undefined && EVENING_IN.test(g.pt) };
}

/** "in 20 min" / "in 2 h" are exact; "in 3 Tagen" / "in 2 weeks" are that day. */
function relative(amount: string | undefined, unit: string, c: Ctx): Partial<Atom> | undefined {
  const half = unit.startsWith('hal');
  const n = amount === undefined ? (half ? 1 : Number.NaN) : /^\d/.test(amount) ? Number(amount.replace(',', '.')) : AMOUNTS[amount];
  if (!(n > 0)) return undefined;
  if (half) return { kind: 'exact', at: c.now + n * 30 * MIN };
  if (/^[tdw]/.test(unit)) return { kind: 'day', date: addDays(c.today, Math.round(n) * (unit.startsWith('w') ? 7 : 1)) };
  return { kind: 'exact', at: c.now + Math.round(n * (/^[hs]/.test(unit) ? 60 : 1) * MIN) };
}

/** heute/today/tonight, morgen/tomorrow, übermorgen – before DAY_BOUNDARY_HOUR "morgen" is the coming day (the person has not slept yet). */
function dayWord(word: string, c: Ctx): Partial<Atom> {
  const early = c.minutes < DAY_BOUNDARY_HOUR * 60 ? 1 : 0;
  if (/^(?:heute|today|tonight)/.test(word)) return { kind: 'day', date: c.today, evening: word === 'tonight' };
  return { kind: 'day', date: addDays(c.today, (/bermorgen|after/.test(word) ? 2 : 1) - early) };
}

/** A written date; without a year the next one to come (today counts), two digits are 20xx; an impossible one (31.02.) is none. */
function dateOf(year: string | undefined, month: number, day: number, c: Ctx): Partial<Atom> | undefined {
  const given = year === undefined ? Number(c.today.slice(0, 4)) : year.length === 2 ? 2000 + Number(year) : Number(year);
  let date = calendarDate(given, month, day);
  if (date && year === undefined && date < c.today) date = calendarDate(given + 1, month, day);
  return date ? { kind: 'day', date, dated: true } : undefined;
}

function calendarDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month, day));
  return month >= 0 && month <= 11 && date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : undefined;
}
