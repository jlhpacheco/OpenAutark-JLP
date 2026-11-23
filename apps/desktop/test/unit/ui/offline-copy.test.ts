// This device's copy of the last data (src/ui/pwa/offline-cache.ts, Sicher-Runde 19.11.2026 D1/D2): its shape is checked
// on reading (another version or a broken value is not used), a start without the PC shows it – the session too, so the
// phone keeps its tabs and controls – marked by `cachedAt` until a live load replaces it, a live load that came first is
// never covered by it, and it is written only from live data (never the copy back), at most once per gap, and dropped
// for a removed phone (4403).
// Owns: these assertions only. Never: a real IndexedDB, socket or phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { OFFLINE_VERSION, applyCopy, currentCopy, readCopy, restoreOfflineCopy, watchOfflineCopy } from '../../../src/ui/pwa/offline-cache.ts';
import type { OfflineCopy } from '../../../src/ui/pwa/offline-cache.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { can, session } from '../../../src/ui/lib/session.ts';
import { calendarWindow } from '../../../src/ui/lib/day-store.ts';
import { cachedAt, conversations, drafts, loaded, settings, todos } from '../../../src/ui/lib/store.ts';

const task = (id: string) => ({ id, title: id, status: 'open' }) as unknown as TaskView;
const DEVICE = { kind: 'device', capabilities: ['todo', 'chat'], secure: true, allowedMethods: ['todos.list', 'chats.list'] };

function stored(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: OFFLINE_VERSION, at: 1_700_000_000_000, session: DEVICE, settings: { profile: { name: 'Alex' } }, systemInfo: { deviceName: 'Office-PC' },
    conversations: [{ id: 'ch_main', title: 'Manager' }], agents: [{ id: 'ag_manager', name: 'Manager' }], archivedAgents: [],
    todos: [task('ta_todo')], tasks: [task('ta_open')], activity: [], accounts: [], drafts: { ch_main: 'Hello' }, secretDrafts: {}, draftFiles: {},
    calendarWindow: { from: 1, to: 2, list: { events: [], agentRuns: [], tz: 'Europe/Vienna', staleSources: [] } },
    ...extra,
  };
}

function reset(): void {
  loaded.value = false;
  cachedAt.value = null;
  session.value = null;
  settings.value = null;
  conversations.value = [];
  todos.value = [];
  drafts.value = {};
  calendarWindow.value = null;
  rpc.status.value = 'connecting';
  rpc.refused.value = null;
}

test('readCopy: only a copy of this version with a time; broken parts read as empty', () => {
  assert.equal(readCopy(undefined), null);
  assert.equal(readCopy({ ...stored(), v: OFFLINE_VERSION + 1 }), null, 'another shape is not used');
  assert.equal(OFFLINE_VERSION, 2);
  assert.equal(readCopy({ ...stored(), v: 1, briefing: null, handedOff: [] }), null, 'a copy from before the quests (old task shape, briefing) is not used');
  assert.equal('briefing' in readCopy(stored({ briefing: { counts: 1 } }))!, false, 'a stray briefing is not carried');
  assert.equal(readCopy({ ...stored(), at: 'yesterday' }), null);
  const copy = readCopy(stored({ todos: 'nope', session: { kind: 'stranger' }, calendarWindow: { from: 1 } }))!;
  assert.deepEqual(copy.todos, []);
  assert.equal(copy.session, null, 'a session that is none is the conservative default');
  assert.equal(copy.calendarWindow, null);
  assert.deepEqual(readCopy(stored())!.conversations.map((chat) => chat.id), ['ch_main']);
});

test('a start without the PC shows the copy – data, session and the calendar – marked by cachedAt', async () => {
  reset();
  try {
    assert.equal(await restoreOfflineCopy(async () => stored()), true);
    assert.equal(loaded.value, true);
    assert.equal(cachedAt.value, 1_700_000_000_000);
    assert.equal(session.value?.kind, 'device');
    assert.equal(can('chats.list'), true, 'the phone keeps its tabs and controls');
    assert.deepEqual(todos.value.map((entry) => entry.id), ['ta_todo']);
    assert.equal(calendarWindow.value?.list.tz, 'Europe/Vienna');
    assert.equal(drafts.value.ch_main, 'Hello');
    assert.equal(await restoreOfflineCopy(async () => { throw new Error('blocked'); }), false, 'storage that fails shows nothing, never throws');
  } finally { reset(); }
});

test('a live load that came first is never covered by the copy', () => {
  reset();
  try {
    loaded.value = true;
    todos.value = [task('ta_live')];
    assert.equal(applyCopy(readCopy(stored())!), false);
    assert.deepEqual(todos.value.map((entry) => entry.id), ['ta_live']);
    assert.equal(cachedAt.value, null);
  } finally { reset(); }
});

test('written only from live data, at most once per gap with what is there then; never the copy back; dropped when removed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  reset();
  const written: OfflineCopy[] = [];
  let forgot = 0;
  const stop = watchOfflineCopy({ write: async (copy) => { written.push(copy); }, forget: async () => { forgot++; }, gapMs: 4_000, now: () => 42 });
  try {
    applyCopy(readCopy(stored())!); // the copy shown at start
    rpc.status.value = 'open';
    t.mock.timers.tick(10_000);
    assert.equal(written.length, 0, 'the copy itself is never written back');

    cachedAt.value = null; // the live load replaced it
    todos.value = [task('ta_live')];
    todos.value = [task('ta_live'), task('ta_second')];
    t.mock.timers.tick(3_999);
    assert.equal(written.length, 0);
    t.mock.timers.tick(1);
    assert.equal(written.length, 1, 'one write for a burst of changes');
    assert.deepEqual(written[0].todos.map((entry) => entry.id), ['ta_live', 'ta_second']);
    assert.equal(written[0].at, 42);
    assert.equal(written[0].session?.kind, 'device');

    rpc.status.value = 'closed';
    todos.value = [];
    t.mock.timers.tick(10_000);
    assert.equal(written.length, 1, 'nothing is written while the connection is down');

    rpc.refused.value = 4403;
    assert.equal(forgot, 1, 'a removed phone keeps no copy');
  } finally { stop(); reset(); }
});

test('currentCopy holds what the signals hold', () => {
  reset();
  try {
    todos.value = [task('ta_x')];
    const copy = currentCopy(7);
    assert.equal(copy.v, OFFLINE_VERSION);
    assert.equal(copy.at, 7);
    assert.deepEqual(copy.todos.map((entry) => entry.id), ['ta_x']);
    assert.deepEqual(readCopy(structuredClone(copy)), copy, 'it reads back as itself');
  } finally { reset(); }
});
