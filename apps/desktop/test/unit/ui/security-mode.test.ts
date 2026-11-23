// The security mode after the first run, window side (owner 19.11.2026; before: B-085's careful PC access):
// src/ui/onboarding/security-mode.ts setSecurityMode sends the app's line to the Manager first (one clientId per
// direction until a try went through) and only then writes settings.json `security` (security-model.ts switchMode);
// src/ui/onboarding/ai-notice.ts secureNotice is the quiet line while the company is in Secure mode, whose action opens
// Settings › Security (where the mode change needs the double confirm) – never a one-click switch.
// Owns: these assertions only. Never: a real runtime, a socket or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECURE_NOTICE_ACTION, SECURE_NOTICE_ID, SECURE_NOTICE_PRIORITY, SECURE_NOTICE_TEXT, secureNotice, type SecureNoticeInput } from '../../../src/ui/onboarding/ai-notice.ts';
import { SECURE_MODE_LINE, setSecurityMode, TRUST_MODE_LINE } from '../../../src/ui/onboarding/security-mode.ts';
import { NOTICE_PRIORITY } from '../../../src/ui/shell/notices.ts';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { securityDefaults, type SecurityMode } from '../../../src/shared/model/security-settings.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { agents, conversations, settings } from '../../../src/ui/lib/store.ts';

const input = (mode: SecurityMode | undefined, extra: Partial<SecureNoticeInput> = {}): SecureNoticeInput => ({
  settings: { onboarding: { completed: true, step: 'done' }, ...(mode ? { security: securityDefaults(mode) } : {}) },
  loaded: true, writable: true, ...extra,
});

test('Secure mode after the first run: one quiet info line that opens Settings › Security, below every other line', () => {
  let opened = 0;
  const notice = secureNotice(input('secure'), () => { opened++; });
  assert.ok(notice);
  assert.equal(notice.id, SECURE_NOTICE_ID);
  assert.equal(notice.tone, 'info');
  assert.equal(notice.text, SECURE_NOTICE_TEXT);
  assert.ok(Object.values(NOTICE_PRIORITY).every((priority) => priority > SECURE_NOTICE_PRIORITY), 'lowest priority');
  assert.deepEqual(notice.actions?.map((action) => action.label), [SECURE_NOTICE_ACTION]);
  notice.actions?.[0].run();
  assert.equal(opened, 1);
  assert.equal(notice.onDismiss, undefined, 'a state, no Dismiss');
});

test('no line in Trust AI mode, during the first run, before the snapshots or where settings cannot be written', () => {
  assert.equal(secureNotice(input('trust'), () => undefined), null);
  assert.equal(secureNotice(input(undefined), () => undefined), null, 'absent = Trust AI mode');
  const during = input('secure');
  during.settings = { ...during.settings!, onboarding: { completed: false, step: 'about' } };
  assert.equal(secureNotice(during, () => undefined), null);
  assert.equal(secureNotice(input('secure', { loaded: false }), () => undefined), null);
  assert.equal(secureNotice(input('secure', { writable: false }), () => undefined), null);
  assert.equal(secureNotice(input('secure', { settings: null }), () => undefined), null);
});

/** Every rpc call setSecurityMode makes, in order; `fail` makes that method throw once. */
function stubRpc(fail?: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let failing = fail;
  Object.assign(rpc, {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === failing) { failing = undefined; throw new Error(`${method} refused`); }
      if (method === 'chats.direct') return { id: 'ch_direct' };
      if (method === 'settings.update') return settings.value;
      return { id: 'ms_1' };
    },
  });
  return calls;
}

const owner = (allowedMethods: string[] = []) => ({ kind: 'owner', capabilities: [], secure: true, allowedMethods }) as unknown as SessionInfo;
const managerChat = { id: 'ch_boss', settings: {}, createdAt: 1, members: [{ memberId: 'ag_boss', kind: 'agent' }, { memberId: HUMAN_ID, kind: 'human' }] };

function world(mode: SecurityMode = 'trust', chats: unknown[] = [managerChat]) {
  settings.value = { onboarding: { completed: true, step: 'done' }, security: securityDefaults(mode) } as unknown as Settings;
  session.value = owner();
  agents.value = [{ id: 'ag_boss', name: 'Manager', mode: 'manager', template: 'manager', createdAt: 1 }] as never;
  conversations.value = chats as never;
}

test('setSecurityMode secure: one line to the Manager\'s first chat as the person, with a clientId, then the section', async () => {
  world('trust');
  const calls = stubRpc();
  await setSecurityMode('secure');
  assert.deepEqual(calls.map((call) => call.method), ['messages.send', 'settings.update']);
  assert.equal(calls[0].params.conversationId, 'ch_boss');
  assert.equal(calls[0].params.body, SECURE_MODE_LINE);
  assert.deepEqual(calls[0].params.mentions, ['ag_boss']);
  assert.match(String(calls[0].params.clientId), /^req_/);
  assert.deepEqual(calls[1].params, { security: securityDefaults('secure') }, 'a company only ever in Trust AI starts Secure from its defaults');
});

test('setSecurityMode: the same mode does nothing; no first chat – the default 1:1 from chats.direct', async () => {
  world('secure');
  let calls = stubRpc();
  await setSecurityMode('secure');
  assert.deepEqual(calls, []);
  world('secure', []);
  calls = stubRpc();
  await setSecurityMode('trust');
  assert.deepEqual(calls.map((call) => call.method), ['chats.direct', 'messages.send', 'settings.update']);
  assert.equal(calls[1].params.body, TRUST_MODE_LINE);
  assert.deepEqual(calls[2].params, { security: { ...securityDefaults('secure'), mode: 'trust' } }, 'Secure values wait for the way back');
});

test('setSecurityMode: a refused send leaves the mode; the retry and a double click carry the same clientId', async () => {
  world('trust');
  const calls = stubRpc('messages.send');
  await assert.rejects(setSecurityMode('secure'), /messages\.send refused/);
  assert.deepEqual(calls.map((call) => call.method), ['messages.send'], 'no settings write');
  await Promise.all([setSecurityMode('secure'), setSecurityMode('secure')]);
  const sends = calls.filter((call) => call.method === 'messages.send');
  assert.equal(new Set(sends.map((call) => call.params.clientId)).size, 1, 'one clientId: the chat service keeps one message');
  world('trust');
  const next = stubRpc();
  await setSecurityMode('secure');
  assert.notEqual(next[0].params.clientId, sends[0].params.clientId, 'a new one after a try went through');
});

test('setSecurityMode: no Manager or no messages.send – only the section', async () => {
  world('trust');
  agents.value = [];
  let calls = stubRpc();
  await setSecurityMode('secure');
  assert.deepEqual(calls.map((call) => call.method), ['settings.update']);
  world('trust');
  session.value = { ...owner(['settings.update']), kind: 'device' } as unknown as SessionInfo;
  calls = stubRpc();
  await setSecurityMode('secure');
  assert.deepEqual(calls.map((call) => call.method), ['settings.update']);
});

test('the lines to the Manager: the app\'s automatic message in the person\'s voice, one line, no rewriting asked', () => {
  for (const line of [TRUST_MODE_LINE, SECURE_MODE_LINE]) {
    assert.match(line, /^Automatic message from the app, not typed by me: I switched this company to (Trust AI|Secure) mode\./);
    assert.equal(line.split('\n').length, 1);
    assert.doesNotMatch(line, /SYSTEM\.md/, 'the security section of every prompt carries the mode; nobody rewrites a file for it');
  }
});
