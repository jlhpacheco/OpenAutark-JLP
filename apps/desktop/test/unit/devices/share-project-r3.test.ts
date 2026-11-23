// The home-project mirror after review R3 (devices/sync/share-project.ts, share-take.ts): a project folder that goes or
// is replaced while the mirror runs stops the mirror and deletes nothing anywhere (H1); a file that cannot be read and a
// list with a page missing delete nothing (H2); a file that became a folder is no deletion (M2); this PC's rules are
// asked again on a settings change and before a take, and nothing is written, removed or read through a link (M3); two
// agents with one home project share one mirror (M5); the app's own data is no home project (L6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAIN_THREAD } from '../../../src/shared/model/origin.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { takeRepairNotes } from '../../../src/runtime/agents/turn-finish.ts';
import { SHARE_METHOD } from '../../../src/runtime/devices/sync/share.ts';
import { agent } from '../chat/harness.ts';
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
const notes = (pc: SharePc) => takeRepairNotes(pc.h.services, MARA, MAIN_THREAD);

/** A and B agree on `names`. */
async function agreed(a: SharePc, b: SharePc, ...names: string[]): Promise<void> {
  for (const name of names) await a.write(name, `content of ${name}`);
  await linkUp(a, b);
  await until(async () => (await files(b)).join() === [...names].sort().join(), 'the project on B');
  await calm();
}

test('H1: a project folder that is moved away while the mirror runs deletes nothing on my other PC; I hear it once, and it goes on when the folder is back', async () => {
  const { a, b } = await pair();
  await agreed(a, b, 'a.txt', 'src/b.txt');
  await rename(b.root, `${b.root}-moved`);
  await linkUp(a, b);
  await calm();
  await b.changed(''); // the watch says "something changed"
  await linkUp(a, b);
  await calm();
  assert.deepEqual(await files(a), ['a.txt', 'src/b.txt'], 'nothing deleted on A');
  assert.equal(existsSync(b.root), false, 'not made again while it runs');
  assert.deepEqual(notes(a), [`My home project is not mirrored: ${HOME} is no longer there on B.`]);
  await linkUp(a, b);
  await calm();
  assert.deepEqual(notes(a), [], 'once');
  await rename(`${b.root}-moved`, b.root);
  await a.write('new.txt', 'made while B was without its folder');
  await linkUp(a, b);
  await until(async () => (await b.read('new.txt')) !== undefined, 'the mirror goes on');
  await calm();
  assert.deepEqual(await files(a), ['a.txt', 'new.txt', 'src/b.txt']);
  assert.deepEqual(await files(b), ['a.txt', 'new.txt', 'src/b.txt']);
});

test('H1: the folder replaced by another one starts fresh – both sides keep and get everything', async () => {
  const { a, b } = await pair();
  await agreed(a, b, 'a.txt', 'src/b.txt');
  await rename(b.root, `${b.root}-old`);
  await mkdir(b.root);
  await writeFile(path.join(b.root, 'other.txt'), 'in the new folder');
  await linkUp(a, b);
  await calm();
  await linkUp(a, b);
  await until(async () => (await files(b)).join() === 'a.txt,other.txt,src/b.txt' && (await files(a)).join() === 'a.txt,other.txt,src/b.txt', 'both sides whole');
});

test('H2: a file that cannot be read is unknown, never gone – the rest of the list is taken and nothing is deleted', async () => {
  const { a, b } = await pair();
  await agreed(a, b, 'f0.txt', 'f1.txt', 'f2.txt', 'f3.txt');
  const real = b.share.project.lookAt;
  b.share.project.lookAt = async (root, rel, old, guard) => { if (rel === 'f1.txt') throw Object.assign(new Error('held open by another program'), { code: 'EBUSY' }); return real(root, rel, old, guard); };
  await a.write('f2.txt', 'changed on A');
  await a.write('f1.txt', 'changed on A too');
  await linkUp(a, b);
  await until(async () => (await b.read('f2.txt')) === 'changed on A', 'the entry after the failing one');
  await calm();
  await linkUp(a, b);
  await calm();
  assert.deepEqual(await files(a), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt']);
  assert.deepEqual(await files(b), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt']);
  assert.equal(await b.read('f1.txt'), 'content of f1.txt', 'left as it was');
  b.share.project.lookAt = real;
  await linkUp(a, b);
  await until(async () => (await b.read('f1.txt')) === 'changed on A too', 'it comes once it can be read');
});

test('H2: only a list whose every page came says what is gone there', async () => {
  const { a, b } = await pair();
  await agreed(a, b, 'f0.txt', 'f1.txt', 'f2.txt');
  // the last page of a list whose first page never came
  await b.share.receive({ op: 'have', agentId: MARA, home: HOME, list: 'L1', page: 1, end: true, entries: [] }, 'A');
  await calm();
  assert.deepEqual(await files(b), ['f0.txt', 'f1.txt', 'f2.txt'], 'nothing concluded from a list with a gap');
  assert.deepEqual(await files(a), ['f0.txt', 'f1.txt', 'f2.txt']);
  // pages without a number (an older sender) conclude nothing either
  await b.share.receive({ op: 'have', agentId: MARA, home: HOME, list: 'L2', end: true, entries: [] }, 'A');
  await calm();
  assert.deepEqual(await files(b), ['f0.txt', 'f1.txt', 'f2.txt']);
  // a whole list that does not name a file both agreed on: it is gone there
  await rm(path.join(a.root, 'f1.txt'));
  await a.share.catchUp('B');
  await until(async () => (await files(b)).join() === 'f0.txt,f2.txt', 'the deletion from a whole list');
});

test('M2: a file that became a folder (or a link) is not carried any more – never a deletion on my other PC', async () => {
  const { a, b } = await pair();
  await agreed(a, b, 'data.db', 'keep.txt');
  await rm(path.join(a.root, 'data.db'));
  await mkdir(path.join(a.root, 'data.db'));
  await a.changed('data.db');
  await linkUp(a, b);
  await calm();
  assert.equal(await b.read('data.db'), 'content of data.db', 'still there on B');
  // and the other way: what is a folder here is never written over or removed by a file from there
  await b.write('keep.txt', 'changed on B');
  await rm(path.join(a.root, 'keep.txt'));
  await mkdir(path.join(a.root, 'keep.txt'));
  await b.changed('keep.txt');
  await calm();
  assert.equal(existsSync(path.join(a.root, 'keep.txt')), true);
  assert.deepEqual(await files(a), []);
  assert.deepEqual(await files(b), ['data.db', 'keep.txt']);
});

test('M3: a settings change that closes the folder to me ends the mirror at once; one that is closed right before a take writes nothing', async () => {
  const { a, b } = await pair();
  const offs = [a.share.attach(), b.share.attach()];
  await agreed(a, b, 'a.txt');
  (b.h.services as { security: unknown }).security = { check: () => 'ask' };
  b.h.bus.emit('settings.updated', {} as Settings);
  await until(() => b.share.project.count() === 0, 'the mirror on B closed');
  await a.write('a.txt', 'changed after B closed the folder');
  await a.changed('a.txt');
  await calm();
  assert.equal(await b.read('a.txt'), 'content of a.txt');
  // closed with no settings event yet: the take itself asks again
  (b.h.services as { security: unknown }).security = { check: () => 'open' };
  await linkUp(a, b);
  await until(async () => (await b.read('a.txt')) === 'changed after B closed the folder', 'open again');
  await calm();
  (b.h.services as { security: unknown }).security = { check: () => 'closed' };
  await a.write('a.txt', 'a third version');
  await a.changed('a.txt');
  await calm();
  assert.equal(await b.read('a.txt'), 'changed after B closed the folder');
  for (const off of offs) off();
});

test('M3: nothing is written, removed or read through a link or junction inside the project', async () => {
  const { a, b } = await pair();
  await agreed(a, b, 'a.txt');
  const outside = path.join(b.disk, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'not the project\'s');
  await symlink(outside, path.join(b.root, 'data'), 'junction');
  await a.write('data/new.txt', 'from A');
  await a.write('data/private.txt', 'A\'s file of the same name');
  await a.changed('data');
  await linkUp(a, b);
  await calm();
  assert.deepEqual((await readdir(outside)).sort(), ['private.txt'], 'nothing written behind the junction');
  assert.equal((await readdir(outside)).length, 1);
  await assert.rejects(() => b.share.receive({ op: 'get', agentId: MARA, rel: 'data/private.txt', offset: 0 }, 'A'), /not here/);
  await rm(path.join(a.root, 'data'), { recursive: true });
  await a.changed('data');
  await linkUp(a, b);
  await calm();
  assert.deepEqual(await readdir(outside), ['private.txt'], 'nothing removed behind the junction');
  assert.equal(await b.read('a.txt'), 'content of a.txt');
});

test('M5: two agents with the same home project share one mirror', async () => {
  const net = new Net();
  const NOOR = 'ag_noor';
  const a = await sharePc(net, 'A', 'A', ['B']);
  const b = await sharePc(net, 'B', 'A', ['B']);
  link(a, b);
  for (const pc of [a, b]) { pc.h.org.add(agent(NOOR, 'Noor', { deviceId: 'B', homes: ['A'] })); pc.homes.set(NOOR, HOME); }
  await a.write('notes.md', 'base', 1_000_000);
  await linkUp(a, b);
  await until(async () => (await b.read('notes.md')) === 'base');
  await calm();
  assert.equal(a.share.project.count(), 1);
  assert.equal(b.share.project.count(), 1);
  net.up = false;
  await a.write('notes.md', 'from A, earlier', 2_000_000);
  await b.write('notes.md', 'from B, later', 3_000_000);
  net.up = true;
  await linkUp(a, b);
  await until(async () => (await a.read('notes.md')) === 'from B, later' && (await b.read('notes (from A).md')) === 'from A, earlier', 'one conflict copy');
  await calm();
  assert.deepEqual(await files(a), ['notes (from A).md', 'notes.md']);
  assert.deepEqual(await files(b), ['notes (from A).md', 'notes.md']);
  // Mara leaves the folder: Noor's mirror goes on
  for (const pc of [a, b]) pc.homes.delete(MARA);
  a.share.refresh(); b.share.refresh();
  assert.equal(a.share.project.count(), 1);
  await a.write('later.txt', 'x');
  await a.changed('later.txt');
  await until(async () => (await b.read('later.txt')) === 'x', 'still mirrored for Noor');
  assert.ok(net.calls.filter((call) => call.method === SHARE_METHOD).every((call) => [MARA, NOOR].includes((call.params as { agentId: string }).agentId)));
});

test('L6: the app\'s own data folder, a folder that holds it, and a whole disk are no home project', async () => {
  const { a } = await pair();
  a.share.project.place = (home) => home;
  for (const home of [a.data, path.join(a.data, 'agents'), path.dirname(a.data), path.parse(a.data).root]) {
    assert.match(a.share.project.problem(MARA, home) ?? '', /is no project folder on A/, home);
  }
  assert.equal(a.share.project.problem(MARA, a.disk), undefined);
});
