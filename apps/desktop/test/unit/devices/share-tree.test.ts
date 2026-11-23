// The plain rules of the home-project mirror (devices/sync/share-tree.ts): which paths travel, the walk, one file's
// look, the one decision for a file two PCs hold differently, and the name of the version that lost.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Guard, carried, copyName, decide, look, newer, readIndex, rootId, walk, writeIndex } from '../../../src/runtime/devices/sync/share-tree.ts';

const seen = (sha: string, mtime = 1000) => ({ sha, size: 1, mtime });
const made: string[] = [];
const tmp = async (prefix: string) => { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); made.push(dir); return dir; };
after(async () => { for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => undefined); });
const theirs = (sha: string, mtime = 1000) => ({ sha, mtime });

test('a project carries its files, never .git, node_modules, .venv, __pycache__, a part file or a path that climbs', () => {
  for (const rel of ['a.txt', 'src/deep/x.ts', '.env', '.github/workflows/ci.yml']) assert.equal(carried(rel), true, rel);
  for (const rel of ['', '.git/config', 'web/node_modules/x/index.js', '.venv/bin/python', 'lib/__pycache__/a.pyc', '../up.txt', 'a/../b', 'a//b', 'C:/x', 'a\\b', 'a.txt.1234.autark-part', 'aux.txt', 'src/CON', 'a<b.txt', 'trailing.', 'trailing ']) assert.equal(carried(rel), false, rel);
});

test('the walk lists carried files only and never enters a skipped folder', async () => {
  const root = await tmp('share-walk-');
  for (const rel of ['a.txt', 'src/b.ts', '.git/HEAD', 'node_modules/p/i.js', 'src/__pycache__/c.pyc', 'x.txt.9.autark-part']) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), rel);
  }
  assert.deepEqual((await walk(root)).sort(), ['a.txt', 'src/b.ts']);
});

test('a look hashes a file only when its size or time moved', async () => {
  const root = await tmp('share-look-');
  await writeFile(path.join(root, 'a.txt'), 'one');
  const guard = new Guard(root);
  const first = await look(root, 'a.txt', undefined, guard) as { sha: string; size: number; mtime: number };
  assert.equal(first.sha.length, 64);
  assert.equal(await look(root, 'a.txt', first, guard), first, 'unchanged: the same entry, no hash');
  await writeFile(path.join(root, 'a.txt'), 'two!');
  assert.notEqual((await look(root, 'a.txt', first, guard) as typeof first).sha, first.sha);
  assert.equal(await look(root, 'none.txt', first, guard), 'gone');
  assert.equal(await look(root, 'no/such/folder/x.txt', undefined, guard), 'gone');
  assert.equal(await look(root, '.git/config', undefined, guard), 'skip');
  await mkdir(path.join(root, 'now-a-folder'));
  assert.equal(await look(root, 'now-a-folder', first, guard), 'skip', 'a folder where a file was is no deletion');
});

test('one decision per file: only they changed it – it comes; only I – it goes; both – the later writer keeps the name', () => {
  assert.equal(decide(seen('a'), 'a', theirs('a')), 'same');
  assert.equal(decide(undefined, undefined, theirs('')), 'same');
  assert.equal(decide(seen('a'), 'a', theirs('b')), 'take', 'changed there');
  assert.equal(decide(undefined, undefined, theirs('b')), 'take', 'new there');
  assert.equal(decide(seen('a'), 'a', theirs('')), 'take', 'deleted there: the deletion comes');
  assert.equal(decide(seen('b'), 'a', theirs('a')), 'give', 'changed here');
  assert.equal(decide(seen('b'), undefined, theirs('')), 'give', 'new here');
  assert.equal(decide(undefined, 'a', theirs('a')), 'give', 'deleted here');
  assert.equal(decide(seen('b'), 'a', theirs('')), 'give', 'deleted there, changed here: the change stays');
  assert.equal(decide(undefined, 'a', theirs('c')), 'take', 'deleted here, changed there: the change comes');
  assert.equal(decide(seen('b', 1000), 'a', theirs('c', 2000)), 'aside', 'both changed, theirs later');
  assert.equal(decide(seen('b', 2000), 'a', theirs('c', 1000)), 'give', 'both changed, mine later: never overwritten');
  assert.equal(decide(seen('b', 1000), undefined, theirs('c', 2000)), 'aside', 'never agreed: both stay');
});

test('both PCs name the same later writer, also at the same time', () => {
  assert.equal(newer(theirs('a', 2000), theirs('b', 1000)), true);
  assert.equal(newer(theirs('a', 1000.4), theirs('b', 1000.9)), false, 'within one millisecond: the larger sha');
  assert.equal(newer(theirs('b', 1000), theirs('a', 1000)), true);
});

test('the version that lost is named after the PC that wrote it', () => {
  assert.equal(copyName('notes.md', 'Tower'), 'notes (from Tower).md');
  assert.equal(copyName('src/deep/a.test.ts', 'Notebook'), 'src/deep/a.test (from Notebook).ts');
  assert.equal(copyName('.env', 'Tower'), '.env (from Tower)');
  assert.equal(copyName('Makefile', 'My/PC:1'), 'Makefile (from My PC 1)');
});

test('what a PC remembers of a home project counts only for the very folder it was remembered of', async () => {
  const data = await tmp('share-index-');
  await writeIndex(data, '/p/one', { home: '/p/one', id: '1:7', files: { 'a.txt': seen('a') }, agreed: { B: { 'a.txt': 'a' } } });
  assert.deepEqual((await readIndex(data, '/p/one', '/p/one', '1:7')).agreed, { B: { 'a.txt': 'a' } });
  assert.deepEqual(await readIndex(data, '/p/one', '/p/one', '1:8'), { home: '/p/one', id: '1:8', files: {}, agreed: {} }, 'another folder under the same path');
  assert.deepEqual(await readIndex(data, '/p/two', '/p/two', '1:7'), { home: '/p/two', id: '1:7', files: {}, agreed: {} });
});

test('a folder has an identity: the same path with another folder is another one, no folder is none', async () => {
  const base = await tmp('share-id-');
  const root = path.join(base, 'p');
  assert.equal(rootId(root), undefined);
  await mkdir(root);
  const first = rootId(root);
  assert.ok(first);
  assert.equal(rootId(root), first);
  await rm(root, { recursive: true });
  await mkdir(path.join(base, 'other'));
  await mkdir(root);
  assert.notEqual(rootId(root), first);
  await writeFile(path.join(base, 'file'), 'x');
  assert.equal(rootId(path.join(base, 'file')), undefined);
});

test('the guard lets no path leave the folder through a link or junction', async () => {
  const base = await tmp('share-guard-');
  const root = path.join(base, 'p');
  await mkdir(path.join(root, 'real/deep'), { recursive: true });
  await mkdir(path.join(base, 'outside'));
  await writeFile(path.join(base, 'outside', 'secret.txt'), 'x');
  await symlink(path.join(base, 'outside'), path.join(root, 'linked'), 'junction');
  const guard = new Guard(root);
  assert.equal(await guard.ok('a.txt'), true);
  assert.equal(await guard.ok('real/deep/a.txt'), true);
  assert.equal(await guard.ok('real/new/folder/a.txt'), true, 'folders that are not there yet');
  assert.equal(await guard.ok('linked/secret.txt'), false);
  assert.equal(await guard.ok('linked/new/a.txt'), false);
  assert.equal(await guard.ok('../outside/secret.txt'), false);
  assert.equal(await look(root, 'linked/secret.txt', undefined, guard), 'skip');
  assert.equal(await look(root, 'linked/none.txt', undefined, guard), 'skip', 'nothing behind a link reads as gone');
  assert.deepEqual(await walk(root), []);
});
