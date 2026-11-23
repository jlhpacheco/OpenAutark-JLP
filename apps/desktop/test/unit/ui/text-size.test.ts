// 17.11.2026 (Theo, portrait product videos): Ctrl +/−/0 sizes a chat's text on the desktop, stored on this PC; only the
// chat's own column grows (CSS zoom), never the tab area with its native pages; the window may be narrow (phone layout).
// 21.11.2026 (owner): two sizes – Labels (every stylesheet font size scales by --ui-text) and Text (content + the chat column); later the same day in px with fixed bounds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { clampPx, LABELS, TEXT, zoomKey } from '../../../src/ui/lib/text-size.ts';
import { MIN_WIDTH } from '../../../src/main/window-state.ts';

const read = (file: string) => readFileSync(new URL(`../../../src/${file}`, import.meta.url), 'utf8');

test('px sizes: whole pixels inside clear bounds around the default; anything unreadable is the default', () => {
  assert.deepEqual([LABELS.min, LABELS.base, LABELS.max], [10, 13, 17]);
  assert.deepEqual([TEXT.min, TEXT.base, TEXT.max], [10, 14, 24]);
  assert.equal(clampPx(12, LABELS), 12, 'smaller than the default too');
  assert.equal(clampPx('15', LABELS), 15);
  assert.equal(clampPx('15,6', TEXT), 16, 'a typed comma, rounded');
  assert.equal(clampPx(40, TEXT), 24);
  assert.equal(clampPx(3, LABELS), 10);
  assert.equal(clampPx('abc', TEXT), 14);
  assert.equal(clampPx(null, LABELS), 13);
});

test('keys: Ctrl with + or = (Shift or numpad give +), − and 0; Alt or no Ctrl is no zoom', () => {
  assert.equal(zoomKey({ key: '=', mod: true, alt: false }), 1);
  assert.equal(zoomKey({ key: '+', mod: true, alt: false }), 1);
  assert.equal(zoomKey({ key: '-', mod: true, alt: false }), -1);
  assert.equal(zoomKey({ key: '0', mod: true, alt: false }), 0);
  assert.equal(zoomKey({ key: '+', mod: false, alt: false }), undefined);
  assert.equal(zoomKey({ key: '+', mod: true, alt: true }), undefined, 'AltGr on a German keyboard');
  assert.equal(zoomKey({ key: 'k', mod: true, alt: false }), undefined);
});

test('wiring: the chat column zooms except its tab area; desktop only, after the pane keys; the window may be 400 px wide', () => {
  assert.match(read('ui/styles/chat.css'), /\.chat-column > :not\(\.chat-area\) \{ --ui-text: 1; --text-size: 1; zoom: var\(--chat-zoom, 1\); \}/);
  const shell = read('ui/shell/Shell.tsx');
  assert.match(shell, /restoreTextSizes\(\);\s*if \(platform !== 'desktop'\) return undefined;/);
  assert.match(shell, /if \(event\.defaultPrevented \|\| event\.isComposing\) return;/);
  assert.equal(MIN_WIDTH, 400);
});

test('21.11.2026 labels: every px font size in the stylesheets follows --ui-text, content takes the Text size', () => {
  const dir = new URL('../../../src/ui/styles/', import.meta.url);
  for (const file of readdirSync(dir).filter((name: string) => name.endsWith('.css'))) {
    const css = read(`ui/styles/${file}`);
    assert.doesNotMatch(css, /font-size:\s*\d+(?:\.\d+)?px/, `${file}: a fixed font size`);
    assert.doesNotMatch(css, /\bfont:\s*(?:\d{3}\s+)?\d+(?:\.\d+)?px/, `${file}: a fixed font shorthand`);
  }
  assert.match(read('ui/styles/base.css'), /textarea, \.md, \.code-block \{ --ui-text: var\(--text-size, 1\); \}/);
});
