// B-080 – what the person can reach from a chat and a task card, checked on the components' source (the unit tests
// have no DOM): a chat's task status line opens the task (same text and time); a step's text opens the step, its
// circle stays the toggle – a pointer and a hover underline show it; a result's evidence opens; a message's files are
// first in its menu (Open, and on the desktop Show in folder); the pane's file tab wraps long lines and keeps in step by
// fraction. (Work's search, report and detail went with Work – Quests 20.11.2026; the Tasks page's search is
// tasks/task-search.ts, tested in test/unit/tasks-page.)
// Owns: these assertions only. Never: renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const source = (name: string): string => readFileSync(path.join(UI, name), 'utf8');

test('a task status line in a chat is a button that opens the task; other status lines stay quiet rows', () => {
  const item = source('chat/MessageItem.tsx');
  assert.match(item, /status\?\.type\.startsWith\('task_'\)/, 'only task_* lines');
  assert.match(item, /const id = status\.details\?\.taskId;\s*return typeof id === 'string' && id \? id : message\.taskId;/, 'details.taskId, else the message\'s own');
  assert.match(item, /<button type="button" class=\{`\$\{kind\} open`\}[^>]*onClick=\{\(\) => openTaskDetail\(taskId\)\}>\{parts\}<\/button>/);
  assert.match(item, /if \(!taskId\) return <div class=\{kind\}[^>]*>\{parts\}<\/div>;/, 'the same text and time either way');
  assert.equal((item.match(/<StatusLineRow /g) ?? []).length, 1, 'one shape: a burst of one line and of many render their lines alike');
});

test('a step\'s text opens the step\'s detail, its circle stays the toggle', () => {
  const steps = source('tasks/StepList.tsx');
  assert.match(steps, /class="step-text step-open" role="button" tabIndex=\{0\}/);
  assert.match(steps, /onClick=\{\(\) => onOpen\(step\.id\)\}/);
  assert.match(steps, /const open = props\.onOpen \?\? openTaskDetail;/, "the Tasks page's detail unless the card says where");
  assert.match(steps, /class="step-toggle" role="checkbox"/, 'the toggle is its own control');
});

test('the task line and the step text show they open: a pointer and a hover underline, no box change', () => {
  const chat = readFileSync(path.join(UI, 'styles', 'chat.css'), 'utf8');
  assert.match(chat, /\.status-line\.open:hover > span:not\(\.status-count\) \{ text-decoration: underline; text-underline-offset: 3px; \}/);
  const tasks = readFileSync(path.join(UI, 'styles', 'tasks.css'), 'utf8');
  assert.match(tasks, /\.step-open \{ cursor: pointer; text-align: left; \}/);
  assert.match(tasks, /\.step-open:hover \.step-title \{ text-decoration: underline; text-underline-offset: 3px; \}/);
  assert.match(tasks, /\.step-row\.done \.step-open:hover \.step-title \{ text-decoration-line: line-through underline; \}/, 'a done step keeps its strike');
});

test('a result\'s evidence chips open a link, or a path where it is (B-081 path-links: the agent\'s home PC first)', () => {
  const result = source('tasks/ResultView.tsx');
  assert.match(result, /evidenceTarget\(item\.ref\)/);
  assert.match(result, /openLink\(target\.ref\);\s*else void openPathLink\(target\.ref, props\.agentId\);/);
  assert.match(result, /<EvidenceChips items=\{result\.evidence\} agentId=\{task\.assigneeId\} \/>/);
  assert.doesNotMatch(result, /result\.verification|shield-check/, 'still no verification mark');
});

test('a message\'s files come first in its menu: Open <name>, and on the desktop Show <name> in folder', () => {
  const actions = source('chat/MessageActions.tsx');
  assert.match(actions, /label: `Open \$\{attachment\.name\}`, onSelect: \(\) => openAttachment\(attachment, message\.conversationId\)/);
  assert.match(actions, /const reveal = platform === 'desktop' && can\('files\.open'\);/);
  assert.match(actions, /label: `Show \$\{attachment\.name\} in folder`, onSelect: \(\) => showAttachment\(attachment\)/);
  assert.match(actions, /return files\.length \? \[\{ items: files \}, \{ items \}\] : \[\{ items \}\];/);
  const attachments = source('chat/Attachments.tsx');
  assert.match(attachments, /export function openAttachment\(/);
  assert.match(attachments, /export function showAttachment\(attachment: Attachment\): void \{\s*rpc\.call\('files\.open', \{ id: attachment\.fileId, reveal: true \}\)\.catch/);
});

test('the pane\'s file tab wraps a long line and keeps in step by fraction', () => {
  const view = source('workspace/FileView.tsx');
  assert.match(view, /wrap="soft"/);
  // 22.11.2026: a Markdown file also has a read page; whichever of the field and the page is shown keeps its place by fraction (false).
  assert.match(view, /const shown = state\.phase === 'text' \? state\.revision : -1;/);
  assert.match(view, /useScrollPosition\(id, area, read \? -2 : shown, false\)/);
  assert.match(view, /useScrollPosition\(id, page, read \? shown : -2, false\)/);
  const css = readFileSync(path.join(UI, 'styles', 'file-tab.css'), 'utf8');
  assert.match(css, /\.file-field \{[^}]*white-space: pre-wrap; overflow-wrap: anywhere;/);
});
