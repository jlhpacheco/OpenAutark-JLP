// 24.11.2026 (demo run of Autark 0.3.18): the model setup shows plan logins' e-mail addresses masked (src/ui/lib/email-mask.ts) –
// the first letter, "…", the domain; addresses on one screen that would read alike keep as many letters as tell them apart.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailMasker, maskEmail } from '../../../src/ui/lib/email-mask.ts';

test('mask: the first letter, "…" and the domain; never the whole local part; no address stays as given', () => {
  assert.equal(maskEmail('stanislaus@gmail.com'), 's…@gmail.com');
  assert.equal(maskEmail(' alex.work@teydra.example '), 'a…@teydra.example');
  assert.equal(maskEmail('stanislaus@gmail.com', 3), 'sta…@gmail.com');
  assert.equal(maskEmail('ab@x.org', 5), 'a…@x.org', 'a short local part keeps at most all but one letter');
  assert.equal(maskEmail('a@x.org'), 'a…@x.org');
  for (const value of ['ChatGPT login', '@x.org', 'name@', '']) assert.equal(maskEmail(value), value.trim(), value);
});

test('masker: addresses on one screen keep the fewest letters that tell them apart, else show in full', () => {
  const mask = emailMasker(['sam@gmail.com', 'samuel@gmail.com', 'sara@gmail.com', 'paul@web.example', undefined, 'SAM@gmail.com', 'ab@x.org', 'ac@x.org']);
  assert.equal(mask('paul@web.example'), 'p…@web.example', 'alone: one letter');
  assert.equal(mask('sara@gmail.com'), 'sar…@gmail.com');
  assert.equal(mask('sam@gmail.com'), 'sa…@gmail.com');
  assert.equal(mask('Sam@Gmail.com'), 'sa…@gmail.com', 'case does not make two addresses');
  assert.equal(mask('samuel@gmail.com'), 'sam…@gmail.com');
  assert.deepEqual([mask('ab@x.org'), mask('ac@x.org')], ['ab@x.org', 'ac@x.org'], 'no mask tells them apart');
  assert.equal(mask('lena@example.com'), 'l…@example.com', 'not on the list: one letter');
  assert.equal(emailMasker(['s.one@gmail.com', 's.two@gmail.com'])('s.two@gmail.com'), 's.t…@gmail.com');
});
