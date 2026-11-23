// The public library over HTTPS (runtime/library/hub.ts, publish.ts, tools/builtin/library.ts, skills.ts from:) against a
// small local stand-in of services/library: find/open/share/rate send what the server expects, publishing stops at each
// check before anything goes out, skills.save from: writes the entry's files beside my own text and records
// derived-from, carryFiles keeps what is mine, and library.find names a skill whose entry changed.
// Owns: these assertions only. Never: the real library server or a real model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEntries, openEntry, rateEntry, shareEntry } from '../../../src/runtime/library/hub.ts';
import { publishEntry, type PublishDeps } from '../../../src/runtime/library/publish.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { LibraryItem } from '../../../src/shared/model/library.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { parseFrontMatter } from '../../../src/runtime/skills/frontmatter.ts';
import { ManualClock } from '../fakes.ts';
import { carryFiles, skillTools } from '../../../src/runtime/tools/builtin/skills.ts';
import { libraryTools } from '../../../src/runtime/tools/builtin/library.ts';

const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'library-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

const PDF: LibraryItem = {
  id: 'pdf', kind: 'skill', name: 'pdf', description: 'Fill and merge PDF forms.', license: 'Apache-2.0', source: 'anthropics/skills/skills/pdf',
  author: 'Anthropic', rev: 'aaaaaaaaaaaa', rating: 4.5, votes: 2, uses: 7, updated: '2026-11-14', body: '# PDF\nTheir steps.',
  files: { 'scripts/fill.py': 'print(1)', 'reference.md': '# Ref', '.hidden/x': 'no', 'nested/SKILL.md': 'no' }, notes: [{ stars: 5, note: 'Worked first time.', day: '2026-11-14' }],
};

/** A stand-in of services/library: the four routes, every request kept. */
async function library(entries: LibraryItem[] = [PDF]) {
  const seen: Array<{ method: string; url: string; body?: unknown }> = [];
  const read = (request: IncomingMessage) => new Promise<string>((resolve) => { let data = ''; request.on('data', (chunk) => { data += chunk; }); request.on('end', () => resolve(data)); });
  const server: Server = createServer(async (request, response) => {
    const raw = await read(request);
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
    seen.push({ method: request.method ?? '', url: request.url ?? '', ...(body ? { body } : {}) });
    const url = new URL(request.url ?? '/', 'http://x');
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/find') {
      const words = url.searchParams.get('q') ?? '';
      return send(200, { entries: entries.filter((entry) => !words || `${entry.name} ${entry.description}`.toLowerCase().includes(words.toLowerCase())).map(({ body: _b, files: _f, notes: _n, ...hit }) => hit) });
    }
    if (url.pathname.startsWith('/get/')) {
      const entry = entries.find((item) => item.id === decodeURIComponent(url.pathname.slice(5)));
      return entry ? send(200, entry) : send(404, { error: 'No such entry.' });
    }
    if (url.pathname === '/share') return send(200, { id: String(body?.name), rev: 'bbbbbbbbbbbb', license: 'CC0-1.0' });
    if (url.pathname === '/rate') return send(200, { id: String(body?.id), rating: Number(body?.stars), votes: 1 });
    send(404, { error: 'Not found.' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const before = process.env.AUTARK_LIBRARY_URL;
  process.env.AUTARK_LIBRARY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    seen,
    done: async () => {
      if (before === undefined) delete process.env.AUTARK_LIBRARY_URL; else process.env.AUTARK_LIBRARY_URL = before;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('hub: find, open, share and rate send what the server expects; an error answer comes back as its text', async () => {
  const lib = await library();
  try {
    const hits = await findEntries({ words: 'pdf forms', kind: 'skill' });
    assert.deepEqual(hits.map((hit) => [hit.id, hit.rating, hit.license]), [['pdf', 4.5, 'Apache-2.0']]);
    assert.equal(lib.seen[0].url, '/find?q=pdf+forms&kind=skill&limit=10');
    assert.deepEqual(Object.keys((await openEntry('pdf')).files).sort(), ['.hidden/x', 'nested/SKILL.md', 'reference.md', 'scripts/fill.py']);
    await assert.rejects(openEntry('nothing'), /No such entry\./);
    assert.deepEqual(await shareEntry({ kind: 'note', name: 'tip', description: 'A short tip for teams.', body: 'Twenty characters or more.', voter: 'v'.repeat(48) }), { id: 'tip', rev: 'bbbbbbbbbbbb', license: 'CC0-1.0' });
    assert.deepEqual(await rateEntry({ id: 'pdf', stars: 5, voter: 'v'.repeat(48) }), { id: 'pdf', rating: 5, votes: 1 });
    assert.deepEqual(lib.seen.filter((call) => call.method === 'POST').map((call) => call.url), ['/share', '/rate']);
  } finally { await lib.done(); }
});

const SKILL = '---\nname: git-commits\ndescription: I use this when I write commit messages.\n---\n\n# Git commits\nSay what changed and why, in the imperative.';

function publishDeps(over: Partial<PublishDeps> = {}) {
  const shared: unknown[] = [];
  const check: StructuredRunner = async () => ({ text: '', structured: { internal: false, found: [] }, by: 'fake' });
  const deps: PublishDeps = {
    enabled: () => true, redact: (text) => text.replace(/hunter2/g, 'secret://pw'), check,
    share: async (entry) => { shared.push(entry); return { id: entry.name, rev: 'cccccccccccc' }; }, ...over,
  };
  return { deps, shared };
}

test('publish: off, a stored secret, a path of this PC and the model check each keep the text here; nothing is sent', async () => {
  const { deps, shared } = publishDeps();
  const off = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, { ...deps, enabled: () => false });
  assert.deepEqual([off.ok, !off.ok && off.reason], [false, 'off']);
  const secret = await publishEntry({ kind: 'skill', name: 'git-commits', text: `${SKILL}\nThe password is hunter2.` }, deps);
  assert.equal(!secret.ok && secret.reason, 'secret');
  const local = await publishEntry({ kind: 'skill', name: 'git-commits', text: `${SKILL}\nLogs are in C:\\Users\\alex\\logs.` }, deps);
  assert.equal(!local.ok && local.reason, 'internal');
  const mail = await publishEntry({ kind: 'note', name: 'contact', text: `${SKILL}\nWrite to maria@acme.de.` }, deps);
  assert.equal(!mail.ok && mail.reason, 'internal');
  const flagged = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, { ...deps, check: async () => ({ text: '', structured: { internal: true, found: ['customer Müller'] }, by: 'fake' }) });
  assert.ok(!flagged.ok && flagged.reason === 'internal' && flagged.text.includes('customer Müller'));
  for (const line of ['Run `cp /home/anna/acme/keys .` first.', 'Keys sit in "~/acme/keys".', 'The share is \\\\fileserver\\team.']) {
    const quoted = await publishEntry({ kind: 'skill', name: 'git-commits', text: `${SKILL}\n${line}` }, deps);
    assert.equal(!quoted.ok && quoted.reason, 'internal', line);
  }
  const prompts: string[] = [];
  const named = await publishEntry({ kind: 'skill', name: 'kunde-mueller-gmbh-export', text: SKILL }, { ...deps, check: async (input) => { prompts.push(input.prompt); return { text: '', structured: { internal: true, found: ['customer name'] }, by: 'fake' }; } });
  assert.equal(!named.ok && named.reason, 'internal');
  assert.ok(prompts[0].startsWith('kunde-mueller-gmbh-export\n'), 'the model sees the public name too');
  const nobody = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, { ...deps, check: undefined });
  assert.equal(!nobody.ok && nobody.reason, 'no-check');
  assert.equal(shared.length, 0, 'nothing went out');
  for (const result of [off, secret, local, flagged, nobody]) assert.ok(!result.ok && !/\b(you|may|must|allowed)\b/i.test(result.text), 'first person, no permission words');
});

test('publish: a clean text goes out with its name, description and body, and comes back with its address', async () => {
  const { deps, shared } = publishDeps();
  const done = await publishEntry({ kind: 'skill', name: 'Git Commits', text: SKILL }, deps);
  assert.ok(done.ok);
  assert.match(done.url, /\/get\/git-commits$/);
  assert.deepEqual(shared, [{ kind: 'skill', name: 'git-commits', description: 'I use this when I write commit messages.', body: '# Git commits\nSay what changed and why, in the imperative.' }]);
  const failed = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, { ...deps, share: async () => { throw new Error('At most 20 shares an hour from one place.'); } });
  assert.ok(!failed.ok && failed.reason === 'failed' && /20 shares/.test(failed.text));
});

test('carryFiles: plain files at their paths; never SKILL.md, a hidden path, a path outside, or a file of mine', () => {
  const t = temp();
  try {
    writeFileSync(path.join(t.dir, 'SKILL.md'), 'mine');
    const first = carryFiles({ 'SKILL.md': 'theirs', 'scripts/fill.py': 'print(1)', 'reference.md': '# Ref', '.git/config': 'x', 'a/.env': 'x', 'nested/SKILL.md': 'x', '../outside.txt': 'x' }, t.dir);
    assert.deepEqual(first.sort(), ['reference.md', 'scripts/fill.py']);
    assert.equal(readFileSync(path.join(t.dir, 'SKILL.md'), 'utf8'), 'mine');
    assert.ok(!existsSync(path.join(t.dir, '.git')) && !existsSync(path.join(t.dir, 'a')) && !existsSync(path.join(t.dir, 'nested')) && !existsSync(path.join(t.dir, '..', 'outside.txt')));
    writeFileSync(path.join(t.dir, 'scripts', 'fill.py'), 'print(2) # adapted');
    assert.deepEqual(carryFiles({ 'scripts/fill.py': 'print(1)' }, t.dir), []);
    assert.equal(readFileSync(path.join(t.dir, 'scripts', 'fill.py'), 'utf8'), 'print(2) # adapted', 'what I adapted stays mine');
  } finally { t.done(); }
});

function skillContext(dir: string) {
  const clock = new ManualClock();
  const skills = new SkillLibrary({ paths: { workspace: path.join(dir, 'ws'), resources: path.join(dir, 'res') }, clock, home: '' });
  const ctx = { services: { skills, paths: { data: path.join(dir, 'data'), workspace: path.join(dir, 'ws') }, clock, modes: { list: () => [] } }, agent: { id: 'ag_a' } } as never;
  return { skills, ctx };
}
const textOf = (output: unknown) => (output as { content: Array<{ text: string }> }).content[0].text;

test('skills.save from: the entry\'s files beside my own text, derived-from library:<id>@<rev>, its license; an unknown entry saves nothing', async () => {
  const t = temp();
  const lib = await library();
  try {
    const { skills, ctx } = skillContext(t.dir);
    const save = skillTools.find((tool) => tool.name === 'skills.save')!;
    const out = JSON.parse(textOf(await save.run({ name: 'pdf-forms', description: 'I fill PDF forms the way that works here.', body: 'My own steps.', from: 'pdf' } as never, ctx))) as { derivedFrom: string; carried: string[]; folder: string; license: string };
    assert.deepEqual([out.derivedFrom, out.carried.sort(), out.license], ['library:pdf@aaaaaaaaaaaa', ['reference.md', 'scripts/fill.py'], 'Apache-2.0']);
    const text = readFileSync(path.join(out.folder, 'SKILL.md'), 'utf8');
    assert.deepEqual(parseFrontMatter(text).data['derived-from'], ['library:pdf@aaaaaaaaaaaa']);
    assert.match(text, /My own steps\./);
    assert.doesNotMatch(text, /Their steps/);
    assert.equal(readFileSync(path.join(out.folder, 'scripts', 'fill.py'), 'utf8'), 'print(1)');
    const missing = await save.run({ name: 'x-skill', body: 'b', from: 'nothing' } as never, ctx) as { isError?: boolean };
    assert.equal(missing.isError, true);
    assert.equal(skills.get('x-skill', 'ag_a'), undefined, 'nothing saved without its entry');
  } finally { await lib.done(); t.done(); }
});

test('derived-from: a re-save keeps it, a newer rev of the same entry replaces the old one', () => {
  const t = temp();
  try {
    const { skills } = skillContext(t.dir);
    const derived = () => parseFrontMatter(readFileSync(path.join(t.dir, 'ws', 'agents', 'ag_a', 'skills', 'pdf-forms', 'SKILL.md'), 'utf8')).data['derived-from'];
    skills.save({ name: 'pdf-forms', description: 'I fill PDF forms.', body: 'My steps.', ownerAgentId: 'ag_a', derivedFrom: ['library:pdf@aaaaaaaaaaaa'] });
    skills.save({ name: 'pdf-forms', description: 'I fill PDF forms.', body: 'My steps, better.', ownerAgentId: 'ag_a' });
    assert.deepEqual(derived(), ['library:pdf@aaaaaaaaaaaa'], 'kept on a re-save without it');
    skills.save({ name: 'pdf-forms', description: 'I fill PDF forms.', body: 'Again.', ownerAgentId: 'ag_a', derivedFrom: ['library:forms@bbbbbbbbbbbb', 'library:pdf@cccccccccccc'] });
    assert.deepEqual(derived(), ['library:forms@bbbbbbbbbbbb', 'library:pdf@cccccccccccc']);
  } finally { t.done(); }
});

test('library.find lists hits with rating and license; without words it names my skill whose entry changed; library.open marks it as strangers\' text', async () => {
  const t = temp();
  const lib = await library();
  try {
    const { skills, ctx } = skillContext(t.dir);
    skills.save({ name: 'pdf-forms', description: 'I fill PDF forms.', body: 'My steps.', ownerAgentId: 'ag_a', derivedFrom: ['library:pdf@000000000000'] });
    skills.save({ name: 'same-pdf', description: 'I fill PDF forms too.', body: 'Steps.', ownerAgentId: 'ag_a', derivedFrom: ['library:pdf@aaaaaaaaaaaa'] });
    const tool = (name: string) => libraryTools.find((item) => item.name === name)!;
    const found = textOf(await tool('library.find').run({ words: 'pdf' } as never, ctx));
    assert.match(found, /^- pdf · skill – Fill and merge PDF forms\. · ★4\.5 \(2\) · Apache-2\.0, Anthropic$/m);
    const browse = textOf(await tool('library.find').run({} as never, ctx));
    assert.match(browse, /my skill pdf-forms came from pdf, which changed/);
    assert.doesNotMatch(browse, /same-pdf/);
    const opened = textOf(await tool('library.open').run({ id: 'pdf' } as never, ctx));
    assert.match(opened, /^From the public library Anthropic, Apache-2\.0, written by strangers/);
    assert.match(opened, /skills\.save with from: "pdf"/);
  } finally { await lib.done(); t.done(); }
});
