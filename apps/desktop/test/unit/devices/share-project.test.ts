// An agent's home project between the PCs it is at home on (devices/sync/share-project.ts), two or three fake PCs with
// a disk each: a new home PC gets the whole project (without .git and node_modules), a change and a deletion travel at
// once, a file changed on both sides keeps both, a newer file is never overwritten, a folder that is gone is filled
// again and deletes nothing elsewhere, changes made while the link was down meet at link-up, a PC whose security rules
// close the folder mirrors nothing and the agent hears why once, and a PC that is no home is refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { MAIN_THREAD } from '../../../src/shared/model/origin.ts';
import { takeRepairNotes } from '../../../src/runtime/agents/turn-finish.ts';
import { SHARE_METHOD } from '../../../src/runtime/devices/sync/share.ts';
import { HOME, MARA, calm, sharePc, until, type SharePc } from './share-rig.ts';
import { Net, link } from './sync-net.ts';

async function pair(): Promise<{ net: Net; a: SharePc; b: SharePc }> {
  const net = new Net();
  const a = await sharePc(net, 'A', 'A', ['B']);
  const b = await sharePc(net, 'B', 'A', ['B']);
  link(a, b);
  return { net, a, b };
}

const linkUp = async (a: SharePc, b: SharePc) => { await a.share.catchUp(b.id); await b.share.catchUp(a.id); };
const files = async (pc: SharePc) => (await readdir(pc.root, { recursive: true, withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile())
  .map((entry) => path.relative(pc.root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();

test('a new home PC gets the whole project at the same path – without .git and node_modules', async () => {
  const { a, b } = await pair();
  await a.write('README.md', 'hello');
  await a.write('src/deep/main.ts', 'export {};');
  await a.write('empty.txt', '');
  await a.write('.git/HEAD', 'ref');
  await a.write('node_modules/p/index.js', 'x');
  await linkUp(a, b);
  await until(async () => (await files(b)).join() === 'README.md,empty.txt,src/deep/main.ts', 'the project on B');
  assert.deepEqual(await files(b), ['README.md', 'empty.txt', 'src/deep/main.ts']);
  assert.equal(await b.read('src/deep/main.ts'), 'export {};');
  assert.equal(await b.read('empty.txt'), '');
});

test('a change, a new folder and a deletion travel at once, both ways', async () => {
  const { a, b } = await pair();
  await a.write('a.txt', 'one');
  await a.write('gone.txt', 'soon gone');
  await linkUp(a, b);
  await until(async () => (await b.read('gone.txt')) === 'soon gone');
  await calm();
  await a.write('a.txt', 'two');
  await a.write('new/b.txt', 'in a new folder');
  await rm(path.join(a.root, 'gone.txt'));
  await a.changed('a.txt', 'new', 'gone.txt');
  await until(async () => (await b.read('a.txt')) === 'two' && (await b.read('new/b.txt')) === 'in a new folder' && !existsSync(path.join(b.root, 'gone.txt')), 'the changes on B');
  await calm();
  await b.write('a.txt', 'three, from B');
  await b.changed('a.txt');
  await until(async () => (await a.read('a.txt')) === 'three, from B', 'the change back on A');
  assert.deepEqual(await files(a), await files(b));
});

test('a file changed on both sides keeps both: the later writer keeps the name, the other stays beside it on both PCs', async () => {
  const { net, a, b } = await pair();
  await a.write('notes.md', 'base', 1_000_000);
  await linkUp(a, b);
  await until(async () => (await b.read('notes.md')) === 'base');
  await calm();
  net.up = false;
  await a.write('notes.md', 'from A, earlier', 2_000_000);
  await b.write('notes.md', 'from B, later', 3_000_000);
  net.up = true;
  await linkUp(a, b);
  await until(async () => (await a.read('notes.md')) === 'from B, later' && (await b.read('notes (from A).md')) === 'from A, earlier', 'both versions on both PCs');
  assert.equal(await b.read('notes.md'), 'from B, later');
  assert.equal(await a.read('notes (from A).md'), 'from A, earlier');
  await calm();
  assert.deepEqual(await files(a), ['notes (from A).md', 'notes.md']);
  assert.deepEqual(await files(b), ['notes (from A).md', 'notes.md']);
});

test('changes made while the link was down meet at link-up; a file only one side changed is never doubled', async () => {
  const { net, a, b } = await pair();
  await a.write('keep.txt', 'v1');
  await a.write('drop.txt', 'x');
  await linkUp(a, b);
  await until(async () => (await b.read('drop.txt')) === 'x');
  await calm();
  net.up = false;
  await a.write('keep.txt', 'v2 from A');
  await rm(path.join(b.root, 'drop.txt'));
  await b.write('only-b.txt', 'made on B');
  net.up = true;
  await linkUp(a, b);
  await until(async () => (await b.read('keep.txt')) === 'v2 from A' && !existsSync(path.join(a.root, 'drop.txt')) && (await a.read('only-b.txt')) === 'made on B', 'both sides caught up');
  await calm();
  assert.deepEqual(await files(a), ['keep.txt', 'only-b.txt']);
  assert.deepEqual(await files(b), ['keep.txt', 'only-b.txt']);
});

test('a project folder that is gone on one PC is filled again and deletes nothing on the other', async () => {
  const { a, b } = await pair();
  await a.write('a.txt', 'one');
  await a.write('src/b.txt', 'two');
  await linkUp(a, b);
  await until(async () => (await files(b)).join() === 'a.txt,src/b.txt');
  await calm();
  b.share.project.stop(); // B restarts …
  await rm(b.root, { recursive: true, force: true }); // … after its folder was removed
  await linkUp(a, b);
  await until(async () => (await files(b)).join() === 'a.txt,src/b.txt', 'the project on B again');
  await calm();
  assert.deepEqual(await files(a), ['a.txt', 'src/b.txt']);
  assert.equal(await b.read('src/b.txt'), 'two');
});

test('a PC whose security rules close the folder mirrors nothing, and I hear why once on my PC', async () => {
  const { net, a, b } = await pair();
  (b.h.services as { security: unknown }).security = { check: () => 'ask' };
  await a.write('a.txt', 'one');
  await linkUp(a, b);
  await calm();
  assert.equal(existsSync(b.root), false, 'nothing written on B');
  const line = `My home project is not mirrored: changing files in ${HOME} is closed to me on B.`;
  assert.deepEqual(takeRepairNotes(a.h.services, MARA, MAIN_THREAD), [line]);
  await linkUp(a, b);
  await calm();
  assert.deepEqual(takeRepairNotes(a.h.services, MARA, MAIN_THREAD), [], 'once');
  assert.deepEqual(takeRepairNotes(b.h.services, MARA, MAIN_THREAD), [], 'never on the PC I do not run on');
  assert.ok(net.calls.every((call) => call.method !== SHARE_METHOD || (call.params as { op: string }).op !== 'get'), 'no file was pulled');
  (b.h.services as { security: unknown }).security = { check: () => 'open' };
  await linkUp(a, b);
  await until(async () => (await b.read('a.txt')) === 'one', 'open again: the project comes');
});

test('a PC without the folder above the project does not mirror it; a home that agent.json does not name there yet stays quiet', async () => {
  const { a, b } = await pair();
  await a.write('a.txt', 'one');
  b.homes.delete(MARA); // agent.json still on its way
  await linkUp(a, b);
  await calm();
  assert.deepEqual(takeRepairNotes(a.h.services, MARA, MAIN_THREAD), []);
  b.homes.set(MARA, HOME);
  await rm(b.disk, { recursive: true, force: true });
  await linkUp(a, b);
  await calm();
  assert.deepEqual(takeRepairNotes(a.h.services, MARA, MAIN_THREAD), [`My home project is not mirrored: the folder above ${HOME} does not exist on B.`]);
});

test('only my home PCs take part: a third PC of the person gets nothing and is refused', async () => {
  const net = new Net();
  const a = await sharePc(net, 'A', 'A', ['B']);
  const b = await sharePc(net, 'B', 'A', ['B']);
  const c = await sharePc(net, 'C', 'A', ['B']);
  link(a, b); link(a, c); link(b, c);
  await a.write('a.txt', 'one');
  await a.share.catchUp('B'); await a.share.catchUp('C'); await c.share.catchUp('A');
  await until(async () => (await b.read('a.txt')) === 'one');
  await calm();
  assert.equal(existsSync(c.root), false);
  assert.ok(net.calls.every((call) => call.method !== SHARE_METHOD || (call.to !== 'C' && call.from !== 'C')), 'nothing to or from C');
  await assert.rejects(() => a.share.receive({ op: 'have', agentId: MARA, home: HOME, entries: [] }, 'C'), /at home on/);
  await assert.rejects(() => a.share.receive({ op: 'get', agentId: MARA, rel: 'a.txt', offset: 0 }, 'C'), /at home on/);
  await assert.rejects(() => a.share.receive({ op: 'have', agentId: MARA, home: HOME, entries: [] }, 'X'), /my own PCs/);
});

test('a piece is read only inside the project', async () => {
  const { a, b } = await pair();
  await a.write('a.txt', 'one');
  await a.write('.git/config', 'remote with a token');
  await linkUp(a, b);
  await until(async () => (await b.read('a.txt')) === 'one');
  for (const rel of ['../data/share/project-ag_mara.json', '.git/config', 'C:/Windows/win.ini', 'none.txt']) {
    await assert.rejects(() => a.share.receive({ op: 'get', agentId: MARA, rel, offset: 0 }, 'B'), /not here/, rel);
  }
});
