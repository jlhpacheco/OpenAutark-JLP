// Umzug 21.11.2026 (PCSEC, CONTRACT point 6): devices.send_file takes a folder (walked, its layout and empty folders
// kept, pieces of 1 MiB) and an optional `at` on the receiving PC; without `at` it lands in the same folder there when
// that folder exists, else in inbox/<sending PC>/; a taken name gets " (2)" (folders too); an `at` that is no folder
// there goes to the inbox and says so; a folder stopped halfway leaves nothing; this PC's otherPcs no refuses a file;
// a folder this PC's rules keep closed to the agent sends it to the inbox with the reason.
// Owns: these assertions only. Never: a real mesh – both "PCs" share one temp disk, the sender's folders mirrored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendFile } from '../../../src/runtime/devices/send-file.ts';
import { dropIdle, receivePiece } from '../../../src/runtime/devices/receive-file.ts';
import { clean, localAbsolute, placeFile } from '../../../src/runtime/devices/landing.ts';
import { securityDefaults, type SecuritySettings } from '../../../src/shared/model/security-settings.ts';

type Out = { ok?: boolean; path?: string; files?: number; bytes?: number; note?: string; linksNotFollowed?: number };
const outOf = (output: unknown): Out => JSON.parse((output as { content: Array<{ text: string }> }).content[0].text) as Out;

/** "Here" sends to "Tower"; a sender path below `here` reads as the same path below `mirror` on Tower (absent until made). */
function pcs(t: { after(fn: () => void): void }, security?: Partial<SecuritySettings> & { check?: string }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-folder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const here = path.join(dir, 'here');
  const there = path.join(dir, 'there');
  const mirror = path.join(dir, 'mirror');
  mkdirSync(here, { recursive: true });
  mkdirSync(path.join(there, 'workspace'), { recursive: true });
  const tower = {
    paths: { workspace: path.join(there, 'workspace') },
    devices: { self: () => ({ id: 'dev_tower', name: 'Tower' }), list: () => [{ id: 'dev_me', name: 'Notebook' }] },
    ...(security ? { security: { current: () => ({ ...securityDefaults('secure'), ...security }), check: () => security.check ?? 'open', gate: async () => ({ ok: true }) } } : {}),
  } as never;
  const calls: Array<Record<string, unknown>> = [];
  let stopAfter = Infinity;
  const controller = new AbortController();
  const services = {
    paths: { workspace: here, data: dir },
    devices: {
      self: () => ({ id: 'dev_me', name: 'Notebook' }),
      list: () => [{ id: 'dev_me', name: 'Notebook', kind: 'pc', status: 'linked', self: true }, { id: 'dev_tower', name: 'Tower', kind: 'pc', status: 'linked' }],
      call: async (_id: string, _method: string, params: Record<string, unknown>) => {
        calls.push(params);
        const begin = params.begin as { from?: string } | undefined;
        if (begin?.from) begin.from = begin.from.replace(here, mirror);
        if (calls.length > stopAfter && !params.abort) controller.abort(new Error('stopped'));
        return receivePiece(tower, params, 'dev_me');
      },
    },
  };
  const ctx = { services, agent: { id: 'ag_a', name: 'A' }, runId: 'run', mode: 'general', signal: controller.signal, status: () => undefined } as never;
  const send = async (args: { path: string; at?: string }) => outOf(await sendFile.run({ to: 'Tower', ...args }, ctx));
  return { here, there, mirror, inbox: path.join(there, 'workspace', 'inbox', 'Notebook'), calls, send, ctx, stopAfter: (n: number) => { stopAfter = n; } };
}

function folder(root: string): void {
  mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  mkdirSync(path.join(root, 'empty'));
  writeFileSync(path.join(root, 'a.txt'), 'top');
  writeFileSync(path.join(root, 'sub', 'b.bin'), Buffer.alloc(2 * 1024 * 1024 + 5, 3));
  writeFileSync(path.join(root, 'sub', 'deep', 'c.md'), '# deep');
}

const tree = (root: string): string[] => readdirSync(root, { recursive: true, withFileTypes: true })
  .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/') + (entry.isDirectory() ? '/' : '')).sort();

test('a folder goes over whole: its layout, an empty folder, a big file in 1 MiB pieces; the count and bytes come back', async (t) => {
  const pc = pcs(t);
  folder(path.join(pc.here, 'Project'));
  const out = await pc.send({ path: path.join(pc.here, 'Project') });
  assert.equal(out.ok, true);
  assert.equal(out.path, path.join(pc.inbox, 'Project'), 'Tower lacks the folder it lies in here: its inbox');
  assert.deepEqual(tree(out.path!), ['a.txt', 'empty/', 'sub/', 'sub/b.bin', 'sub/deep/', 'sub/deep/c.md']);
  assert.equal(readFileSync(path.join(out.path!, 'sub', 'deep', 'c.md'), 'utf8'), '# deep');
  assert.equal(readFileSync(path.join(out.path!, 'sub', 'b.bin')).length, 2 * 1024 * 1024 + 5);
  assert.equal(out.files, 3);
  assert.equal(out.bytes, 3 + 6 + 2 * 1024 * 1024 + 5);
  assert.equal(pc.calls.filter((call) => (call.rel as string | undefined) === 'sub/b.bin').length, 3, 'three pieces of at most 1 MiB');
  const again = await pc.send({ path: path.join(pc.here, 'Project') });
  assert.equal(again.path, path.join(pc.inbox, 'Project (2)'), 'a taken folder name gets " (2)"');
});

test('without at a file lands in the same folder when Tower has it, never over a file there', async (t) => {
  const pc = pcs(t);
  mkdirSync(path.join(pc.here, 'Docs'));
  mkdirSync(path.join(pc.mirror, 'Docs'), { recursive: true });
  writeFileSync(path.join(pc.here, 'Docs', 'plan.txt'), 'new plan');
  writeFileSync(path.join(pc.mirror, 'Docs', 'plan.txt'), 'old plan');
  const out = await pc.send({ path: path.join(pc.here, 'Docs', 'plan.txt') });
  assert.equal(out.path, path.join(pc.mirror, 'Docs', 'plan (2).txt'));
  assert.equal(readFileSync(path.join(pc.mirror, 'Docs', 'plan.txt'), 'utf8'), 'old plan', 'the file there stays');
  assert.equal(readFileSync(out.path!, 'utf8'), 'new plan');
  assert.equal(out.note, undefined);
});

test('at: an absolute folder there takes it; one that is missing sends it to the inbox and says so', async (t) => {
  const pc = pcs(t);
  writeFileSync(path.join(pc.here, 'x.txt'), 'x');
  const target = path.join(pc.there, 'Target');
  mkdirSync(target);
  assert.equal((await pc.send({ path: path.join(pc.here, 'x.txt'), at: target })).path, path.join(target, 'x.txt'));
  const missing = await pc.send({ path: path.join(pc.here, 'x.txt'), at: path.join(pc.there, 'Nowhere') });
  assert.equal(missing.path, path.join(pc.inbox, 'x.txt'));
  assert.match(missing.note!, /Nowhere is no folder on Tower, so it went into inbox\/Notebook\/ there\./);
  const relative = await pc.send({ path: path.join(pc.here, 'x.txt'), at: 'Target' });
  assert.equal(path.dirname(relative.path!), pc.inbox, 'a relative at is no folder there either');
});

test('a folder stopped halfway leaves nothing behind on Tower', async (t) => {
  const pc = pcs(t);
  folder(path.join(pc.here, 'Half'));
  pc.stopAfter(3);
  await assert.rejects(Promise.resolve(sendFile.run({ to: 'Tower', path: path.join(pc.here, 'Half') }, pc.ctx)), /stopped/);
  assert.equal(pc.calls.at(-1)!.abort, true, 'the receiver is told to drop it');
  assert.equal(existsSync(path.join(pc.inbox, 'Half')), false);
  assert.deepEqual(readdirSync(pc.inbox), []);
});

test('Tower\'s rules: otherPcs no refuses the file; a folder closed to the agent there sends it to the inbox with the reason', async (t) => {
  const refused = pcs(t, { otherPcs: 'no' });
  writeFileSync(path.join(refused.here, 'x.txt'), 'x');
  await assert.rejects(refused.send({ path: path.join(refused.here, 'x.txt') }), /Tower takes no calls from agents on other PCs/);
  assert.equal(existsSync(refused.inbox), false);
  const closed = pcs(t, { check: 'ask' });
  mkdirSync(path.join(closed.here, 'Private'));
  mkdirSync(path.join(closed.mirror, 'Private'), { recursive: true });
  writeFileSync(path.join(closed.here, 'Private', 'tax.pdf'), 'tax');
  const out = await closed.send({ path: path.join(closed.here, 'Private', 'tax.pdf') });
  assert.equal(out.path, path.join(closed.inbox, 'tax.pdf'));
  assert.match(out.note!, /Changing files in .*Private is closed to me on Tower, so it went into inbox\/Notebook\/ there\./);
});

test('a PC on a version before folders: a single file goes the old way into its inbox; a folder is refused with why', async (t) => {
  const pc = pcs(t);
  writeFileSync(path.join(pc.here, 'one.txt'), 'one');
  mkdirSync(path.join(pc.here, 'Dir'));
  const older = { ...(pc.ctx as { services: { devices: Record<string, unknown> } }) };
  const call = (older.services.devices.call as (id: string, m: string, p: Record<string, unknown>) => Promise<unknown>);
  older.services.devices.call = async (id: string, m: string, p: Record<string, unknown>) => {
    if (p.begin) throw new Error('A file piece needs name, offset and dataBase64.');
    return call(id, m, p);
  };
  const out = outOf(await sendFile.run({ to: 'Tower', path: path.join(pc.here, 'one.txt') }, older as never));
  assert.equal(out.path, path.join(pc.inbox, 'one.txt'));
  const dir = await sendFile.run({ to: 'Tower', path: path.join(pc.here, 'Dir') }, older as never) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(dir.isError, true);
  assert.match(dir.content[0].text, /Tower runs an older Autark that takes single files/);
});

// ---------------------------------------------------------------- round 2 (review R2: M1–M3, L1–L3, L5)

test('M1/L2: dot names keep their dot (.git, .env); only what Windows cannot hold changes – reserved names get "_"', async (t) => {
  assert.deepEqual(['.git', '.env', 'a.', 'b .', '...', 'CON', 'nul.txt', 'com1.log', 'Lpt9', 'console.log', 'a:b'].map((name) => clean(name, 'x')),
    ['.git', '.env', 'a', 'b', 'x', 'CON_', 'nul_.txt', 'com1_.log', 'Lpt9_', 'console.log', 'a_b']);
  const pc = pcs(t);
  const repo = path.join(pc.here, 'app');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  writeFileSync(path.join(repo, '.git', 'config'), '[core]');
  writeFileSync(path.join(repo, '.env'), 'KEY=1');
  writeFileSync(path.join(repo, 'env'), 'plain');
  const out = await pc.send({ path: repo });
  assert.deepEqual(tree(out.path!), ['.env', '.git/', '.git/config', 'env']);
});

test('M2: a folder grows under a working name and is put in place only at done; an idle transfer is dropped with what it wrote', async (t) => {
  const pc = pcs(t);
  const tower = { paths: { workspace: path.join(pc.there, 'workspace') }, devices: { self: () => ({ name: 'Tower' }), list: () => [{ id: 'dev_me', name: 'Notebook' }] } } as never;
  const id = '11111111-1111-4111-8111-111111111111';
  await receivePiece(tower, { id, begin: { name: 'Half', folder: true, agentId: 'ag_a' } }, 'dev_me');
  await receivePiece(tower, { id, rel: 'a.txt', offset: 0, dataBase64: Buffer.from('ab').toString('base64'), last: false }, 'dev_me');
  assert.deepEqual(readdirSync(pc.inbox), [`.${id}.partdir`], 'nothing that looks finished');
  assert.equal(await dropIdle(tower, 60_000), 0, 'a transfer with a fresh piece stays');
  assert.equal(await dropIdle(tower, 0), 1);
  assert.deepEqual(readdirSync(pc.inbox), [], 'its working folder is gone');
  await assert.rejects(receivePiece(tower, { id, rel: 'a.txt', offset: 2, dataBase64: 'YQ==', last: true }, 'dev_me'), /no longer open here/);
  const file = '22222222-2222-4222-8222-222222222222';
  await receivePiece(tower, { id: file, begin: { name: 'x.bin', folder: false, agentId: 'ag_a' } }, 'dev_me');
  await receivePiece(tower, { id: file, offset: 0, dataBase64: 'YQ==' }, 'dev_me');
  assert.equal(await dropIdle(tower, 0), 1);
  assert.deepEqual(readdirSync(pc.inbox), [], 'its part file is gone');
});

test('L1: two landings of the same name both keep their file', async (t) => {
  const pc = pcs(t);
  mkdirSync(pc.inbox, { recursive: true });
  const parts = ['one', 'two'].map((text) => { const part = path.join(pc.inbox, `.${text}.part`); writeFileSync(part, text); return part; });
  const placed = await Promise.all(parts.map((part) => placeFile(part, pc.inbox, 'report.pdf')));
  assert.deepEqual(placed.map((file) => path.basename(file)).sort(), ['report (2).pdf', 'report.pdf']);
  assert.deepEqual(placed.map((file) => readFileSync(file, 'utf8')).sort(), ['one', 'two']);
});

test('L3/M3: a network or foreign path is never touched; a begin naming no agent gets only what is open there', async (t) => {
  assert.equal(localAbsolute(String.raw`\\host\share\x`), false);
  assert.equal(localAbsolute(String.raw`\\?\UNC\host\share`), false);
  assert.equal(localAbsolute('//host/share'), false);
  assert.equal(localAbsolute(process.platform === 'win32' ? '/Users/x/Desktop' : String.raw`C:\Users\x`), false, 'another system\'s spelling');
  assert.equal(localAbsolute(process.platform === 'win32' ? String.raw`C:\Users\x` : '/home/x'), true);
  const pc = pcs(t);
  writeFileSync(path.join(pc.here, 'x.txt'), 'x');
  const unc = await pc.send({ path: path.join(pc.here, 'x.txt'), at: String.raw`\\somehost\share` });
  assert.equal(path.dirname(unc.path!), pc.inbox);
  assert.match(unc.note!, /somehost\\share is no folder on Tower/);
  const closed = pcs(t, { check: 'ask' });
  const target = path.join(closed.there, 'Startup');
  mkdirSync(target);
  const tower = { paths: { workspace: path.join(closed.there, 'workspace') }, devices: { self: () => ({ name: 'Tower' }), list: () => [] }, security: { current: () => securityDefaults('secure'), check: (req: { agentId: string }) => (req.agentId === '' ? 'ask' : 'open') } } as never;
  const answer = await receivePiece(tower, { id: '33333333-3333-4333-8333-333333333333', begin: { name: 'run.cmd', folder: false, at: target } }, 'dev_me');
  assert.match(answer.note ?? '', /closed to me on Tower/, 'no agent named: the landing is checked as nobody');
});

test('L5: a begin whose announced size does not fit the free space there is refused with the numbers', async (t) => {
  const pc = pcs(t);
  const tower = { paths: { workspace: path.join(pc.there, 'workspace') }, devices: { self: () => ({ name: 'Tower' }), list: () => [] } } as never;
  await assert.rejects(receivePiece(tower, { id: '44444444-4444-4444-8444-444444444444', begin: { name: 'Huge', folder: true, size: 2 ** 60, agentId: 'ag_a' } }, 'dev_me'),
    /Huge is \d+\.\d GB, and Tower has only .* free where it would land/);
  assert.equal(existsSync(pc.inbox) ? readdirSync(pc.inbox).length : 0, 0);
  writeFileSync(path.join(pc.here, 'small.txt'), 'small');
  assert.equal((await pc.send({ path: path.join(pc.here, 'small.txt') })).ok, true, 'what fits goes');
  assert.equal((pc.calls[0].begin as { size?: number }).size, 5, 'the sender announces the size');
});
