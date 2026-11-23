// scripts/electron-latest.mjs: version order, crossed majors and the breaking-change headlines (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headlines, parse, plan } from '../../../scripts/electron-latest.mjs';

test('parse takes exact versions only', () => {
  assert.deepEqual(parse('45.4.1'), [45, 4, 1]);
  assert.equal(parse('^45.4.1'), null);
  assert.equal(parse('46.0.0-alpha.12'), null);
});

test('plan: behind by patch, minor and major; current and ahead are not behind', () => {
  assert.deepEqual(plan('44.9.3', '44.11.5'), { behind: true, majors: [] });
  assert.deepEqual(plan('44.9.3', '46.1.0'), { behind: true, majors: [45, 46] });
  assert.deepEqual(plan('45.4.1', '45.4.1'), { behind: false, majors: [] });
  assert.equal(plan('45.10.0', '45.9.9').behind, false);
  assert.throws(() => plan('^44.0.0', '45.0.0'));
});

test('headlines lists only the asked major', () => {
  const md = '# Breaking Changes\n## Breaking API Changes (46.0)\n### Removed: a\n## Breaking API Changes (45.0)\n### Removed: b\ntext\n### Behavior Changed: c\n## Breaking API Changes (44.0)\n### d\n';
  assert.deepEqual(headlines(md, 45), ['Removed: b', 'Behavior Changed: c']);
  assert.deepEqual(headlines(md, 47), []);
});
