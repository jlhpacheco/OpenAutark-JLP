// Feedback 16.11.2026 F15 ("Kommt eigentlich irgendwie der Code vom PC?"): the phone shows the PC's UI and got the PC's
// theme setting, so a change on the PC flipped the phone between light and dark. The setting is the PCs' now: a phone
// (or any browser) follows its own light/dark, and Settings › General shows the Theme row only in the PC's window.
// Owns: these assertions only. Never: a real window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shownTheme } from '../../../src/ui/lib/theme.ts';

test('the PC window shows the setting; a phone keeps to its own light/dark whatever the PC chose', () => {
  for (const setting of ['system', 'light', 'dark'] as const) {
    assert.equal(shownTheme(setting, 'desktop'), setting);
    assert.equal(shownTheme(setting, 'pwa'), 'system', setting);
  }
  const source = readFileSync(new URL('../../../src/ui/lib/theme.ts', import.meta.url), 'utf8');
  assert.match(source, /const shown = shownTheme\(preferences\.value\.theme\);\r?\n\s+root\.dataset\.theme = shown;/);
  assert.match(source, /meta\.content = shown === 'system' \? 'light dark' : shown;/);
});

test('Settings › General: the Theme row only in the PC window', () => {
  const general = readFileSync(new URL('../../../src/ui/settings/GeneralPage.tsx', import.meta.url), 'utf8');
  // The group stays for the text size and the rest; only the Theme row sits behind the PC-window check.
  assert.match(general, /<Group title="Appearance">\s*\{bridge && \( \/\/ feedback 16\.11\.2026 F15[^\n]*\n\s+<Row label="Theme"/); // [^\n]* takes a \r too
});
