// Real synthetic files only: the new writer is unavailable, not falsely marked safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { ManualClock } from '../fakes.ts';
import { skillId } from '../../../src/runtime/skills/editor.ts';
const code = (value: string) => (error: unknown) => (error as { code?: string }).code === value;
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-skill-editor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), resources = path.join(root, 'resources'), home = path.join(root, 'home');
  const skills = new SkillLibrary({ paths: { workspace, resources }, home, clock: new ManualClock() });
  const put = (base: string, name: string, raw: string) => {
    const dir = path.join(base, name); mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md'); writeFileSync(file, raw); return file;
  };
  const seed = (name: string) => {
    const file = put(path.join(workspace, 'skills'), name, `---\nname: ${name}\ndescription: purpose\n---\nOriginal`);
    return skills.open(skillId(file));
  };
  return { root, workspace, resources, home, skills, put, seed };
}

test('new edit is unavailable BEFORE mutation; open reports read-only and keeps exact text', t => {
  const f = fixture(t), doc = f.seed('own-skill'), file = path.join(doc.info.path, 'SKILL.md');
  assert.equal(doc.info.id, skillId(file)); assert.equal(doc.readOnly, true);
  assert.match(doc.readOnlyReason!, /Read-only: safe saving/);
  const before = readFileSync(file), draft = '\n# Draft\nä 🙂\n';
  for (const body of [draft, '']) assert.throws(() => f.skills.edit(doc.info.id!, doc.revision, body), code('unavailable'));
  assert.ok(readFileSync(file).equals(before));
  assert.equal(f.skills.open(doc.info.id!).revision, doc.revision);
  assert.deepEqual(readdirSync(path.dirname(file)), ['SKILL.md']);
});

test('all same-name copies stay byte-exact; builtin/imported keep their own forbidden boundary', t => {
  const f = fixture(t);
  const head = '\uFEFF---\r\nname: duplicate\r\nmetadata: { foreign: keep } # custom\r\n---  \r\n';
  const files = [
    f.put(path.join(f.workspace, 'skills'), 'duplicate', head + 'Shared'),
    f.put(path.join(f.workspace, 'agents/a/skills'), 'duplicate', head + 'Agent'),
    f.put(path.join(f.resources, 'skills'), 'duplicate', head + 'Builtin'),
    f.put(path.join(f.home, '.codex/skills'), 'duplicate', head + 'Imported'),
    f.put(path.join(f.root, 'main'), 'duplicate', head + 'Main'),
  ];
  const skills = new SkillLibrary({ paths: f, home: f.home, clock: new ManualClock(), mainRoots: () => [{ dir: path.join(f.root, 'main'), ownerAgentId: 'a' }] });
  const catalog = skills.catalog(); assert.equal(catalog.length, 5); assert.equal(new Set(catalog.map(x => x.id)).size, 5);
  const before = files.map(file => readFileSync(file));
  for (const [i, file] of files.entries()) {
    const doc = skills.open(skillId(file)); assert.equal(doc.readOnly, true);
    assert.throws(() => skills.edit(doc.info.id!, doc.revision, 'draft'), code([2,3].includes(i) ? 'forbidden' : 'unavailable'));
  }
  files.forEach((file,i) => assert.ok(readFileSync(file).equals(before[i])));
});

test('stale revision still conflicts; reopen does not silently enable the unsafe writer', t => {
  const f = fixture(t), doc = f.seed('changed'), file = path.join(doc.info.path, 'SKILL.md');
  const original = readFileSync(file, 'utf8');
  for (const changed of [original + 'External', original.replace('purpose', 'external metadata')]) {
    writeFileSync(file, changed);
    assert.throws(() => f.skills.edit(doc.info.id!, doc.revision, 'draft'), code('conflict'));
    assert.equal(readFileSync(file, 'utf8'), changed);
  }
  const latest = f.skills.open(doc.info.id!);
  assert.throws(() => f.skills.edit(doc.info.id!, latest.revision, 'retried'), code('unavailable'));
});

test('deleted, recreated and renamed targets conflict without recreating', t => {
  const f = fixture(t), doc = f.seed('deleted'), file = path.join(doc.info.path, 'SKILL.md');
  const raw = readFileSync(file); rmSync(file);
  assert.throws(() => f.skills.edit(doc.info.id!, doc.revision, 'draft'), code('conflict'));
  writeFileSync(file, raw);
  assert.throws(() => f.skills.edit(doc.info.id!, doc.revision, 'draft'), code('conflict'));
  const current = f.skills.open(doc.info.id!); renameSync(doc.info.path, doc.info.path + '-moved');
  assert.throws(() => f.skills.edit(doc.info.id!, current.revision, 'draft'), code('conflict'));
  assert.ok(readFileSync(path.join(doc.info.path + '-moved', 'SKILL.md')).equals(raw));
});

test('new create fails closed with no directories, legacy save remains usable', t => {
  const f = fixture(t);
  assert.throws(() => f.skills.create('new', 'purpose'), code('unavailable'));
  assert.deepEqual(readdirSync(f.root), []);
  const legacy = f.skills.save({ name: 'desktop', description: 'purpose', body: '# Existing desktop API' });
  assert.match(readFileSync(path.join(legacy.path, 'SKILL.md'), 'utf8'), /Existing desktop API/);
  const original = readFileSync(path.join(legacy.path, 'SKILL.md'));
  assert.throws(() => f.skills.create('desktop', 'overwrite'), code('conflict'));
  assert.ok(readFileSync(path.join(legacy.path, 'SKILL.md')).equals(original));
});

test('junction copies cannot read or overwrite an outside original', t => {
  const f = fixture(t), outside = f.put(f.root, 'outside', '---\nname: outside\n---\nPrivate');
  mkdirSync(path.join(f.workspace, 'skills'), { recursive: true });
  const link = path.join(f.workspace, 'skills/redirect'); symlinkSync(path.dirname(outside), link, 'junction');
  assert.equal(f.skills.catalog().length, 0);
  assert.throws(() => f.skills.open(skillId(path.join(link, 'SKILL.md'))), code('conflict'));
  rmSync(link); rmdirSync(path.join(f.workspace, 'skills')); symlinkSync(f.root, path.join(f.workspace, 'skills'), 'junction');
  assert.throws(() => f.skills.create('new', 'purpose'), code('unavailable'));
  assert.equal(readFileSync(outside, 'utf8'), '---\nname: outside\n---\nPrivate');
});

test('invalid bodies stay bad_request; empty body also cannot reach an unsafe save', t => {
  const f = fixture(t), file = f.put(path.join(f.workspace, 'skills'), 'bare', '# Bare\n');
  const doc = f.skills.open(skillId(file));
  for (const body of ['---\nname: other\n---\n', 'x\0', 'x'.repeat(200_001)])
    assert.throws(() => f.skills.edit(doc.info.id!, doc.revision, body), code('bad_request'));
  assert.throws(() => f.skills.edit(doc.info.id!, doc.revision, ''), code('unavailable'));
  assert.equal(readFileSync(file, 'utf8'), '# Bare\n');
});

test.todo('metadata-preserving supported NTFS save/create/reopen: blocked, NOT a successful editor');
