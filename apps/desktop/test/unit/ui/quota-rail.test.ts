// task_dm3sz5fe (24.11.2026): the rail shows every plan (BCAC2C92: "alle Pläne sehen – nicht nur +1") and a full weekly
// share fits inside the ring (1BDDA1B3: "100% geht aus dem Kreis raus").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hiddenEdges, ringText } from '../../../src/ui/shell/quota-stack.ts';

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('the ring: "100" when full (three digits fit inside), "n%" below, "–" while unknown', () => {
  assert.equal(ringText(100), '100');
  assert.equal(ringText(99), '99%');
  assert.equal(ringText(0), '0%');
  assert.equal(ringText(undefined), '–');
});

test('a scrolled stack marks the edges that hide badges', () => {
  assert.deepEqual(hiddenEdges(0, 300, 300), { above: false, below: false });
  assert.deepEqual(hiddenEdges(0, 300, 420), { above: false, below: true });
  assert.deepEqual(hiddenEdges(60, 300, 420), { above: true, below: true });
  assert.deepEqual(hiddenEdges(120, 300, 420), { above: true, below: false });
  assert.deepEqual(hiddenEdges(0.5, 300, 300.6), { above: false, below: false }, 'fractional layout is no hidden badge');
});

test('every plan has its badge: no cap, no "+n", the stack scrolls instead of a fixed height', () => {
  const rail = read('src/ui/shell/QuotaRail.tsx');
  assert.doesNotMatch(rail, /VISIBLE|usage-more|\.slice\(0,/);
  assert.match(rail, /list\.map\(\(entry\) => <Badge/);
  const css = read('src/ui/styles/shell.css');
  const stack = css.slice(css.indexOf('.usage-stack {'), css.indexOf('}', css.indexOf('.usage-stack {')));
  assert.doesNotMatch(stack, /max-height/);
  assert.match(stack, /overflow: hidden auto/);
  assert.match(css, /\.usage-stack\.more-below \{ mask-image/);
});
