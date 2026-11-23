// Upgrade of a representative old profile over the real headless runtime (23.10.2026; the built
// app/runtime-cli.mjs, demo engine, a temp data folder):
//  1. A profile at the oldest schema this version updates (test/unit/repair/old-profile.ts OLD_SCHEMA: org with a manager and a video specialist,
//     a chat with an attachment, a finished task with its step, a human to-do, a described and
//     tagged image, a disabled CLI account and a local API account, old version 0.3.6) starts on this version: the
//     runtime takes one pre-update copy, migrates, and serves every one of those over RPC as the app reads them;
//     repair.state says it is not in repair mode and lists the copy; the start notice says it was updated. (Quests round
//     20.11.2026: the fixture's old knowledge row is no longer moved into the memory tree – knowledge/memory-migrate.ts
//     went with the bridges, W2AI 7 – so this check no longer reads it.)
//  2. A second start of the same version keeps the data and makes no second copy.
//  3. Data saved by a newer app is refused: the runtime does not start, says why, and the data
//     stays untouched (the desktop app shows the repair screen for it – unit-tested in
//     test/unit/repair/*; the headless runtime has no window).
// Run: npm run build && node --test test/e2e/runtime-upgrade.test.mjs

import { testNetworkEnv } from '../../scripts/test-network-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startRuntime } from './lib/runtime-client.mjs';
import { FIXTURE, IMAGE_ID, OLD_SCHEMA, writeOldProfile } from '../unit/repair/old-profile.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function schemaOf(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'workforce.db'), { readOnly: true });
  try { return Number(db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get().value); } finally { db.close(); }
}

test('an old profile upgrades over the real runtime: agents, chat, tasks, to-do, media and accounts survive', { timeout: 180_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  writeOldProfile(dataDir);

  const first = await startRuntime({ dataDir, keepData: true });
  try {
    const { client } = first;
    const agents = await client.call('agents.list');
    const mira = agents.find((agent) => agent.id === FIXTURE.managerId);
    const vid = agents.find((agent) => agent.id === FIXTURE.videoId);
    assert.equal(mira?.name, 'Mira');
    assert.equal(mira?.mode, 'manager');
    assert.match(mira?.instructions ?? '', /Keep the team small\./, 'her own text survives');
    assert.equal(vid?.managerId, FIXTURE.managerId, 'the org survives');
    assert.equal(vid?.mode, 'video');

    const chat = (await client.call('chats.list')).find((item) => item.id === FIXTURE.chatId);
    assert.equal(chat?.title, 'Product launch');
    const messages = await client.call('messages.list', { conversationId: FIXTURE.chatId });
    assert.deepEqual(messages.filter((message) => message.kind === 'text').map((message) => message.body), ['Please make the launch flyer.', 'Here is the flyer.']);
    assert.equal(messages.find((message) => message.id === 'ms_2')?.attachments[0]?.fileId, IMAGE_ID);

    const tasks = await client.call('tasks.list', { conversationId: FIXTURE.chatId, includeSteps: true, status: ['done', 'open'] });
    const flyer = tasks.find((task) => task.id === FIXTURE.taskId);
    assert.equal(flyer?.status, 'done');
    assert.equal(flyer?.result?.summary, 'Flyer made.');
    const steps = flyer?.steps ?? tasks.filter((task) => task.parentId === FIXTURE.taskId);
    assert.ok(steps.some((step) => step.id === FIXTURE.stepId && step.status === 'done'), 'the done step is kept');
    const todos = await client.call('todos.list');
    assert.ok(todos.some((todo) => todo.id === FIXTURE.todoId && todo.title === 'Sign the print order'), 'the human to-do is still in For you');

    const media = await client.call('media.list', { conversationId: FIXTURE.chatId });
    const flyerFile = media.find((item) => item.fileId === IMAGE_ID);
    assert.equal(flyerFile?.description, 'Launch flyer, final');
    assert.deepEqual(flyerFile?.tags, ['launch', 'flyer']);
    const found = await client.call('media.list', { text: 'flyer' });
    assert.ok(found.some((item) => item.fileId === IMAGE_ID), 'still found by its description');
    const file = await client.call('files.get', { id: IMAGE_ID });
    assert.equal(file?.name, 'flyer.png');

    const accounts = await client.call('accounts.list');
    const codex = accounts.find((account) => account.id === FIXTURE.codexId);
    assert.deepEqual({ provider: codex?.provider, label: codex?.label, plan: codex?.plan, email: codex?.email, enabled: codex?.enabled },
      { provider: 'codex', label: 'Codex · work', plan: 'pro', email: 'person@example.com', enabled: false });
    // Quests round 20.11.2026: the once-move of API connections into settings.json (provider-file.ts moveOld) went with the
    // bridges – data this version opens is past it; an account row of the old data stays as it is.
    const local = accounts.find((account) => account.baseUrl === 'http://127.0.0.1:9/v1');
    assert.equal(local?.label, 'Local model', 'the local API account survives');
    assert.equal(local?.id, FIXTURE.localId, 'under its own id');
    const repair = await client.call('repair.state');
    assert.equal(repair.active, false);
    assert.deepEqual(repair.backups.map((copy) => copy.schema), [OLD_SCHEMA], 'one pre-update copy of the old data');
    const info = await client.call('system.info');
    assert.match(info.notice?.text ?? '', /^Updated to /);
  } finally {
    await first.stop();
  }

  const second = await startRuntime({ dataDir, keepData: true });
  try {
    const repair = await second.client.call('repair.state');
    assert.equal(repair.backups.length, 1, 'a second start makes no second copy');
    assert.ok((await second.client.call('agents.list')).some((agent) => agent.id === FIXTURE.videoId));
  } finally {
    await second.stop();
  }
  assert.ok(readdirSync(path.join(dataDir, 'backups', 'pre-upgrade')).some((name) => name.endsWith(`-s${OLD_SCHEMA}.db`)));
});

test('data saved by a newer app: the runtime refuses to start, says why, and leaves the data as it is', { timeout: 120_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-newer-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  writeOldProfile(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'workforce.db'));
  db.prepare(`UPDATE meta SET value = '9999' WHERE key = 'schema'`).run();
  db.close();
  const run = spawnSync(process.execPath, [path.join(root, 'app', 'runtime-cli.mjs'), '--data', dataDir, '--resources', path.join(root, 'resources'), '--ui', path.join(root, 'app', 'ui'), '--port', '0', '--fake'], { cwd: root, encoding: 'utf8', timeout: 60_000, env: testNetworkEnv(dataDir) });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /saved by a newer version of Autark \(schema 9999/);
  assert.equal(schemaOf(dataDir), 9999, 'nothing migrated');
});

test('data from before the 13.11. rebuild: the runtime refuses to start, names the release that updates it and where it is, and leaves the data as it is', { timeout: 120_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-e2e-older-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  writeOldProfile(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'workforce.db'));
  db.prepare(`UPDATE meta SET value = '101' WHERE key = 'schema'`).run();
  db.close();
  const run = spawnSync(process.execPath, [path.join(root, 'app', 'runtime-cli.mjs'), '--data', dataDir, '--resources', path.join(root, 'resources'), '--ui', path.join(root, 'app', 'ui'), '--port', '0', '--fake'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /older Autark \(schema 101\)\. Install Autark 0\.3\.14 first \(https:\/\/github\.com\/teydra\/OpenAutark\/releases\/tag\/v0\.3\.14\)/);
  assert.equal(schemaOf(dataDir), 101, 'nothing migrated');
  assert.equal(readdirSync(dataDir).includes('backups') && readdirSync(path.join(dataDir, 'backups')).includes('pre-upgrade') ? readdirSync(path.join(dataDir, 'backups', 'pre-upgrade')).length : 0, 0, 'no pre-update copy');
});
