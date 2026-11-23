// 20.11.2026 the ⋯ beside each company in the profile menu (owner: "ein Drei-Punkte-Menü ... neben der Firma ... vor allem
// wenn es eine Remote-Firma ist ... dass man da austreten kann ... wie Account-Einstellung"): the menu model
// (src/ui/settings/company-actions.ts) – the open company's account pages, Export…, Leave where others keep it, else
// Delete, off for the only company – and its wiring in shell/ProfileMenu.tsx and lib/popover.tsx (sources: a .tsx file
// cannot run under node --test).
// Owns: these assertions only. Never: renders or calls a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { companyLine, companyMenu, leaves } from '../../../src/ui/settings/company-actions.ts';
import type { CompanyEntry } from '../../../src/shared/model/companies.ts';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (...parts: string[]) => readFileSync(path.join(UI, ...parts), 'utf8');
const entry = (extra: Partial<CompanyEntry>): CompanyEntry => ({ id: 'company-2', label: 'Side Shop', folder: 'company-2', current: false, ...extra });
const actions = (rows: ReturnType<typeof companyMenu>) => rows.map((row) => row.action);
const OPTS = { only: false, canExport: true };

test('the company open here: its account pages, Export…, then Leave or Delete', () => {
  assert.deepEqual(actions(companyMenu(entry({ current: true }), OPTS)), ['profile', 'devices', 'models', 'export', 'delete']);
  assert.deepEqual(actions(companyMenu(entry({ current: true, linkedPcs: [{ name: 'Tower', online: false }] }), OPTS)), ['profile', 'devices', 'models', 'export', 'leave']);
  assert.deepEqual(actions(companyMenu(entry({ current: true }), { only: false, canExport: false })), ['profile', 'devices', 'models', 'delete'], 'no folder picker: no Export…');
});

test('another company: Export… (off while it does not run) and Leave or Delete; its account pages live in its own window', () => {
  const remote = companyMenu(entry({ running: true, role: 'employee' }), OPTS);
  assert.deepEqual(actions(remote), ['export', 'leave']);
  assert.equal(remote[1].label, 'Leave');
  assert.equal(remote[1].description, 'This PC leaves, the firm keeps it');
  assert.equal(remote[1].danger, true);
  const mine = companyMenu(entry({ running: true, linkedPcs: [{ name: 'Laptop', online: true }] }), OPTS);
  assert.equal(mine[1].description, 'This PC leaves, your linked PCs keep it');
  const asleep = companyMenu(entry({ running: false }), OPTS);
  assert.deepEqual(asleep.map((row) => [row.action, row.disabled ?? false]), [['export', true], ['delete', false]]);
  assert.equal(asleep[1].description, 'From this PC, to the recycle bin');
});

test('the only company on this PC: Leave or Delete stays in its place, off, and says why', () => {
  const rows = companyMenu(entry({ current: true }), { only: true, canExport: true });
  const last = rows[rows.length - 1];
  assert.deepEqual([last.action, last.disabled, last.description], ['delete', true, 'The only company on this PC']);
});

test('the Leave rule and the line under the name (Settings › General › Companies uses the same)', () => {
  assert.equal(leaves(entry({ role: 'employee' })), true);
  assert.equal(leaves(entry({ linkedPcs: [] })), false);
  assert.equal(companyLine(entry({ current: true, linkedPcs: [{ name: 'A', online: true }, { name: 'B', online: false }] })), 'company-2 · this one · 2 linked PCs');
  assert.equal(companyLine(entry({ running: false, role: 'employee' })), 'company-2 · not running · employee');
  assert.match(read('settings', 'CompaniesGroup.tsx'), /import \{ companyLine, leaves, plural \} from '\.\/company-actions\.ts';/, 'one rule, both places');
});

test('the profile menu: a ⋯ on every company row opens its menu in the same place; Leave, Delete and Export… are those of Settings', () => {
  const menu = read('shell', 'ProfileMenu.tsx');
  assert.match(menu, /more: \{ label: `More for \$\{company\.label\}`, onSelect: \(\) => more\(company\) \},/);
  assert.match(menu, /companySections\(companies\.value, setActing\)/);
  assert.match(menu, /<Menu anchor=\{ref\.current\} open=\{!!acting\}[^\n]*width=\{256\} class="profile-menu"/, 'the same place and width as the profile menu');
  assert.match(menu, /companyMenu\(acting, \{ only: companies\.value\.length < 2, canExport: !!bridge\?\.files\.pickFolder \}\)/);
  assert.match(menu, /else if \(action === 'leave'\) void leaveCompany\(entry\)/);
  assert.match(menu, /else if \(action === 'export'\) void exportCompany\(entry\);/);
  assert.match(menu, /<DeleteDialog entry=\{deleting\}/, 'Delete asks its two questions here too');
  assert.match(menu, /if \(action === 'profile'\) go\.settings\('general'\);\n\s*else if \(action === 'devices'\) go\.settings\('devices'\);\n\s*else if \(action === 'models'\) go\.settings\('models'\);/, 'account pages that exist, no new settings');
  const group = read('settings', 'CompaniesGroup.tsx');
  assert.match(group, /export async function leaveCompany\(entry: CompanyEntry\): Promise<boolean> \{[\s\S]*?confirm\(\{ title: `Leave \$\{entry\.label\}\?`, body, confirmLabel: 'Leave', danger: true \}\) && removeCompany\(entry\);/, 'one question naming what happens, then companies.remove');
  assert.match(group, /drop this one/);
  assert.match(group, /const untold = \(entry: CompanyEntry\) => \(entry\.running === false \? ' It does not run, so PCs it may be linked with are not told/, 'review fix: a company that does not run says plainly that its PCs hear nothing');
  assert.match(group, /\$\{handOver\(entry\)\}\$\{untold\(entry\)\}/, 'in the first question of Delete too');
  assert.match(group, /entry\.running === false\n\s*\? `Its folder on this PC goes to the recycle bin\. \$\{others\}\.\$\{untold\(entry\)\}`/);
});

test('nothing shifts: the ⋯ slot is always kept; the dots show on hover or keyboard focus, always on touch', () => {
  const popover = read('lib', 'popover.tsx');
  assert.match(popover, /<div class="menu-row" key=\{key\}>/);
  assert.match(popover, /class="icon-button small menu-more" aria-label=\{more\.label\}/);
  assert.match(popover, /onClick=\{\(\) => \{ props\.onClose\(\); more\.onSelect\(\); \}\}/);
  const css = read('styles', 'overlays.css');
  assert.match(css, /\.menu \.menu-row > \.menu-item \{ padding-right: 40px; \}/, 'the slot is reserved on every such row');
  assert.match(css, /\.menu-row > \.menu-more \{ position: absolute;[^}]*opacity: 0;/);
  assert.match(css, /\.menu-row:hover > \.menu-more, \.menu-row:has\(:focus-visible\) > \.menu-more \{ opacity: 1; \}/);
  assert.match(css, /@media \(hover: none\) \{ \.menu-row > \.menu-more \{ opacity: 1; \} \}/);
});
