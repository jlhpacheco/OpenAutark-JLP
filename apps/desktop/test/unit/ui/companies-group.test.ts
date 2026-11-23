// 16.11.2026 companies like accounts in the UI (src/ui/settings/CompaniesGroup.tsx, shell/ProfileMenu.tsx): Settings ›
// General ends with one fixed row per company – its name, its folder under it (two of the same name stay apart) – with
// Export… and Leave or Delete; Leave asks once, Delete twice (what goes with "Export first…", then the name typed); the
// only company has neither; Import… in the head and in the profile menu's "+". The profile menu shows the folder under
// a name another company shares; the row line and the Leave rule as written.
// Owns: these assertions on the sources (a .tsx file cannot run under node --test). Never: renders or calls a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const group = readFileSync(path.join(UI, 'settings', 'CompaniesGroup.tsx'), 'utf8');
const general = readFileSync(path.join(UI, 'settings', 'GeneralPage.tsx'), 'utf8');
const menu = readFileSync(path.join(UI, 'shell', 'ProfileMenu.tsx'), 'utf8');

test('Settings › General ends with the companies, desktop window only, each other one with its own facts', () => {
  assert.match(general, /<\/Group>\n\n\s*<CompaniesGroup \/>\n\s*<\/>/, 'last on the page: nothing below moves when it arrives');
  assert.match(group, /const shown = platform === 'desktop' && can\('companies\.list'\);/);
  assert.match(group, /rpc\.call\('companies\.list', \{ facts: true \}\)/);
  assert.match(group, /<Row key=\{entry\.folder\} label=\{entry\.label\} hint=\{[^\n]*companyLine\(entry\)[^\n]*\} reserve>/, 'one fixed row: the hint line is always there');
});

test('Delete asks twice – what goes with Export first…, then the name typed; Leave asks once; the only company has neither', () => {
  assert.match(group, /if \(!leaves\(entry\)\) \{ setDeleting\(entry\); return; \}/);
  assert.match(group, /confirm\(\{ title: `Leave \$\{entry\.label\}\?`[^\n]*confirmLabel: 'Leave', danger: true \}\)/);
  assert.match(group, />Export first…<\/Button>/);
  assert.match(group, /onClick=\{\(\) => setStep\(2\)\}>Continue<\/button>/);
  assert.match(group, /const named = !!entry && typed\.trim\(\)\.toLowerCase\(\) === entry\.label\.trim\(\)\.toLowerCase\(\);/);
  assert.match(group, /busy=\{busy\} disabled=\{!named\} onClick=\{\(\) => void remove\(\)\}>Delete<\/Button>/, 'Delete only with the name typed');
  assert.match(group, /if \(entry && named && await removeCompany\(entry\)\)/);
  assert.match(group, /disabled=\{only\} onClick=\{\(\) => void remove\(entry\)\}>\{leaves\(entry\) \? 'Leave' : 'Delete'\}<\/Button>/);
  assert.match(group, /rpc\.call\('companies\.remove', \{ id: entry\.id \}\)/);
  assert.match(group, /rpc\.call\('companies\.export', \{ id: entry\.id, dir \}\)/);
});

test('Import… in the head and the profile menu\'s "+"; the menu names the folder where a name repeats', () => {
  assert.match(group, /export async function importCompany\(\): Promise<void> \{[\s\S]*?pick\('restore'\)[\s\S]*?rpc\.call\('companies\.import', \{ path \}\)/);
  assert.match(group, /actions=\{bridge\?\.files\.pickFolder && <Button[^\n]*onClick=\{\(\) => void importCompany\(\)\}>Import…<\/Button>\}/);
  assert.match(menu, /\{ label: 'Import a company', description: '[^']+', onSelect: \(\) => \{ void importCompany\(\); \} \}/);
  assert.match(menu, /const describe = \(company: CompanyEntry, shared: boolean\): string => \[roleLine\(company\), shared \? company\.folder : ''\]\.filter\(Boolean\)\.join\(' · '\);/, '21.11.2026: the role line, then the folder where a name repeats');
  assert.match(menu, /const line = describe\(company, shared\(company\.label\)\);[\s\S]*?\.\.\.\(line \? \{ description: line \} : \{\}\),/);
  assert.match(menu, /rpc\.call\('companies\.list', \{ facts: true \}\)\.then/, '20.11.2026: with the facts – its ⋯ names Leave or Delete as Settings does');
});

test('the row line: folder, this one or not running, employee, linked PCs; Leave where others keep it (20.11.2026: company-actions.ts)', () => {
  const rules = readFileSync(path.join(UI, 'settings', 'company-actions.ts'), 'utf8');
  assert.match(rules, /return \[entry\.folder, state, entry\.role === 'employee' \? 'employee' : '', pcs \? plural\(pcs, 'linked PC'\) : ''\]\.filter\(Boolean\)\.join\(' · '\);/);
  assert.match(rules, /const state = entry\.current \? 'this one' : entry\.running === false \? 'not running' : '';/);
  assert.match(rules, /export const leaves = \(entry: CompanyEntry\): boolean => entry\.role === 'employee' \|\| \(entry\.linkedPcs\?\.length \?\? 0\) > 0;/);
});
