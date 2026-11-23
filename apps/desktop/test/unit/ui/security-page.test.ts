// Settings › Security (owner 16.11.2026: "ein Sicherheits Tab"; 19.11.2026: Trust AI and Secure mode): the page sits after
// Secrets on #/settings/security (the older "permissions" name opens it too), its search words find it, and it is a view
// on settings.json `security` and the topic files – the mode through setSecurityMode (the Manager hears first,
// security-mode.test.ts) behind the double confirm, the switches written as the whole section, every topic text through
// security.saveTopic; no UI reads profile.pcAccess or profile.forEveryAgent any more.
// Owns: these assertions only. Never: a DOM or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, searchSections } from '../../../src/ui/settings/sections.ts';
import { parseRoute, SETTINGS_PAGES, settingsPage } from '../../../src/ui/lib/router.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (relative: string): string => readFileSync(path.join(SRC, relative), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

test('the Security page: after Secrets, a shield, settings.json behind it, the same place in the router', () => {
  const ids = SECTIONS.map((section) => section.id);
  assert.equal(ids.indexOf('security'), ids.indexOf('secrets') + 1);
  assert.deepEqual([...SETTINGS_PAGES], ids, 'the router holds the same list in the same order');
  const page = SECTIONS.find((section) => section.id === 'security')!;
  assert.equal(page.title, 'Security');
  assert.equal(page.icon, 'shield');
  assert.equal(page.file.path, 'settings.json');
  assert.deepEqual(page.requires, ['settings.update']);
  assert.deepEqual(parseRoute('#/settings/security'), { view: 'settings', section: 'security' });
  assert.equal(settingsPage('permissions'), 'security');
  for (const words of ['security', 'trust ai', 'secure mode', 'sandbox', 'folders', 'robot', 'captcha', 'every agent', 'full access']) {
    assert.ok(searchSections(words).some((section) => section.id === 'security'), words);
  }
});

test('the page is a view on settings.json and the topic files: the mode behind the double confirm, the switches as a whole section', () => {
  const page = read('settings/SecurityPage.tsx');
  assert.match(page, /securityOf\(props\.settings\)/, 'absent = Trust AI mode\'s defaults');
  assert.match(page, /rpc\.call\('security\.topics', \{ mode \}\)/);
  const fields = read('settings/security-fields.tsx');
  assert.match(fields, /setSecurityMode\(to\)/);
  assert.match(fields, /useDoubleConfirm\(true\)/, 'the mode is always behind Edit and "Yes, change it"');
  assert.match(fields, /rpc\.call\('security\.saveTopic', \{ mode, topic, text: value \}\)/);
  assert.match(fields, /reserve=\{2\}/, 'the mode\'s two lines are reserved, nothing moves');
  const switches = read('settings/security-switches.tsx');
  assert.match(switches, /updateSettings\(\{ security: \{ \.\.\.current, \.\.\.change \} \}\)/, 'the section is written whole');
  assert.match(switches, /choose\('security'\)/, 'the system folder dialog on the desktop');
  assert.match(read('settings/security-requests.tsx'), /rpc\.call\('security\.answer', \{ id: request\.id, answer: choice \}\)/);
  assert.match(read('settings/Settings.tsx'), /security: SecurityPage,/);
});

test('Umzug 21.11.2026: the head names this PC and says each PC keeps its own mode; otherPcs sits under the mode in both modes', () => {
  const page = read('settings/SecurityPage.tsx');
  assert.ok(page.includes("title={pc ? `This PC – ${pc}` : 'This PC'}"));
  assert.match(page, /hint="Each of your PCs keeps its own security mode/);
  assert.match(page, /<ModeRow [^>]*\/>\s*<SwitchRow mode=\{security\.mode\} name="otherPcs"/, 'one fixed place in the head, whatever the mode');
  assert.ok(read('settings/security-switches.tsx').includes('otherPcsOf(settings)'), 'absent reads Yes');
});

test('no UI reads profile.pcAccess or profile.forEveryAgent any more (one name: the security mode)', () => {
  for (const file of files(SRC)) {
    const text = readFileSync(file, 'utf8');
    // (the Changes group still names the two old fields for log entries written before the bridge)
    assert.doesNotMatch(text, /\.(?:pcAccess|forEveryAgent)\b|profile: \{ (?:pcAccess|forEveryAgent)|PcAccess/, path.relative(SRC, file));
  }
});
