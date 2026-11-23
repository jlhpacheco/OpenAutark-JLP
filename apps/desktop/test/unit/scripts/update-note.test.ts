// scripts/update-note.mjs: the release gate reads the section headings of resources/updates.md exactly as the runtime's
// update note does (src/runtime/system/update-note.ts parseUpdates).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sectionVersions } from '../../../scripts/update-note.mjs';
import { parseUpdates } from '../../../src/runtime/system/update-note.ts';

test('the gate finds the same versions as the runtime, in file order', () => {
  const text = '# Autark updates\n\nIntro.\n\n## 0.3.18\n\nNew.\n\n## v0.3.17\n\nOld.\n\n### 0.3.16 is no section\n';
  assert.deepEqual(sectionVersions(text), ['0.3.18', '0.3.17']);
  assert.deepEqual(sectionVersions(text), parseUpdates(text).map((section) => section.version));
});

test('the shipped updates.md has sections the runtime reads, newest first', () => {
  const text = readFileSync(new URL('../../../resources/updates.md', import.meta.url), 'utf8');
  const versions = sectionVersions(text);
  assert.ok(versions.length > 0);
  assert.deepEqual(versions, parseUpdates(text).map((section) => section.version));
});
