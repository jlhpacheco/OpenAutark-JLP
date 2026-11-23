// B-083 track D: the turn's temperature in the chat and on the agent page (chat/live-text.ts) – "T 0.3" after the model
// line, "T ≈0.3" with a title where the model samples at its own setting (carried as the agent's stance); nothing without
// one, nothing without a model line. Plus the wiring: the live block's byline, the agent page's Now row and the time's title use these words, in their existing slots.
// Owns: these assertions only. Never: renders or reads the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shownOf, temperatureTag, temperatureTitle, withTemperature } from '../../../src/ui/chat/live-text.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

test('the tag, its title and the line with it', () => {
  assert.equal(temperatureTag('0.3'), 'T 0.3');
  assert.equal(temperatureTag('≈0.7'), 'T ≈0.7');
  for (const bad of [undefined, '', 'hot', 0.3, '0.3; drop', '≈']) assert.equal(temperatureTag(bad), '', String(bad));
  assert.equal(temperatureTitle('0.3'), 'Temperature 0.3');
  assert.equal(temperatureTitle('≈0.7'), 'Temperature 0.7, carried as stance – this model samples at its own setting');
  assert.equal(temperatureTitle(undefined), '');
  assert.equal(withTemperature('Opus 5.5 · High', '≈0.3'), 'Opus 5.5 · High · T ≈0.3');
  assert.equal(withTemperature('Opus 5.5 · High', undefined), 'Opus 5.5 · High');
  assert.equal(withTemperature('', '0.3'), '', 'no model yet (routing): the slot stays empty');
  assert.equal(shownOf({ temperature: 0.3, temperatureSent: true }), '0.3');
  assert.equal(shownOf({ temperature: 0.3 }), '≈0.3');
  assert.equal(shownOf({}), undefined);
  assert.equal(shownOf(undefined), undefined);
});

test('wiring: the live bar, the Now row and the time\'s title carry the temperature in their existing slots', () => {
  assert.match(read('chat/LiveBar.tsx'), /withTemperature\(modelLine\(\{ modelName: run\.model, effort: run\.effort \}\), shownOf\(run\)\)/, 'the live bar\'s title');
  const details = read('team/AgentDetails.tsx');
  assert.match(details, /withTemperature\(line, warmth\)/);
  assert.match(details, /run\.route\?\.temperature/, 'the last turn\'s temperature from its run');
  const item = read('chat/MessageItem.tsx');
  assert.match(item, /temperatureTitle\(message\.meta\.temperature\)/);
});
