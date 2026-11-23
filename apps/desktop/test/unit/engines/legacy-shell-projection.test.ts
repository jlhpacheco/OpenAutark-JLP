// 0.3.19, the masked engine shell: no path that turns the ledger back into model context replays an old native shell or an
// unmarked script aggregate – the Codex and Claude rebuilds, the text history, the carried trace, the automatic lean
// marks, the journal originals, context.restore, the ledger view/trace and the subconscious's context.read. A managed
// shell.exec call is kept. Ported from the reviewed draft's fixture tests (fixture-tests/projection.test.mjs), unchanged in
// substance; the row mark that lets a marked script replay is covered in context/ledger-code-mode.test.ts.
// Owns: these assertions only. Never: a real key or a real transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { historyText } from '../../../src/runtime/agents/history-text.ts';
import { carriedCalls } from '../../../src/runtime/context/ledger/marks.ts';
import { leanMarks } from '../../../src/runtime/context/ledger/window.ts';
import { responseItems } from '../../../src/runtime/engines/codex/rebuild.ts';
import { transcriptMessages } from '../../../src/runtime/engines/claude/transcript.ts';
import { ContextLedgerService } from '../../../src/runtime/context/ledger/service.ts';
import { restoreItems } from '../../../src/runtime/context/ledger/restore.ts';
import { contextTools } from '../../../src/runtime/subconscious/context-tools.ts';

const unrelated = {
  itemId: 't5', runId: 'past', role: 'tool', kind: 'tool', state: 'keep', origin: { engine: 'codex' }, text: 'managed sample',
  call: { name: 'shell.exec', callId: 'tool_fixture', args: { command: 'ordinary managed argument' }, output: 'managed sample' },
};
const old = [
  { name: 'Bash', engine: 'claude' },
  { name: 'PowerShell', engine: 'claude' },
  { name: 'shell', engine: 'codex' },
  { name: 'exec', engine: 'codex' },
  { name: 'wait', engine: undefined },
].map(({ name, engine }, i) => ({
  ...unrelated, itemId: `t${i + 10}`, origin: { engine }, text: 'historical output sample', call: {
    name, callId: `old_${i}`, own: true, args: { source: 'historical input sample', command: 'historical input sample' },
    output: 'historical output sample\n'.repeat(100),
  },
}));
const entries = [...old, unrelated];
const ledger = { view: () => entries, traceView: () => entries };
const svc = { ledger, log: { warn() {}, debug() {} } };
const options = { accountId: 'fixture', model: 'fixture', platform: 'win32', offered: new Set(['shell.exec']) };

for (const [name, render] of [['Codex', responseItems], ['Claude', transcriptMessages]] as const) {
  test(`${name} rebuild drops native commands and unproven script output; keeps managed calls`, () => {
    const out = JSON.stringify((render as (items: never, target: never) => unknown)(entries as never, options as never));
    assert.doesNotMatch(out, /historical (input|output) sample/);
    assert.match(out, /omitted: 5/);
    assert.match(out, /managed sample/);
  });
}

test('the text history never carries old native calls or unknown script aggregates', () => {
  const out = historyText(svc as never, 'agent', 'thread', 9999) ?? '';
  assert.doesNotMatch(out, /historical (input|output) sample/);
  assert.match(out, /omitted: 1/);
  assert.match(out, /managed sample/);
});

test('the carried trace leaves out legacy native calls and unknown aggregates', () => {
  const out = carriedCalls(svc as never, 'agent', 'thread', 'now');
  assert.deepEqual(out.map((call) => call.tool), ['shell.exec']);
  assert.match(out[0].output ?? '', /managed sample/);
});

test('automatic lean marks cannot persist a legacy excerpt', () => {
  const marks = leanMarks(entries as never, { runs: new Set(), pinned: new Set() } as never);
  assert.equal(marks.length, old.length);
  assert.ok(marks.every((mark) => /omitted: 1/.test(mark.text ?? '')));
  assert.doesNotMatch(JSON.stringify(marks), /historical (input|output) sample/);
});

type Fixture = { services: Record<string, unknown> & { ledger: ContextLedgerService }; opened: () => number; restored: () => string[] | undefined };

async function originalsFixture(fn: (f: Fixture) => unknown): Promise<void> {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('CREATE TABLE run_items (id TEXT, run_id TEXT, kind TEXT, name TEXT, seq INTEGER, data TEXT)');
    const journal = sqlite.prepare('INSERT INTO run_items VALUES (?, ?, ?, ?, ?, ?)');
    const rows: Array<Record<string, unknown>> = [];
    const insert = (id: string, resultName: string | null, callName: string | null, { origin = 'codex' as string | null, pruned = false, missing = false, blob = false, state = 'keep' } = {}) => {
      const safe = callName === 'shell.exec';
      const prefix = safe ? 'managed' : 'archived';
      const run = `r${id}`;
      const callId = `call${id}`;
      if (!missing) {
        journal.run(callId, run, 'tool_call', callName, 1, JSON.stringify({ callId, args: { sample: `${prefix} argument` }, own: !safe }));
        journal.run(`result${id}`, run, 'tool_result', resultName, 2, JSON.stringify({ callId, output: `${prefix} body`, ...(blob ? { outputBlob: 'a'.repeat(64) } : {}) }));
      }
      rows.push({
        agent_id: 'agent', conversation_id: 'thread', item_id: id, run_id: run, kind: 'tool', order: rows.length + 1,
        created_at: 1, tokens: 500, title: `${prefix} title`, state, condensed: `${prefix} summary`, pinned_until: null, origin_engine: origin,
        origin_model: null, ref: `item:result${id}`, applied: 'keep', marked_by: null, mark_reason: null, marked_at: null, bytes: 50, pruned_at: pruned ? 2 : null, nested: 0,
      });
    };
    insert('t1', 'shell', 'shell', { blob: true });
    insert('t2', null, 'PowerShell', { origin: 'claude', state: 'condensed' });
    insert('t3', 'wait', 'wait', { origin: null, pruned: true });
    insert('t4', null, null, { missing: true, state: 'condensed' });
    insert('t5', 'shell.exec', 'shell.exec');
    const db = {
      get(sql: string, params: unknown[]) {
        if (sql.includes('FROM context_items')) {
          if (sql.includes('item_id = ?')) return rows.find((row) => row.item_id === params[2]);
          return { n: 0, turns: 0 };
        }
        return sqlite.prepare(sql).get(...(params as never[]));
      },
      all(sql: string, params: unknown[]) {
        if (sql.includes('FROM context_items')) return rows;
        return sqlite.prepare(sql).all(...(params as never[]));
      },
    };
    let opened = 0;
    let restored: string[] | undefined;
    const services = { db, files: { path() { opened++; throw Error('fixture output blob unavailable'); } }, chats: {}, log: { warn() {}, debug() {} } } as unknown as Record<string, unknown> & { ledger: ContextLedgerService };
    services.ledger = new ContextLedgerService({ services: () => services as never });
    services.ledger.mark = ((_agent: string, _thread: string, marks: Array<{ itemId: string }>) => { restored = marks.map((mark) => mark.itemId); }) as never;
    await fn({ services, opened: () => opened, restored: () => restored });
  } finally { sqlite.close(); }
}

test('journal originals withhold native shell and aggregate text before touching blobs or arguments', () => originalsFixture(({ services: { ledger }, opened }) => {
  for (const id of ['t1', 't2', 't3', 't4']) {
    const original = ledger.original('agent', 'thread', id)!;
    assert.match(original.text, /omitted/);
    assert.doesNotMatch(original.text, /archived/);
    assert.deepEqual([original.pruned, original.withheld, original.args], [true, id === 't4' ? 'unverified' : 'blocked', undefined]);
  }
  assert.equal(opened(), 0, 'a withheld output blob is never opened');
  assert.match(ledger.original('agent', 'thread', 't5')!.text, /managed body/);
  assert.match(ledger.original('agent', 'thread', 't5')!.args ?? '', /managed argument/);
}));

test('context.restore and the ledger item list no longer reproduce old titles or condensed text', () => originalsFixture(({ services, opened, restored }) => {
  const items = services.ledger.items('agent', 'thread');
  assert.doesNotMatch(JSON.stringify(items), /archived/);
  assert.match(JSON.stringify(items), /managed title/);
  const text = restoreItems(services as never, 'agent', 'thread', { ids: ['t1', 't2', 't3', 't4', 't5'] });
  assert.doesNotMatch(text, /archived|original is gone/);
  assert.match(text, /managed body/);
  assert.deepEqual(restored(), ['t5']);
  assert.equal(opened(), 0);
}));

test('the ledger view and trace never emit legacy args, condensed excerpts or bodies', () => originalsFixture(({ services: { ledger }, opened }) => {
  for (const view of [ledger.view('agent', 'thread'), ledger.traceView('agent', 'thread', 20)]) {
    const output = JSON.stringify(view);
    assert.doesNotMatch(output, /archived/);
    assert.match(output, /managed body/);
  }
  assert.equal(opened(), 0);
}));

test('the subconscious context.read gives only a notice for an old native result', async () => {
  const read = contextTools.find((tool) => tool.name === 'context.read')!;
  await originalsFixture(async ({ services }) => {
    services.runs = { list: () => [] };
    const run = { agent: { id: 'agent' }, thread: 'thread', services } as never;
    const old = String(await read.run({ id: 't2' } as never, run));
    assert.match(old, /omitted/);
    assert.doesNotMatch(old, /archived|original is gone/);
    assert.match(String(await read.run({ id: 't5' } as never, run)), /managed body/);
  });
});
