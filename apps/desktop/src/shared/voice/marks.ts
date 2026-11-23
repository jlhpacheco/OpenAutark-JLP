// Marks in dictated text (owner 07.11.2026: "dass die KI wirklich zeigt, was sie nicht versteht"; 08.11.2026: hidden –
// the text the person sees, copies and sends stays plain).
//   ⟦?Lesart|60%|Alternative 25%; Alternative 10%⟧ – an uncertain place inline: the likeliest reading (it is the text),
//     how sure the recognizer is, other plausible words with their likelihood. Only the reading is required; empty
//     fields may be left out at the end. An old mark's fourth field (the sounds heard) is still read and ignored.
//   ⟦Diktat⟧…⟦/Diktat⟧ – a part spoken into a draft that already held other (typed or edited) text.
// B-082: the inline form lives only inside the hearing (listener, merge, this PC's weakest words) and in the agent's
// view. voice.transcribe converts once (spansFromInline) and the text travels plain with spans beside it (TextMarks:
// UTF-16 offsets into the plain text); the agent's context turns them back into the inline form (markedForAgent).
// Owns: the mark format, the spans, converting between both, and the lines that explain them to a listener and an agent.
// Never: decides which recognizer runs or stores anything.

export const MARK_OPEN = '⟦?';
export const MARK_CLOSE = '⟧';
export const DICTATION_OPEN = '⟦Diktat⟧';
export const DICTATION_CLOSE = '⟦/Diktat⟧';
/** This PC's speech model: words below this confidence are marked (its scores are not calibrated: correct words often sit at 0.4–0.6). */
export const LOCAL_MARK_BELOW = 0.35;
/** cleanMarks' caps: spans per kind, alternatives per span, characters per alternative. */
export const MAX_SPANS = 200;
export const MAX_ALTS = 6;
export const ALT_CHARS = 80;

export interface Alternative { text: string; percent?: number }
/** An inline mark as read (`heard`: an old mark's fourth field, never written any more). */
export interface UncertainMark { reading: string; percent?: number; alternatives: Alternative[]; heard?: string }

export interface MarkAlt { t: string; pct: number }
/** An unsure place in a plain text: [start, end) in UTF-16 offsets, how sure, the other likely words. */
export interface SpanMark { start: number; end: number; pct: number; alts: MarkAlt[] }
export interface TextMarks { uncertain?: SpanMark[]; dictated?: Array<{ start: number; end: number }> }
export interface MarkedText { text: string; marks?: TextMarks }

const clean = (part: string) => part.replace(/[⟦⟧|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
const pct = (value: number | undefined) => (value === undefined || !Number.isFinite(value) ? '' : `${Math.max(0, Math.min(100, Math.round(value)))}%`);

/** One mark as text: "⟦?Codex|70%|Kotex 15%⟧" (trailing empty fields dropped). */
export function formatMark(mark: UncertainMark): string {
  const fields = [
    clean(mark.reading) || '…',
    pct(mark.percent),
    mark.alternatives.map((alt) => [clean(alt.text), pct(alt.percent)].filter(Boolean).join(' ')).filter(Boolean).join('; '),
  ];
  while (fields.length > 1 && !fields[fields.length - 1]) fields.pop();
  return `${MARK_OPEN}${fields.join('|')}${MARK_CLOSE}`;
}

const number = (value: string) => { const n = Number.parseFloat(value.replace('%', '').replace(',', '.')); return Number.isFinite(n) ? n : undefined; };

/** One mark's inside ("reading|pct|alts|heard"). */
function parseInner(inner: string): UncertainMark {
  const [reading = '', percent = '', alternatives = '', heard = ''] = inner.split('|');
  return {
    reading: reading.trim(),
    percent: number(percent),
    alternatives: alternatives.split(';').map((alt) => alt.trim()).filter(Boolean).map((alt) => {
      const m = /^(.*?)\s+(\d+(?:[.,]\d+)?)\s*%$/.exec(alt);
      return m ? { text: m[1].trim(), percent: number(m[2]) } : { text: alt };
    }),
    ...(heard.trim() ? { heard: heard.trim() } : {}),
  };
}

/** The text with every mark replaced by its reading and the dictation tags removed (what was most likely said). */
export function plainText(text: string): string {
  return spansFromInline(text).text;
}

/** Whether a text holds uncertainty marks or dictation tags. */
export function hasMarks(text: string): boolean {
  return text.includes(MARK_OPEN) || text.includes(DICTATION_OPEN);
}

/** A dictated part for a draft that already holds text: wrapped in the dictation tags. */
export function wrapDictation(text: string): string {
  const words = text.trim();
  return words ? `${DICTATION_OPEN}${words}${DICTATION_CLOSE}` : '';
}

const INLINE = /⟦\?([^⟧]*)⟧|⟦Diktat⟧|⟦\/Diktat⟧/g;

/** An inline text (⟦?…⟧ marks, ⟦Diktat⟧ tags) as plain text with its spans; an unreadable place ("…") leaves no span. */
export function spansFromInline(inline: string): MarkedText {
  let text = '';
  let at = 0;
  let open = -1;
  const uncertain: SpanMark[] = [];
  const dictated: Array<{ start: number; end: number }> = [];
  for (const match of inline.matchAll(INLINE)) {
    text += inline.slice(at, match.index);
    at = match.index + match[0].length;
    if (match[0] === DICTATION_OPEN) { if (open < 0) open = text.length; continue; }
    if (match[0] === DICTATION_CLOSE) { if (open >= 0 && text.length > open) dictated.push({ start: open, end: text.length }); open = -1; continue; }
    const mark = parseInner(match[1]);
    const reading = mark.reading === '…' ? '' : mark.reading;
    if (!reading) continue;
    uncertain.push({ start: text.length, end: text.length + reading.length, pct: mark.percent ?? 0, alts: mark.alternatives.map((alt) => ({ t: alt.text, pct: alt.percent ?? 0 })) });
    text += reading;
  }
  text += inline.slice(at);
  if (open >= 0 && text.length > open) dictated.push({ start: open, end: text.length });
  const marks = cleanMarks(text, { uncertain, dictated });
  return marks ? { text, marks } : { text };
}

const int = (value: unknown): value is number => Number.isSafeInteger(value);
const percent = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : undefined);

/** An offset between the two halves of one character (a UTF-16 surrogate pair): no span edge may sit there. */
const splits = (text: string, at: number) => /[\uD800-\uDBFF]/.test(text.charAt(at - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(at));

/** Spans inside `text`, sorted, without overlaps (a later overlapping one is dropped), at most MAX_SPANS. */
function inOrder<T extends { start: number; end: number }>(spans: T[], text: string): T[] {
  const sorted = spans.filter((s) => s.start >= 0 && s.end > s.start && s.end <= text.length && !splits(text, s.start) && !splits(text, s.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: T[] = [];
  for (const span of sorted) if (!kept.length || span.start >= kept[kept.length - 1].end) kept.push(span);
  return kept.slice(0, MAX_SPANS);
}

/** Marks from anywhere (a client, a stored row) checked against `text`: valid spans only, capped; undefined = none. */
export function cleanMarks(text: string, marks: unknown): TextMarks | undefined {
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return undefined;
  const given = marks as { uncertain?: unknown; dictated?: unknown };
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.slice(0, MAX_SPANS * 5).filter((v) => v && typeof v === 'object') : []);
  const uncertain = inOrder(list(given.uncertain).flatMap((span): SpanMark[] => {
    const sure = percent(span.pct);
    if (!int(span.start) || !int(span.end) || sure === undefined) return [];
    const alts = (Array.isArray(span.alts) ? span.alts : []).flatMap((alt): MarkAlt[] => {
      const a = alt as Record<string, unknown> | null;
      const t = typeof a?.t === 'string' ? a.t.replace(/\s+/g, ' ').trim().slice(0, ALT_CHARS).trim() : '';
      const p = percent(a?.pct);
      return t && p !== undefined ? [{ t, pct: p }] : [];
    }).slice(0, MAX_ALTS);
    return [{ start: span.start, end: span.end, pct: sure, alts }];
  }), text);
  const dictated = inOrder(list(given.dictated).flatMap((span) => (int(span.start) && int(span.end) ? [{ start: span.start, end: span.end }] : [])), text);
  if (!uncertain.length && !dictated.length) return undefined;
  return { ...(uncertain.length ? { uncertain } : {}), ...(dictated.length ? { dictated } : {}) };
}

/** A plain text with its spans as the agent reads it: the unsure places as inline marks, the spoken part in the dictation tags. */
export function markedForAgent(text: string, marks?: TextMarks): string {
  const checked = cleanMarks(text, marks);
  if (!checked) return text;
  const unsure = checked.uncertain ?? [];
  const byStart = new Map(unsure.map((span) => [span.start, span]));
  const around = (at: number, edge: 'start' | 'end') => { // a tag never splits a mark
    const inside = unsure.find((span) => span.start < at && at < span.end);
    return inside ? inside[edge] : at;
  };
  const tags: Array<{ start: number; end: number }> = [];
  for (const span of checked.dictated ?? []) {
    const moved = { start: around(span.start, 'start'), end: around(span.end, 'end') };
    const last = tags[tags.length - 1];
    if (last && moved.start <= last.end) last.end = Math.max(last.end, moved.end);
    else tags.push(moved);
  }
  const opens = new Set(tags.map((tag) => tag.start));
  const closes = new Set(tags.map((tag) => tag.end));
  const stops = [...new Set([...opens, ...closes, ...byStart.keys()])].sort((a, b) => a - b);
  let out = '';
  let at = 0;
  for (const stop of stops) {
    if (stop < at) continue;
    out += text.slice(at, stop);
    at = stop;
    if (closes.has(stop)) out += DICTATION_CLOSE;
    if (opens.has(stop)) out += DICTATION_OPEN;
    const span = byStart.get(stop);
    if (span) {
      out += formatMark({ reading: text.slice(span.start, span.end), percent: span.pct, alternatives: span.alts.map((alt) => ({ text: alt.t, percent: alt.pct })) });
      at = span.end;
    }
  }
  return out + text.slice(at);
}

const WORDLIKE = /[\p{L}\p{N}]/u;

/**
 * This PC's transcript with its weakest words marked: each word (letters or digits) under `below` confidence becomes
 * "⟦?word|29%⟧". Words are found in the text in order; a word the text does not hold (the model reworded) is skipped.
 */
export function markUncertainWords(text: string, words: ReadonlyArray<{ text: string; confidence?: number }> | undefined, below = LOCAL_MARK_BELOW): string {
  if (!words?.length) return text;
  let out = '';
  let at = 0;
  for (const word of words) {
    const token = word.text.trim();
    if (!token) continue;
    const found = text.indexOf(token, at);
    if (found < 0) continue;
    const weak = word.confidence !== undefined && word.confidence < below && WORDLIKE.test(token);
    // Only the word itself is marked: "Gerd," → "⟦?Gerd|8%⟧,".
    const core = weak ? /[\p{L}\p{N}](?:[\p{L}\p{N}'’-]*[\p{L}\p{N}])?/u.exec(token) : null;
    out += text.slice(at, found) + (core
      ? `${token.slice(0, core.index)}${formatMark({ reading: core[0], percent: word.confidence! * 100, alternatives: [] })}${token.slice(core.index + core[0].length)}`
      : token);
    at = found + token.length;
  }
  return out + text.slice(at);
}

/** For a listening model and the dictation corrector: how it marks what it still cannot tell (in its own voice, English for
 *  every user; it writes the words in the speaker's language). */
export const LISTENER_MARK_RULES = [
  'Where I truly cannot tell what was said, I mark that place, and only that place:',
  '⟦?best reading|sure%|alternative chance%; alternative chance%⟧',
  'The best reading is what was most likely said; the alternatives are other words it could also be. Example: We test this with ⟦?Codex|70%|Kotex 15%⟧ today.',
].join('\n');

/** For an agent reading a person's message with marks (context/render.ts adds it once); in my own voice, one point. */
export const MARKS_LEGEND = '(In dictated text ⟦?reading|sure %|other words %⟧ is a place the speech recognition was unsure of: I read it with the chat\'s context and take the words that fit best. ⟦Diktat⟧…⟦/Diktat⟧ is the spoken part of a partly typed message.)';
