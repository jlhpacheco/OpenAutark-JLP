// The <chat> blocks of the one-context model (agents/chat-out.ts), the chat overview line (context/chat-overview.ts) and
// the line label (context/render.ts lineLabel): several blocks and addresses, push/quiet, files, an unterminated block,
// posting once as the closing tag arrives, a block to a chat I am no member of, an @mention of the person from a quiet
// line, and a push line that reaches every agent of a group.
// Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatOutbox, chatBlocks, notMemberNote } from '../../../src/runtime/agents/chat-out.ts';
import { chatOverview, overviewLine, oneLine } from '../../../src/runtime/context/chat-overview.ts';
import { lineLabel } from '../../../src/runtime/context/render.ts';
import { renderContext } from '../../../src/runtime/context/delta.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent, harness } from '../chat/harness.ts';

test('chatBlocks: several blocks, several addresses, push and quiet, files – the rest stays outside', () => {
  const text = 'I look at both.\n<chat to="ch_a ch_b" push>Release is out.</chat>\nmore thinking\n<chat to="ch_c" quiet files="out/a.png, out/b.pdf">\nFor the record.\n</chat>';
  const { blocks, rest, open } = chatBlocks(text);
  assert.equal(open, false);
  assert.deepEqual(blocks, [
    { to: ['ch_a', 'ch_b'], level: 'push', files: [], body: 'Release is out.' },
    { to: ['ch_c'], level: 'quiet', files: ['out/a.png', 'out/b.pdf'], body: 'For the record.' },
  ]);
  assert.equal(rest, 'I look at both.\n\nmore thinking');
  assert.deepEqual(chatBlocks('<chat to="ch_a, ch_b">Hi</chat>').blocks[0].to, ['ch_a', 'ch_b'], 'commas separate too');
  assert.equal(chatBlocks('<chat to="ch_a">Hi</chat>').blocks[0].level, 'normal');
});

test('chatBlocks: an unterminated block waits mid-stream and closes at the end of the final text', () => {
  const mid = chatBlocks('Done.\n<chat to="ch_a">Half of it');
  assert.deepEqual([mid.blocks.length, mid.open], [0, true]);
  const final = chatBlocks('Done.\n<chat to="ch_a">All of it', { final: true });
  assert.deepEqual(final.blocks, [{ to: ['ch_a'], level: 'normal', files: [], body: 'All of it' }]);
  assert.equal(final.rest, 'Done.');
});

function room() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  h.org.add(agent('ag_max', 'Max'));
  const mine = h.chats.create({ title: 'Rechnungen', agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  const group = h.chats.create({ title: 'Kernteam', agentIds: ['ag_tom', 'ag_lea', 'ag_max'], createdBy: HUMAN_ID });
  const foreign = h.chats.create({ title: 'Other', agentIds: ['ag_lea'], createdBy: HUMAN_ID });
  const runs: Array<{ kind: string; data?: unknown }> = [];
  h.services.runs = { item: (_runId: string, item: { kind: string; data?: unknown }) => { runs.push(item); } } as unknown as typeof h.services.runs;
  const tom = (chatId: string) => h.chats.messages(chatId, { limit: 50 }).filter((message) => message.authorId === 'ag_tom');
  return { ...h, mine, group, foreign, runs, tom };
}

test('the outbox posts a block once, as soon as its closing tag arrives, with its level; a foreign chat gets a note', async () => {
  const h = room();
  const out = new ChatOutbox(h.services, { agentId: 'ag_tom', runId: 'run_1' });
  out.text(`Thinking… <chat to="${h.mine.id} ${h.foreign.id}" push>Paid`);
  await out.done();
  assert.deepEqual(h.tom(h.mine.id), [], 'not before the closing tag');
  out.text(' the invoice.</chat> and on');
  await out.done();
  out.segment(`Thinking… <chat to="${h.mine.id} ${h.foreign.id}" push>Paid the invoice.</chat>`, true); // the same block in the final text
  await out.done();
  const posted = h.tom(h.mine.id);
  assert.deepEqual(posted.map((message) => [message.body, message.priority, message.silent, message.runId]), [['Paid the invoice.', 'important', false, 'run_1']]);
  assert.deepEqual(h.tom(h.foreign.id), []);
  assert.deepEqual(out.notes, [notMemberNote(h.foreign.id)]);
  assert.deepEqual(out.posted, [h.mine.id]);
  assert.ok(h.runs.some((item) => (item.data as { chatOut?: string }).chatOut === notMemberNote(h.foreign.id)), 'the run log names it');
});

test('a quiet line: no unread, no notification – but an @mention of the person reaches them (a reply: only push rings)', async () => {
  const h = room();
  const out = new ChatOutbox(h.services, { agentId: 'ag_tom', runId: 'run_1' });
  out.segment(`<chat to="${h.mine.id}" quiet>Noted for the record.</chat>`, true);
  await out.done();
  assert.equal(h.tom(h.mine.id)[0].silent, true);
  assert.equal(h.notified.length, 0);
  out.segment(`<chat to="${h.mine.id}" quiet>@CEO the upload needs your code.</chat>`, true);
  await out.done();
  assert.equal(h.tom(h.mine.id)[1].silent, false, 'a quiet line that names the person is a normal line');
  assert.deepEqual(h.notified.map((note) => note.kind), ['reply'], 'KI-Runde 17.11.2026: the @mention by an agent addresses the person and does not ring them');
});

test('a push line in a group reaches every other agent there at once', async () => {
  const h = room();
  const out = new ChatOutbox(h.services, { agentId: 'ag_tom', runId: 'run_1' });
  out.segment(`<chat to="${h.group.id}" push>Stop – the API key is revoked.</chat>`, true);
  await out.done();
  assert.deepEqual(h.urgent.map((item) => item.agentId).sort(), ['ag_lea', 'ag_max']);
});

test('"## My chats": a stable line per chat; unseen lines of others get one news mark, never in the waking chat; each line names its chat', () => {
  const h = room();
  const before = chatOverview(h.services, 'ag_tom');
  assert.ok(before.startsWith('## My chats\n') && before.includes(`\n${h.mine.id} · Rechnungen`), before);
  const line = before.split('\n').find((entry) => entry.startsWith(h.mine.id))!;
  assert.match(line, / · .+ reads here$/, 'KI-Runde 17.11.2026: a chat the person is in says so');
  h.chats.send({ conversationId: h.mine.id, authorId: HUMAN_ID, body: `Bitte prüfen: ${'x'.repeat(200)}` });
  const summary = h.chats.list({ forMember: 'ag_tom', includeHidden: true }).find((chat) => chat.id === h.mine.id)!;
  assert.equal(overviewLine(h.services, summary, 'ag_tom'), line, 'the line itself never changes with a post');
  const marked = chatOverview(h.services, 'ag_tom').split('\n').find((line) => line.startsWith(h.mine.id))!;
  assert.match(marked, / · 1 new · newest \S+ \w{3} \d+ \w{3} \d\d:\d\d: "Bitte prüfen: x+…"$/, marked);
  assert.equal(chatOverview(h.services, 'ag_tom', h.mine.id), before, 'the chat whose lines come in this input: no mark');
  assert.equal(oneLine('a\n b   c'), 'a b c');
  const [message] = h.chats.messages(h.mine.id, { limit: 1 });
  assert.match(lineLabel(renderContext(h.services, 'ag_tom'), message), new RegExp(`^\\[${h.mine.id} "Rechnungen" · CEO · \\d\\d:\\d\\d #${message.seq}\\]$`));
});

test('a block that only imitates a call ("[ran …]") is never posted; the run log notes it (feedback 33b2e3af, 20.11.)', async () => {
  const h = room();
  const out = new ChatOutbox(h.services, { agentId: 'ag_tom', runId: 'run_1' });
  out.segment(`<chat to="${h.mine.id}">[ran WebSearch: {"query":"best text to speech API"}]</chat>\n<chat to="${h.mine.id}">Real answer.</chat>`, true);
  await out.done();
  assert.deepEqual(h.tom(h.mine.id).map((message) => message.body), ['Real answer.']);
  assert.ok(out.notes.some((line) => line.includes('only imitated a tool call')));
});

test('"[ran out of …" at the start of a block is prose and posts (review 20.11.)', async () => {
  const h = room();
  const out = new ChatOutbox(h.services, { agentId: 'ag_tom', runId: 'run_1' });
  out.segment(`<chat to="${h.mine.id}">[ran out of time on the export – it continues tomorrow]</chat>`, true);
  await out.done();
  assert.equal(h.tom(h.mine.id).length, 1);
});
