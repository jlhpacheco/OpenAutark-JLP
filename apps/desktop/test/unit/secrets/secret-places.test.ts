// Where a secret stands (22.11.2026, after card numbers showed in agents' tool results on 16./17./21.11.): the label
// rule, the field mask, grouping-blind matching and short values in secret places (shared/secrets/secret-places.ts),
// and a secret field in the Windows UI tree (runtime/computer/tree.ts nodeLine).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldMask, isSecretLabel, looseReplace, maskInPlaces, SECRET_LABEL } from '../../../src/shared/secrets/secret-places.ts';
import { nodeLine } from '../../../src/runtime/computer/tree.ts';

const mark = (id: string) => `secret://${id}`;

test('the label rule knows card, code and password fields in English and German, also as field ids', () => {
  for (const label of ['Card Number *', 'input-creditCardNumber', 'cardnumber', 'cc-number', 'Kartennummer', 'CVV', 'CVV2/CVC2 code', 'cc-csc',
    'Sicherheitscode', 'Prüfnummer', 'Kartenprüfnummer', 'Expiration Date', 'exp-date', 'Ablaufdatum (MM/JJ)', 'Gültig bis', 'Valid to', 'MM / YY',
    'PIN', 'Passwort', 'Password', 'Kennwort', 'One-time code', 'Bestätigungscode', 'TAN', 'Verification code']) {
    assert.ok(isSecretLabel(label), label);
  }
  for (const label of ['Name', 'E-Mail', 'Postal code', 'Pinned', 'Card holder', 'Spinner', 'Kartenzahlung', 'Expired items', 'Code', 'Tank']) {
    assert.ok(!isSecretLabel(label), label);
  }
  assert.equal(SECRET_LABEL.flags.includes('g'), false, 'test() keeps no state');
});

test('the field mask shows a card number\'s last four digits, otherwise only the length', () => {
  assert.equal(fieldMask('5555 5555 5555 4444'), '•••• 4444');
  assert.equal(fieldMask('737'), '•••• (3 characters)');
  assert.equal(fieldMask('Geheim-2026!'), '•••• (12 characters)');
});

test('a long value matches in any grouping, never across lines or wide gaps', () => {
  const keys = new Map([['DE89370400440532013000', 'iban'], ['5555555555554444', 'card']]);
  assert.equal(looseReplace('IBAN DE89 3704 0044 0532 0130 00 ok', keys, mark), 'IBAN secret://iban ok');
  assert.equal(looseReplace('a 5555.5555.5555.4444 b 5555-5555-5555-4444', keys, mark), 'a secret://card b secret://card');
  assert.equal(looseReplace('5555 5555\n5555 4444', keys, mark), '5555 5555\n5555 4444');
  assert.equal(looseReplace('nothing here', keys, mark), 'nothing here');
});

test('a short value is replaced right after a secret label, not in running text', () => {
  const keys = new Map([['737', 'cvc'], ['1028', 'expiry']]);
  assert.equal(maskInPlaces('CVC: 737, Ablauf 10/28', keys, mark), 'CVC: secret://cvc, Ablauf secret://expiry');
  assert.equal(maskInPlaces('Zimmer 737 im Stock 10, am 10/28', keys, mark), 'Zimmer 737 im Stock 10, am 10/28');
  assert.equal(maskInPlaces('cvc 17370', keys, mark), 'cvc 17370', 'only a whole token');
  assert.equal(maskInPlaces(`PIN ${'x'.repeat(200)} 737`, keys, mark), `PIN ${'x'.repeat(200)} 737`, 'too far from its label');
});

test('the Windows UI tree shows a card or code field without its value; other fields and a month list stay (live 21.11.)', () => {
  const card = nodeLine({ d: 1, p: 0, rid: '1', role: 'edit', name: 'Card Number *', aid: 'input-creditCardNumber', value: '5555 5555 5555 4444' }, 'e401');
  assert.match(card, /= "•••• 4444"/);
  assert.ok(!card.includes('5555'));
  const cvv = nodeLine({ d: 1, p: 0, rid: '2', role: 'edit', name: 'CVV', value: '737' }, 'e402');
  assert.match(cvv, /= "•••• \(3 characters\)"/);
  assert.match(nodeLine({ d: 1, p: 0, rid: '3', role: 'edit', name: 'Name', value: 'Max Muster' }, 'e403'), /= "Max Muster"/);
  assert.match(nodeLine({ d: 1, p: 0, rid: '4', role: 'combobox', name: 'Expiration Date *', value: '10' }, 'e404'), /= "10"/);
});
