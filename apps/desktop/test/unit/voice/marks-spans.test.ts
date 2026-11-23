// B-082 (owner 08.11.2026: the marks are hidden – the text stays plain): src/shared/voice/marks.ts spansFromInline,
// cleanMarks and markedForAgent – inline marks to plain text with spans and back for the agent, the caps, and that
// spans from anywhere are checked against the text.
// Owns: these assertions only. Never: a recognizer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALT_CHARS, cleanMarks, markedForAgent, MAX_ALTS, MAX_SPANS, spansFromInline } from '../../../src/shared/voice/marks.ts';

test('spansFromInline: marks become their readings with spans, dictation tags become dictated spans, "…" leaves nothing', () => {
  const inline = 'Hallo ⟦Diktat⟧wir testen ⟦?Codex|65%|Kotex 25%; Kodecs⟧ heute⟦/Diktat⟧ und ⟦?…|0%⟧ ⟦?Gerd|30%|Gert 60%|gert⟧.';
  const { text, marks } = spansFromInline(inline);
  assert.equal(text, 'Hallo wir testen Codex heute und  Gerd.');
  assert.deepEqual(marks, {
    uncertain: [
      { start: 17, end: 22, pct: 65, alts: [{ t: 'Kotex', pct: 25 }, { t: 'Kodecs', pct: 0 }] },
      { start: 34, end: 38, pct: 30, alts: [{ t: 'Gert', pct: 60 }] },
    ],
    dictated: [{ start: 6, end: 28 }],
  });
  assert.equal(text.slice(17, 22), 'Codex');
  assert.equal(text.slice(34, 38), 'Gerd');
  assert.deepEqual(spansFromInline('nur Text'), { text: 'nur Text' }, 'no marks: no marks field');
  assert.deepEqual(spansFromInline('⟦Diktat⟧offen'), { text: 'offen', marks: { dictated: [{ start: 0, end: 5 }] } }, 'an unclosed tag runs to the end');
});

test('markedForAgent: plain text and spans back to the inline form; round trip with spansFromInline', () => {
  const inline = 'Hallo ⟦Diktat⟧wir testen ⟦?Codex|65%|Kotex 25%⟧ heute⟦/Diktat⟧ und ⟦?Gerd|30%|Gert 60%⟧.';
  const { text, marks } = spansFromInline(inline);
  assert.equal(markedForAgent(text, marks), inline);
  assert.equal(markedForAgent('plain', undefined), 'plain');
  // a dictated span that starts and ends at a mark: the tags stay outside it
  assert.equal(markedForAgent('ab cd', { uncertain: [{ start: 0, end: 2, pct: 40, alts: [] }], dictated: [{ start: 0, end: 2 }] }), '⟦Diktat⟧⟦?ab|40%⟧⟦/Diktat⟧ cd');
  // a dictated edge inside a mark moves to the mark's edge, never splitting it
  assert.equal(markedForAgent('abcdef', { uncertain: [{ start: 2, end: 4, pct: 10, alts: [] }], dictated: [{ start: 3, end: 6 }] }), 'ab⟦Diktat⟧⟦?cd|10%⟧ef⟦/Diktat⟧');
  // what the agent reads parses back to the same marks
  assert.deepEqual(spansFromInline(markedForAgent(text, marks)), { text, marks });
});

test('cleanMarks: spans inside the text, sorted, no overlaps, capped; junk dropped; nothing left is undefined', () => {
  const text = 'eins zwei drei';
  assert.equal(cleanMarks(text, undefined), undefined);
  assert.equal(cleanMarks(text, 'x'), undefined);
  assert.equal(cleanMarks(text, []), undefined);
  assert.equal(cleanMarks(text, { uncertain: [{ start: 3, end: 3, pct: 5, alts: [] }] }), undefined, 'an empty span is no span');
  const cleaned = cleanMarks(text, {
    uncertain: [
      { start: 5, end: 9, pct: 140.4, alts: [{ t: '  zwo  ', pct: -3 }, { t: '', pct: 5 }, { t: 7, pct: 1 }, { t: 'x'.repeat(200), pct: 2 }] },
      { start: 0, end: 4, pct: 20.6 },
      { start: 2, end: 6, pct: 30, alts: [] }, // overlaps the first kept one
      { start: 10, end: 99, pct: 30, alts: [] }, // outside the text
      { start: 1.5, end: 3, pct: 30, alts: [] },
      { start: 10, end: 14, pct: 'x', alts: [] },
      null,
    ],
    dictated: [{ start: 0, end: 14 }, { start: 5, end: 9 }, { start: -1, end: 2 }],
    extra: true,
  });
  assert.deepEqual(cleaned, {
    uncertain: [
      { start: 0, end: 4, pct: 21, alts: [] },
      { start: 5, end: 9, pct: 100, alts: [{ t: 'zwo', pct: 0 }, { t: 'x'.repeat(ALT_CHARS), pct: 2 }] },
    ],
    dictated: [{ start: 0, end: 14 }],
  });
  // UTF-16: offsets count code units; an edge between the two halves of one character is no span edge
  const emoji = 'ok 👍 gut';
  assert.deepEqual(cleanMarks(emoji, { uncertain: [{ start: 3, end: 5, pct: 40, alts: [] }] }), { uncertain: [{ start: 3, end: 5, pct: 40, alts: [] }] });
  assert.equal(cleanMarks(emoji, { uncertain: [{ start: 4, end: 8, pct: 40, alts: [] }], dictated: [{ start: 0, end: 4 }] }), undefined);
  const many = Array.from({ length: MAX_SPANS + 50 }, (_, i) => ({ start: i, end: i + 1, pct: 50, alts: Array.from({ length: 10 }, (_v, k) => ({ t: `w${k}`, pct: k })) }));
  const capped = cleanMarks('x'.repeat(400), { uncertain: many });
  assert.equal(capped?.uncertain?.length, MAX_SPANS);
  assert.equal(capped?.uncertain?.[0].alts.length, MAX_ALTS);
});
