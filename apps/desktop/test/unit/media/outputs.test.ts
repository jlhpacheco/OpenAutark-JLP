// Agent outputs (src/runtime/media/outputs.ts via chat/lifecycle.ts publish): a finished agent
// message whose ```ui blocks name workspace files is announced once, with fileIds, and the
// media rows join the chat; escapes (.., absolute, junction/symlink) and missing files are not
// stored but become repair notes; agent-written fileIds must be visible to the agent; cards,
// file and tabs blocks keep their indexes; a <chat> block's `files` become attachments (B-080: a stored file's own path too,
// under the same visibility check); human
// messages are left alone; a real finishTurn hands ask-block and file notes to the next turn;
// the fileId rules of shared/blocks/validate.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { finishTurn, takeRepairNotes } from '../../../src/runtime/agents/turn-finish.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import type { Paths } from '../../../src/runtime/contracts.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { withMediaHook } from '../../../src/runtime/media/hook.ts';
import { resolveOutput } from '../../../src/runtime/media/outputs.ts';
import { MediaService } from '../../../src/runtime/media/service.ts';
import { MemoryLogger } from '../fakes.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { validateBlock } from '../../../src/shared/blocks/validate.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { setup as turnSetup } from '../agents/fixture.ts';
import { tempDir } from '../store/helpers.ts';
import { png, str } from './fixtures.ts';
import { ChatOutbox } from '../../../src/runtime/agents/chat-out.ts';
import { mediaSetup } from './setup.ts';

const F = '```';

function outputsSetup() {
  const s = mediaSetup();
  const workspace = path.join(s.temp.dir, 'workspace');
  mkdirSync(path.join(workspace, 'out'), { recursive: true });
  s.h.services.paths = { workspace, accounts: path.join(s.temp.dir, 'accounts'), data: s.temp.dir, temp: path.join(s.temp.dir, 'tmp'), blobs: path.join(s.temp.dir, 'blobs') } as Paths;
  const write = (relative: string, bytes: Uint8Array) => {
    const file = path.join(workspace, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return file;
  };
  return { ...s, workspace, write };
}
type Setup = ReturnType<typeof outputsSetup>;

/** The announcement of `id` (message.created, once the outputs are stored – at once when it came already). */
function announced(s: Setup, id: string, event: 'message.updated' | 'message.created' = 'message.created'): Promise<Message> {
  const seen = s.h.of(event).find((message) => message.id === id);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve) => {
    const off = s.h.bus.on(event, (message) => { if (message.id === id) { off(); resolve(message); } });
  });
}

async function finishAgent(s: Setup, body: string, agentId = 'ag_ada'): Promise<{ returned: Message; final: Message }> {
  const returned = s.h.chats.postAgentMessage(s.chat.id, agentId, 'run_1', { body });
  return { returned, final: await announced(s, returned.id) };
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const updatesOf = (s: Setup, id: string) => s.h.of('message.created').filter((message) => message.id === id);

test('a media block with a workspace path is stored, announced once with its fileId and linked to the chat', async () => {
  const s = outputsSetup();
  try {
    const bytes = png(32, 16);
    s.write('out/a.png', bytes);
    const body = `Here is the chart\n${F}ui\n{"type":"media","src":"out/a.png","caption":"Chart"}\n${F}`;
    const started = s.h.chats.postAgentMessage(s.chat.id, 'ag_ada', 'run_1', { body });
    const done = announced(s, started.id);
    assert.equal(started.state, 'final');
    assert.equal(updatesOf(s, started.id).length, 0, 'not announced before the file is stored');
    const final = await done;

    const [{ block }] = uiBlocksOf(final.body);
    assert.equal(block.fileId, sha(bytes));
    assert.equal(block.src, 'out/a.png', 'the path stays for the desktop');
    assert.equal(block.kind, 'image', 'the kind comes from the stored file');
    assert.equal(block.caption, 'Chart');
    assert.ok(final.body.startsWith('Here is the chart\n'));
    assert.equal(s.h.chats.message(started.id)!.body, final.body, 'the rewritten body is persisted');
    assert.equal(updatesOf(s, started.id).length, 1, 'one announcement');
    assert.equal(s.media.get(sha(bytes))!.conversationId, s.chat.id, 'the library shows it under the chat');
    assert.deepEqual(await s.h.services.files.read(sha(bytes)), bytes);
    assert.deepEqual(takeRepairNotes(s.h.services, 'ag_ada', 'main'), []);
    await s.media.idle();
  } finally { s.temp.cleanup(); }
});

test('escapes are rejected: "..", an absolute path outside and a junction/symlink out of the workspace', async () => {
  const s = outputsSetup();
  try {
    const secret = str('top secret');
    const outsideDir = path.join(s.temp.dir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(path.join(outsideDir, 'secret.txt'), secret);
    writeFileSync(path.join(s.temp.dir, 'secret.txt'), secret);
    symlinkSync(outsideDir, path.join(s.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const blocks = [
      { type: 'file', path: '../secret.txt' },
      { type: 'file', path: path.join(s.temp.dir, 'secret.txt') },
      { type: 'media', src: 'link/secret.txt' },
    ];
    const body = `${F}ui\n${JSON.stringify(blocks)}\n${F}`;
    const { final } = await finishAgent(s, body);

    assert.equal(final.body, body, 'nothing was rewritten');
    assert.equal(s.h.services.files.get(sha(secret)), undefined, 'nothing from outside was stored');
    const notes = takeRepairNotes(s.h.services, 'ag_ada', 'main');
    assert.equal(notes.length, 3);
    for (const [index, line] of notes.entries()) {
      assert.ok(line.startsWith(`[file-error block ${index + 1}: `), line); // B-076: counted from 1
      assert.match(line, /is outside the workspace\] I save deliverables inside the workspace folder/);
    }
  } finally { s.temp.cleanup(); }
});

test('a missing file keeps the block and gets a note; human messages are never imported', async () => {
  const s = outputsSetup();
  try {
    const body = `${F}ui\n{"type":"file","path":"out/missing.pdf","label":"Report"}\n${F}`;
    const { final } = await finishAgent(s, body);
    assert.equal(final.body, body);
    const notes = takeRepairNotes(s.h.services, 'ag_ada', 'main');
    assert.deepEqual(notes, ['[file-error block 1: "out/missing.pdf" was not found] I check the path and send the block again.']);

    s.write('out/human.png', png(4, 4));
    const human = s.h.chats.send({ conversationId: s.chat.id, body: `${F}ui\n{"type":"media","src":"out/human.png"}\n${F}`, authorId: 'human' });
    assert.ok(s.h.of('message.created').some((message) => message.id === human.id), 'announced at once');
    assert.equal(s.h.services.files.get(sha(png(4, 4))), undefined);
  } finally { s.temp.cleanup(); }
});

test('fileIds an agent writes stay only when it may see the file', async () => {
  const s = outputsSetup();
  try {
    const shown = await s.put(png(8, 8), 'shown.png');
    s.attach(s.chat.id, shown); // the human shared it in this chat
    const loose = await s.put(png(9, 9), 'loose.png'); // global, never shared with the agent
    const elsewhere = await s.put(png(10, 10), 'ops.png');
    s.attach(s.other.id, elsewhere);
    const body = `${F}ui\n${JSON.stringify([
      { type: 'media', fileId: shown.id, caption: 'Shown' },
      { type: 'media', fileId: loose.id, src: 'out/none.png' },
      { type: 'cards', items: [{ title: 'Ops', image: elsewhere.id }] },
    ])}\n${F}`;
    const { final } = await finishAgent(s, body);
    const blocks = uiBlocksOf(final.body);
    assert.equal(blocks[0].block.fileId, shown.id);
    assert.equal(blocks[1].block.fileId, undefined, 'the invisible id is dropped');
    assert.equal((blocks[2].block.items as Array<{ image?: string }>)[0].image, undefined);
    assert.equal(s.media.get(loose.id)!.conversationId, undefined, 'the global file is not pulled into the chat');
    assert.equal(s.media.get(elsewhere.id)!.conversationId, s.other.id);
    const notes = takeRepairNotes(s.h.services, 'ag_ada', 'main');
    assert.ok(notes.some((line) => line.startsWith('[file-error block 2: file ') && line.includes('is not available to me')));
    assert.ok(notes.some((line) => line.startsWith('[file-error block 2: "out/none.png" was not found]')));
    assert.ok(notes.some((line) => line.startsWith('[file-error block 3: file ')));
    await s.media.idle();
  } finally { s.temp.cleanup(); }
});

test('cards, file and tabs blocks get their files; block indexes and other blocks stay as they were', async () => {
  const s = outputsSetup();
  try {
    const cover = png(12, 6);
    const report = str('quarterly report');
    const inner = png(5, 5);
    s.write('out/cover.png', cover);
    s.write('out/report.txt', report);
    s.write('out/tab.png', inner);
    const body = [
      'Results:',
      `${F}ui\n{"type":"cards","items":[{"title":"Cover","image":"out/cover.png"},{"title":"Site","url":"https://example.invalid"}]}\n${F}`,
      `${F}app title="Calc"\n<p>x</p>\n${F}`,
      `${F}ui\n[{"type":"file","path":"out/report.txt","label":"Report"},{"type":"tabs","tabs":[{"label":"A","blocks":[{"type":"media","src":"out/tab.png"}]}]}]\n${F}`,
      `${F}ui\n{"type":"choice","question":"Ship it?","options":["Yes","No"]}\n${F}`,
    ].join('\n');
    const { final } = await finishAgent(s, body);
    const before = uiBlocksOf(body);
    const after = uiBlocksOf(final.body);
    assert.deepEqual(after.map((item) => [item.index, item.block.type]), before.map((item) => [item.index, item.block.type]));
    assert.deepEqual(after.map((item) => item.index), [0, 2, 3, 4], 'the app fence keeps index 1');

    const cards = after[0].block.items as Array<{ title: string; image?: string; url?: string }>;
    assert.equal(cards[0].image, sha(cover));
    assert.equal(cards[1].url, 'https://example.invalid');
    assert.equal(after[1].block.fileId, sha(report));
    assert.equal(after[1].block.path, path.join(s.workspace, 'out', 'report.txt'), 'relative file paths become absolute for Open');
    const tab = (after[2].block.tabs as Array<{ blocks: Array<{ fileId?: string }> }>)[0].blocks[0];
    assert.equal(tab.fileId, sha(inner));
    assert.deepEqual(after[3].block, before[3].block, 'the ask block is untouched');
    assert.ok(final.body.includes(`${F}app title="Calc"\n<p>x</p>\n${F}`));
    for (const id of [sha(cover), sha(report), sha(inner)]) assert.equal(s.media.get(id)!.conversationId, s.chat.id, id);

    // Publishing the already imported body again changes nothing.
    const again = await finishAgent(s, final.body);
    assert.equal(again.final.body, final.body);
    await s.media.idle();
  } finally { s.temp.cleanup(); }
});

test('<chat files="…"> become attachments; outside paths and invisible ids are left out and named (13.11.2026: the block replaces chat.send)', async () => {
  const s = outputsSetup();
  try {
    const out = new ChatOutbox(s.h.services, { agentId: 'ag_ada', runId: 'run_1' });
    const post = async (text: string, files: string[] = []) => {
      const before = out.posted.length;
      out.segment(`<chat to="${s.chat.id}"${files.length ? ` files="${files.join(', ')}"` : ''}>${text}</chat>`, true);
      await out.done();
      return out.posted.length > before ? s.h.chats.messages(s.chat.id).filter((message) => message.authorId === 'ag_ada').at(-1)! : undefined;
    };
    const report = str('the report');
    s.write('out/report.txt', report);
    const shown = await s.put(png(8, 8), 'shown.png');
    s.attach(s.chat.id, shown);
    const message = (await post('Report attached', ['out/report.txt', shown.id.toUpperCase()]))!;
    assert.deepEqual(message.attachments.map((file) => [file.name, file.fileId]), [['report.txt', sha(report)], ['shown.png', shown.id]]);
    assert.equal(s.media.get(sha(report))!.conversationId, s.chat.id);

    const loose = await s.put(png(9, 9), 'loose.png');
    writeFileSync(path.join(s.temp.dir, 'outside.txt'), str('no'));
    const more = (await post('More', ['../outside.txt', loose.id, 'https://example.invalid/a.png']))!;
    assert.deepEqual(more.attachments, [], 'none of them is attached');
    const note = out.notes.at(-1)!;
    assert.match(note, /"\.\.\/outside\.txt" is outside the workspace\./);
    assert.match(note, /is not available to me\./);
    assert.match(note, /neither a workspace path nor a file id/);

    // B-080: a stored file's own path is that file – attached when I may see it, no new blob.
    const blobs = () => s.h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM files')!.n;
    const stored = blobs();
    const byPath = (await post('The QA shot', [s.h.services.files.path(shown.id)]))!;
    assert.deepEqual(byPath.attachments.map((file) => file.fileId), [shown.id]);
    assert.equal(blobs(), stored, 'no new blob');
    await post('Not mine', [s.h.services.files.path(loose.id)]);
    assert.match(out.notes.at(-1)!, /File [a-f0-9]{12}… is not available to me\./);

    // Blocks in a posted text are imported too (the message is announced with its fileId).
    s.write('out/b.png', png(6, 6));
    const created = new Promise<Message>((resolve) => { const off = s.h.bus.on('message.created', (m) => { if (m.body.includes('out/b.png')) { off(); resolve(m); } }); });
    await post(`${F}ui\n{"type":"media","src":"out/b.png"}\n${F}`);
    assert.equal(uiBlocksOf((await created).body)[0].block.fileId, sha(png(6, 6)));
    await s.media.idle();
  } finally { s.temp.cleanup(); }
});

test('B-080: a ```ui media block whose src is a stored file\'s own path gets that fileId when I may see it, a note when not', async () => {
  const s = outputsSetup();
  try {
    const shown = await s.put(png(8, 8), 'shown.png');
    s.attach(s.chat.id, shown);
    const loose = await s.put(png(9, 9), 'loose.png');
    const src = s.h.services.files.path(shown.id);
    const body = `${F}ui\n${JSON.stringify([{ type: 'media', src, caption: 'QA' }, { type: 'media', src: s.h.services.files.path(loose.id) }])}\n${F}`;
    const { final } = await finishAgent(s, body);
    const blocks = uiBlocksOf(final.body);
    assert.deepEqual([blocks[0].block.fileId, blocks[0].block.src, blocks[0].block.kind], [shown.id, src, 'image'], 'the stored file, its path kept');
    assert.equal(blocks[1].block.fileId, undefined);
    const notes = takeRepairNotes(s.h.services, 'ag_ada', 'main');
    assert.ok(notes.some((line) => line.startsWith('[file-error block 2: file ') && line.includes('is not available to me')), notes.join('\n'));
    await s.media.idle();
  } finally { s.temp.cleanup(); }
});

test('a finished turn: the final message gets its fileId; ask-block and file notes both reach the next turn', async () => {
  const h = turnSetup();
  const temp = tempDir();
  try {
    const log = new MemoryLogger();
    const media = new MediaService({ services: () => h.services, pdfPages: async () => undefined });
    h.services.files = withMediaHook(new Blobs({ db: h.db, blobs: path.join(temp.dir, 'blobs'), clock: h.clock, log }), (file) => media.onFileStored(file), log);
    const workspace = path.join(temp.dir, 'workspace');
    mkdirSync(path.join(workspace, 'out'), { recursive: true });
    const bytes = png(20, 20);
    writeFileSync(path.join(workspace, 'out', 'a.png'), bytes);
    h.services.paths = { workspace, accounts: path.join(temp.dir, 'accounts'), temp: path.join(temp.dir, 'tmp') } as Paths;
    h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Show me the chart' }); // the person's line: the final text answers it (the safety net)
    const request = h.request();
    const plan = (await planTurn(h.services, request))!;
    const body = [
      `${F}ui\n{"type":"media","src":"out/a.png"}\n${F}`,
      `${F}ui\n{"type":"choice","question":"Pick one"}\n${F}`,
      `${F}ui\n{"type":"file","path":"out/gone.txt"}\n${F}`,
    ].join('\n');
    const done = new Promise<Message>((resolve) => { const off = h.bus.on('message.created', (m) => { if (m.runId === request.runId) { off(); resolve(m); } }); });
    finishTurn(h.services, plan, h.routed(), request, h.attempt({ text: body, stop: 'done' }));
    const final = await done;
    assert.equal(final.state, 'final');
    assert.equal(uiBlocksOf(final.body)[0].block.fileId, sha(bytes));
    assert.equal(media.get(sha(bytes))!.conversationId, h.chat.id);
    const notes = takeRepairNotes(h.services, h.tom.id, 'main');
    assert.ok(notes.some((line) => line.startsWith('[ui-error block "Pick one" (2nd block): ')), notes.join('\n')); // B-076: named, counted from 1
    assert.ok(notes.includes('[file-error block 3: "out/gone.txt" was not found] I check the path and send the block again.'), notes.join('\n'));
    await media.idle();
  } finally { temp.cleanup(); }
});

test('validate: media/file keep a 64-hex fileId only; a fileId stands in for a missing src or path', () => {
  const id = 'AB'.repeat(32);
  const media = validateBlock({ type: 'media', fileId: id });
  assert.ok(media.ok);
  assert.equal(media.block.fileId, id.toLowerCase());
  assert.equal(media.block.src, id.toLowerCase());
  const aliased = validateBlock({ type: 'image', url: 'out/a.png', fileId: id });
  assert.ok(aliased.ok);
  assert.deepEqual([aliased.block.src, aliased.block.kind], ['out/a.png', 'image']);
  const junk = validateBlock({ type: 'media', src: 'a.png', fileId: '../etc/passwd' });
  assert.ok(junk.ok);
  assert.equal(junk.block.fileId, undefined);
  assert.ok(junk.warnings.includes('dropped invalid "fileId"'));
  const file = validateBlock({ type: 'file', fileId: id, label: 'Cut' });
  assert.ok(file.ok);
  assert.equal(file.block.path, undefined);
  const none = validateBlock({ type: 'file', label: 'Cut' });
  assert.deepEqual(none.ok ? undefined : none.error, '"path" missing in file');
  assert.ok(validateBlock({ type: 'file', src: 'C:/out/a.mp4' }).ok, 'path aliases still work');
});

test('an account home is never an output, also in a workspace that holds the data folder: the logins folder and <data>/accounts', async () => {
  const temp = tempDir();
  try {
    const data = path.join(temp.dir, 'data');
    const paths = { workspace: temp.dir, data, accounts: path.join(temp.dir, 'logins'), blobs: path.join(data, 'blobs') };
    for (const file of [path.join(paths.accounts, 'claude', 'acc_a', 'x.txt'), path.join(data, 'accounts', 'claude', 'acc_mac', 'x.txt'), path.join(temp.dir, 'out', 'x.txt')]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'x');
    }
    assert.deepEqual(await resolveOutput(paths, 'logins/claude/acc_a/x.txt'), { refused: 'outside' });
    assert.deepEqual(await resolveOutput(paths, 'data/accounts/claude/acc_mac/x.txt'), { refused: 'outside' }, 'a home that stayed in the data folder');
    assert.ok('path' in await resolveOutput(paths, 'out/x.txt'));
  } finally { temp.cleanup(); }
});
