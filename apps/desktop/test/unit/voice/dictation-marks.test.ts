// Owner 07.11.2026: dictation shows what was not understood – uncertainty marks with alternatives and the sounds
// heard, a tag for spoken parts in typed text, and a listening model that gets the chat's last reply as context. B-080 F7: the agent's legend in its own voice.
// B-082: no "as heard" field written any more (an old one is still read), the listener rules without phonetics, the take's earlier text as context.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMark, hasMarks, LISTENER_MARK_RULES, MARKS_LEGEND, markUncertainWords, plainText, spansFromInline, wrapDictation } from '../../../src/shared/voice/marks.ts';
import { dictationPrompt } from '../../../src/runtime/voice/listen-transcribe.ts';

test('formatMark/spansFromInline: one mark round-trips; empty trailing fields are dropped; an old "as heard" field is read, never written', () => {
  const mark = formatMark({ reading: 'Codex', percent: 70.4, alternatives: [{ text: 'Kotex', percent: 15 }, { text: 'Kodecs' }], heard: 'kodeks' });
  assert.equal(mark, '⟦?Codex|70%|Kotex 15%; Kodecs⟧');
  assert.deepEqual(spansFromInline(`Wir testen ${mark} heute.`), { text: 'Wir testen Codex heute.', marks: { uncertain: [{ start: 11, end: 16, pct: 70, alts: [{ t: 'Kotex', pct: 15 }, { t: 'Kodecs', pct: 0 }] }] } });
  assert.deepEqual(spansFromInline('⟦?Codex|70%|Kotex 15%|kodeks⟧'), { text: 'Codex', marks: { uncertain: [{ start: 0, end: 5, pct: 70, alts: [{ t: 'Kotex', pct: 15 }] }] } });
  assert.equal(formatMark({ reading: 'olah', percent: 29, alternatives: [] }), '⟦?olah|29%⟧');
  assert.equal(formatMark({ reading: 'a|b⟧c', alternatives: [] }), '⟦?a b c⟧'); // field separators cannot break a mark
});

test('plainText: the readings without marks and tags; hasMarks sees both', () => {
  const text = `${wrapDictation('Das ist ⟦?Autark|80%|Autarc 10%⟧')} getippt ⟦?…|0%||blabla⟧.`;
  assert.equal(plainText(text), 'Das ist Autark getippt .');
  assert.ok(hasMarks(text));
  assert.ok(!hasMarks('nur Text'));
  assert.equal(wrapDictation('  '), '');
});

test('markUncertainWords: only words under the threshold are marked, punctuation and unknown words skipped', () => {
  const text = 'Die kannst du olah oder in Fortnehm sehen.';
  const words = [
    { text: 'Die', confidence: 0.9 }, { text: 'kannst', confidence: 0.8 }, { text: 'du', confidence: 0.7 }, { text: 'olah', confidence: 0.29 },
    { text: 'oder', confidence: 0.6 }, { text: 'in', confidence: 0.5 }, { text: 'Fortnehm', confidence: 0.34 }, { text: 'sehen', confidence: 0.9 }, { text: '.', confidence: 0.1 },
    { text: 'fehlt', confidence: 0.1 },
  ];
  assert.equal(markUncertainWords(text, words), 'Die kannst du ⟦?olah|29%⟧ oder in ⟦?Fortnehm|34%⟧ sehen.');
  assert.equal(markUncertainWords(text, undefined), text);
  assert.equal(markUncertainWords(text, [{ text: 'olah' }]), text); // no confidence: nothing marked
});

test('dictationPrompt: last reply and words go as data before the request; nothing without context', () => {
  const prompt = dictationPrompt('de', { lastReply: 'Ja, ich habe Zeit.', vocabulary: 'Teydra, Autark' });
  assert.match(prompt, /^Context to recognize names and topics – do not transcribe it/);
  assert.match(prompt, /"""Ja, ich habe Zeit\."""/);
  assert.match(prompt, /Names and terms the person uses \(spelled like this\): Teydra, Autark/);
  assert.match(prompt, /Transcribe this dictation\. The speaker most likely speaks the language with the code "de"/);
  assert.equal(dictationPrompt(undefined, {}), 'Transcribe this dictation.');
  assert.ok(dictationPrompt('de', { lastReply: 'x'.repeat(5_000) }).length < 2_000); // capped
  assert.match(LISTENER_MARK_RULES, /⟦\?best reading\|sure%/);
  assert.match(LISTENER_MARK_RULES, /^Where I truly cannot tell what was said, I mark that place/, 'F27/F07: English, in the model\'s own voice');
  assert.doesNotMatch(LISTENER_MARK_RULES, /Lautschrift|so gehört|phonetic|as heard/, 'B-082: no phonetic part');
  assert.doesNotMatch(LISTENER_MARK_RULES, /[äöüß]|\b(ich|und|die|das)\b/i, 'no German left for every user');
  assert.match(dictationPrompt('de', { before: 'Erster Teil.' }), /^Context to recognize names and topics – do not transcribe it, do not answer it:\nSaid just before in the same recording:\n"""Erster Teil\."""/);
});

test('B-080 F7, B-082: the legend an agent reads is one point in its own voice – no ask-rule, no "as heard"', () => {
  assert.equal(MARKS_LEGEND, '(In dictated text ⟦?reading|sure %|other words %⟧ is a place the speech recognition was unsure of: I read it with the chat\'s context and take the words that fit best. ⟦Diktat⟧…⟦/Diktat⟧ is the spoken part of a partly typed message.)');
  assert.doesNotMatch(MARKS_LEGEND, /as heard/);
  assert.doesNotMatch(MARKS_LEGEND, /\bask\b|\byou\b|only when|must/i);
});
