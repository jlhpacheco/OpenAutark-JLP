// Feedback 16.11.2026 (F15, F22): on the phone the feedback cell was only on the tab roots. Every row a body draws itself
// (a chat, an agent, its Work page, a person) end with the one cell (src/ui/feedback/cell.tsx; a placeholder of the same
// box where feedback is not allowed, so the row never shifts); 19.11.2026: the "only My day" screen is gone – the frame stays
// with its row while the PC is away. The team inbox's lines (src/ui/feedback/inbox-text.ts) say where a report was written.
// Owns: these assertions (source checks for the .tsx rows). Never: renders a view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeedbackInboxItem } from '../../../src/shared/model/feedback-delivery.ts';
import { fetchText, metaLine } from '../../../src/ui/feedback/inbox-text.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (name: string): string => readFileSync(path.join(ROOT, name), 'utf8');

test('the cell is the button where feedback is allowed, else a placeholder of the same box; on the computer none in a body row', () => {
  const cell = read('feedback/cell.tsx');
  assert.match(cell, /allowed \? \{ id: FEEDBACK_CELL_ID, slot: <FeedbackButton iconSize=\{20\} \/> \} : \{ id: FEEDBACK_CELL_ID, placeholder: true \}/);
  assert.match(cell, /isMobile\.value \? \[feedbackCell\(\)\] : \[\]/);
});

test('every phone row ends with it: the frame row, a chat, an agent, its Work page and a person', () => {
  assert.match(read('shell/MobileShell.tsx'), /feedbackCell\(\), PROFILE\]/, 'before Profile, kept as a placeholder when not allowed');
  assert.match(read('chat/ChatHeader.tsx'), /cells: \[call, tabs\('workspace'\), feedbackCell\(\)\]/);
  for (const name of ['team/AgentView.tsx', 'team/AgentWork.tsx', 'team/PersonView.tsx']) {
    const source = read(name);
    const headers = source.match(/<Header [^\n]*\/>/g) ?? [];
    assert.ok(headers.length >= 2, `${name}: loading and loaded rows`);
    for (const header of headers) assert.match(header, /cells=\{phoneFeedbackCells\(\)\}/, `${name}: the same cells while it loads, so nothing moves`);
  }
});

const PHONE: FeedbackInboxItem = {
  id: 'c0fd8641-9cb7-46f5-b790-b6be9ba14381', receivedAt: 2, createdAt: Date.UTC(2026, 10, 16, 6, 49), text: 'Es hat nicht funktioniert.',
  appVersion: '0.3.9', os: 'win32 10.0.26300 x64', client: 'Android app 0.3.15 · Android 16 · samsung SM-S918B · 412×915 @3x', company: 'company-2', dictated: true,
};

test('the inbox meta line: the PC "via", the company folder, dictated, a kind only for an agent', () => {
  const line = metaLine(PHONE);
  assert.match(line, /^No\. C0FD8641 · /);
  assert.match(line, / · via PC 0\.3\.9 · win32 10\.0\.26300 x64 · company-2 · dictated$/);
  const old = metaLine({ ...PHONE, client: undefined, company: undefined, dictated: undefined, kind: 'bug' });
  assert.match(old, / · 0\.3\.9 · win32 10\.0\.26300 x64$/, 'an older sender: no "via", no forced kind');
  assert.match(metaLine({ ...PHONE, fromAgent: true, kind: 'idea' }), / · Agent report \(idea\)$/);
});

test('a fetch that left letters in the mailbox says so, with their number when counted', () => {
  assert.equal(fetchText({ added: 2, unreadable: 0, more: false, total: 7 }), '7 reports.');
  assert.equal(fetchText({ added: 200, unreadable: 3, more: true, total: 230 }), '230 reports. 3 could not be opened. More waiting – Refresh takes the next.');
  assert.equal(fetchText({ added: 200, unreadable: 0, more: true, total: 230, waiting: 41 }), '230 reports. 41 more waiting – Refresh takes the next.');
});
