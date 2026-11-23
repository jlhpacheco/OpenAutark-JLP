// Unterbewusstsein v2 (15.11.2026), Runde „Halb“ (21.11.2026): what the subconscious reads and does before a turn besides the route
// (subconscious/look.ts through route-turn.ts routeTurn) and at a forked part's first start (condensePart). The word search's hits for
// what wakes the turn stand in its prompt and its answer's `hints` lists them; each picked one reaches the turn as the call's own line
// in the live block's "## From my memory" (hints.ts) – redacted, as many as the call picks up to HINTS (no rule of three), never one
// it was not offered, not again in the same version, and never as an opened entry. No call condenses before a turn any more. At a
// part's start the biggest items still whole in its context stand in the call's prompt – tool,
// file and skill items of at least ITEM_TOKENS, not of the newest finished run, never a message; the call says for every one whether
// its job is done (17.11.2026: one yes or no per item), a done one keeps its note and leanText's values (a note naming a value that
// stands neither in the original nor in what the call was shown is dropped), marked by the subconscious; the call has no way to hide
// (measured 15.11.: hiding lost the values). An effort decided already leaves out the effort, not the rest. What another effort costs is said only where it costs something (17.11.2026: one hour, at the price table's write price). And (final6, 14.11.) the ledger keeps an
// entry the call opened whole like a loaded skill, while one the main AI opened itself goes lean.
// Owns: these assertions only. Never: real models, engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { fixture } from '../context/fixture.ts';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { cacheLife, condensePart, effortCost, effortKeepsCache, PART_SYSTEM, routeTurn } from '../../../src/runtime/subconscious/route-turn.ts';
import { ITEM_TOKENS, LOOK_REASON } from '../../../src/runtime/subconscious/look.ts';
import { HINT_CHARS, HINTS, hintsSection, keepHints, startHints, turnHints } from '../../../src/runtime/subconscious/hints.ts';
import { volatileSections } from '../../../src/runtime/context/prompt-volatile.ts';
import { LOOK_MS, ROUTE_WAIT_MS, SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { leanMarks } from '../../../src/runtime/context/ledger/window.ts';
import { journalResult } from '../../../src/runtime/tools/journal.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';

type Call = Parameters<StructuredRunner>[0];
type Schema = { properties: Record<string, { items?: { enum?: string[]; properties?: { id?: { enum?: string[] } } } }> };
const enumOf = (call: Call, field: string): string[] => {
  const items = (call.schema as Schema).properties[field]?.items;
  return items?.enum ?? items?.properties?.id?.enum ?? [];
};

/** A decision model whose answer is made from the call it gets (the ids it was offered). */
function answering(answer: (call: Call) => Record<string, unknown>) {
  const calls: Call[] = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const structured = answer(call);
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  return { runner, calls };
}

test('Runde „Halb“: a hit the call picks reaches the turn as its own line with how to open it – redacted, never one it was not offered, once per version; nothing is opened', async () => {
  const f = fixture(); // its secrets service knows the value "hunter2"
  const ida = f.org.add(agent('ag_ida', 'Ida', { role: 'Assistant' }));
  f.knowledge.memoryWrite({ folder: 'company/partner', title: 'Larsen Marine Portal', text: 'Larsen Marine Portal: login lars.aune, password hunter2' });
  const said = 'Log in to the Larsen Marine Portal and download the invoices.';
  const brain = answering((call) => ({ hints: [...enumOf(call, 'hints').filter((id) => id.includes('larsen')), 'note:company:partner:made-up.md'].map((id) => ({ id, line: 'The portal login is lars.aune with password hunter2 – I sign in with it.' })) }));
  const look = await routeTurn(f.services, brain.runner, { agent: ida, said, held: true, deadlineMs: ROUTE_WAIT_MS });
  const [call] = brain.calls;
  assert.match(call.prompt, /What the word search found in the agent's knowledge for this/);
  assert.match(call.prompt, / – begins: Larsen Marine Portal: login lars\.aune, password secret:\/\/sec_pw/, 'how it begins, redacted, without opening it');
  assert.deepEqual(Object.keys((call.schema as Schema).properties), ['hints'], 'the effort is decided already: the call leaves it out – and it never names a model');
  assert.equal(look?.hints.length, 1, 'an id it was not offered gives nothing');
  const [hint] = look!.hints;
  assert.match(hint.id, /larsen/);
  assert.equal(hint.open, `knowledge.open "${hint.id}"`);
  assert.doesNotMatch(hint.line, /hunter2/, 'a value in its line is redacted');
  assert.ok(!('calls' in look!), 'no opened entry, no tool pair');
  const again = answering(() => ({}));
  await routeTurn(f.services, again.runner, { agent: ida, said, held: true, deadlineMs: ROUTE_WAIT_MS });
  assert.ok(!again.calls.some((item) => item.prompt.includes(hint.id)), 'hinted once in this version');
});

test('hits: no rule of three – every hit the call picks gets its line, none it leaves, a line without words none, at most HINTS, each cut to HINT_CHARS', async () => {
  const f = fixture();
  const ida = f.org.add(agent('ag_ida', 'Ida', { role: 'Assistant' }));
  for (const name of ['Nordlicht', 'Fjordblick', 'Seeufer', 'Bergwerk', 'Talgrund']) f.knowledge.memoryWrite({ folder: 'company/partner', title: `Lieferant ${name}`, text: `Lieferant ${name}: Rechnungen nur als PDF, Zahlungsziel 30 Tage.` });
  const brain = answering((call) => ({ hints: enumOf(call, 'hints').filter((id) => !id.includes('talgrund')).map((id, index) => ({ id, line: index === 0 ? '  ' : `Nur PDF-Rechnungen. ${'x'.repeat(300)}` })) }));
  const look = await routeTurn(f.services, brain.runner, { agent: ida, said: 'Welche Lieferanten wollen Rechnungen nur als PDF?', held: true, deadlineMs: ROUTE_WAIT_MS });
  assert.equal(enumOf(brain.calls[0], 'hints').filter((id) => id.includes('lieferant')).length, 5);
  assert.equal(look?.hints.length, 3, 'four picked, one of them without a line');
  assert.ok(!look!.hints.some((item) => item.id.includes('talgrund')));
  assert.ok(look!.hints.every((item) => item.line.length <= HINT_CHARS));
  const many = answering((call) => ({ hints: enumOf(call, 'hints').map((id) => ({ id, line: 'fits' })) }));
  for (const name of ['Ahorn', 'Birke', 'Eiche', 'Linde', 'Ulme']) f.knowledge.memoryWrite({ folder: 'company/partner', title: `Lieferant ${name} PDF`, text: `Lieferant ${name}: Rechnungen als PDF.` });
  const capped = await routeTurn(f.services, many.runner, { agent: ida, said: 'Welche Lieferanten schicken PDF-Rechnungen?', held: true, deadlineMs: ROUTE_WAIT_MS });
  assert.ok(capped!.hints.length <= HINTS);
});

test('hints: the live section shows one line per hint with how it opens; a call beside a started turn keeps its picks for the next one; a turn without any shows none', () => {
  const f = fixture();
  const hints = [{ id: 'note:company:a.md', line: 'Ida signs PDFs in Acrobat.', open: 'knowledge.open "note:company:a.md"' }, { id: 'secret:sec_1', line: 'The portal login.', open: 'username secret://sec_1/username' }];
  assert.equal(hintsSection(hints), '## From my memory\n- Ida signs PDFs in Acrobat. (knowledge.open "note:company:a.md")\n- The portal login. (username secret://sec_1/username)');
  assert.equal(hintsSection([]), '');
  startHints(f.services, 'ag_ida', 'main', [hints[0]]);
  assert.deepEqual(turnHints(f.services, 'ag_ida', 'main'), [hints[0]]);
  keepHints(f.services, 'ag_ida', 'main', [hints[1]]);
  assert.deepEqual(turnHints(f.services, 'ag_ida', 'main'), [hints[0]], 'kept for the next turn, not this one');
  startHints(f.services, 'ag_ida', 'main', []);
  assert.deepEqual(turnHints(f.services, 'ag_ida', 'main'), [hints[1]], 'the next turn takes them');
  startHints(f.services, 'ag_ida', 'main', []);
  assert.deepEqual(turnHints(f.services, 'ag_ida', 'main'), [], 'once');
  startHints(f.services, 'ag_ida', 'main', [hints[0]]);
  new SubconsciousImpl({ services: () => f.services, runner: false }).forget((text) => text.includes('Acrobat'));
  assert.deepEqual(turnHints(f.services, 'ag_ida', 'main'), [], "the person's Forget reaches a kept hint");
});

test('context: the biggest whole items are listed – not small ones, messages or the newest finished run – and the call says for each whether its job is done: a done one is condensed with its note and leanText, one it wants kept stays', async () => {
  const t = ledgerSetup();
  try {
    const big = (path: string, extra: string) => `Read ${path} for task_1m7fjar5fn992dvb3.\n${extra}\n${'Rows of the old offer table, now copied into the offer. '.repeat(120)}`;
    const old = t.turn();
    const offer = t.ourCall(old, 'files.read', { path: 'angebote/AN-2026-041.md' }, big('angebote/AN-2026-041.md', 'Total 18,400 EUR.'), 'c_offer');
    const status = t.ourCall(old, 'web.fetch', { url: 'https://status.example.com' }, `Status page: degraded.\n${'Old status lines. '.repeat(300)}`, 'c_status');
    t.ourCall(old, 'tasks.get', { id: 'task_1' }, 'small output', 'c_small');
    t.done(old);
    t.say('Bitte schick das Angebot an Larsen.');
    const newest = t.turn();
    t.ourCall(newest, 'files.read', { path: 'angebote/AN-2026-042.md' }, big('angebote/AN-2026-042.md', 'Total 9,900 EUR.'), 'c_newest');
    t.done(newest);
    await t.journal.settled();
    const rows = t.ledger.items(t.tom.id, 'main');
    const idOf = (callId: string) => t.ledger.view(t.tom.id, 'main').find((item) => item.call?.callId === callId)!.itemId;
    const [offerId, statusId, newestId] = [idOf(offer), idOf(status), idOf('c_newest')];
    assert.ok(rows.find((row) => row.itemId === offerId)!.tokens >= ITEM_TOKENS);
    // On the code before 17.11.2026 the answer was one list of items to condense; a model that listed an item to say "keep" had it condensed (35 measured).
    const brain = answering(() => ({
      items: [
        { id: offerId, done: true, note: 'Offer AN-2026-041 read and copied into the offer; total 18,400 EUR.' },
        { id: statusId, done: false, note: 'The status page stays relevant for the coming report; keep it whole.' },
        { id: newestId, done: true, note: 'the newest run' },
      ],
    }));
    const tidy = await condensePart(t.services, brain.runner, { agent: t.tom, said: 'Ist das Angebot raus?', thread: 'main', deadlineMs: LOOK_MS });
    const [call] = brain.calls;
    assert.equal(call.system, PART_SYSTEM, 'its own system prompt – the route call no longer explains condensing');
    assert.deepEqual(enumOf(call, 'items').sort(), [offerId, statusId].sort(), 'only big tool work outside the newest finished run');
    assert.deepEqual((call.schema as unknown as { properties: { items: { items: { required: string[] } } } }).properties.items.items.required, ['id', 'done', 'note'], 'one yes or no per item');
    assert.match(call.prompt, /The biggest items still whole in the main AI's context/);
    assert.deepEqual([tidy.condensed, tidy.by], [1, 'fake'], 'an id it was not shown is not marked, an item it calls not done neither; the answering model rides along');
    assert.ok(!('hide' in (call.schema as Schema).properties), 'no way to hide');
    const after = new Map(t.ledger.items(t.tom.id, 'main').map((row) => [row.itemId, row]));
    const condensed = after.get(offerId)!;
    assert.deepEqual([condensed.state, condensed.markedBy, condensed.markReason], ['condensed', 'subconscious', LOOK_REASON]);
    assert.match(condensed.condensed!, /^Offer AN-2026-041 read and copied into the offer; total 18,400 EUR\.\n/);
    assert.match(condensed.condensed!, /task_1m7fjar5fn992dvb3/, 'leanText keeps the values under the note');
    assert.equal(after.get(statusId)!.state, 'keep', 'not done: it stays whole, whatever the note says');
    assert.equal(after.get(newestId)!.state, 'keep');
  } finally { t.cleanup(); }
});

test('Runde „Halb“: before a turn one call runs – none condenses the context; the ledger stays as code leaves it', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn();
    const callId = t.ourCall(run, 'files.read', { path: 'notes.md' }, `Notes for task_1m7fjar5fn992dvb3.\n${'Old meeting notes. '.repeat(250)}`, 'c1');
    t.done(run);
    t.done(t.turn());
    await t.journal.settled();
    const id = t.ledger.view(t.tom.id, 'main').find((item) => item.call?.callId === callId)!.itemId;
    const seen: Call[] = [];
    const runner: StructuredRunner = async (call) => {
      seen.push(call);
      const effort = { hardest: 'a status', fixed: true, shows: true, together: false, effort: 'low', why: 'a status' };
      return { text: JSON.stringify(effort), structured: effort, by: 'fake' };
    };
    const impl = new SubconsciousImpl({ services: () => t.services, runner });
    // On the code before 21.11.2026 a second call beside every turn read the biggest items and condensed the done ones (417 calls in 42 h).
    assert.equal(await impl.beforeTurn({ agent: t.tom, thread: 'main', said: 'Wie weit ist der Bericht für Larsen Marine?' }), undefined);
    await impl.settle();
    assert.equal(seen.length, 1, 'only the route call');
    assert.ok(!('items' in (seen[0].schema as Schema).properties));
    assert.doesNotMatch(seen[0].system, /biggest items still whole/);
    assert.equal(t.ledger.items(t.tom.id, 'main').find((item) => item.itemId === id)!.state, 'keep');
  } finally { t.cleanup(); }
});

test('context: a note naming a value that stands neither in the original nor in what the call was shown is dropped – leanText alone stands in its place; a value from the chat it read stays', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn();
    const callId = t.ourCall(run, 'files.read', { path: 'report.md' }, `Report for task_1m7fjar5fn992dvb3.\n${'Figures of the quarter. '.repeat(200)}`, 'c1');
    t.done(run);
    t.done(t.turn()); // a newer finished run: the report's run is no longer the newest
    await t.journal.settled();
    const id = t.ledger.view(t.tom.id, 'main').find((item) => item.call?.callId === callId)!.itemId;
    const brain = answering(() => ({ items: [{ id, done: true, note: 'Report done, invoice INV-77123 sent.' }] }));
    await condensePart(t.services, brain.runner, { agent: t.tom, said: 'Und weiter?', thread: 'main', deadlineMs: LOOK_MS });
    const row = t.ledger.items(t.tom.id, 'main').find((item) => item.itemId === id)!;
    assert.equal(row.state, 'condensed');
    assert.doesNotMatch(row.condensed!, /INV-77123/);
    assert.match(row.condensed!, /^Output set aside when that piece of work was finished\./);

    // On the code before 17.11.2026 the note was checked against the item alone: a value the call took from the chat it was shown cost the note (418 of 2,472 measured).
    const second = t.turn();
    const otherCall = t.ourCall(second, 'files.read', { path: 'ledger.md' }, `Ledger for task_1m7fjar5fn992dvb3.\n${'Rows of the ledger. '.repeat(200)}`, 'c2');
    t.done(second);
    t.done(t.turn());
    await t.journal.settled();
    const otherId = t.ledger.view(t.tom.id, 'main').find((item) => item.call?.callId === otherCall)!.itemId;
    const shown = answering(() => ({ items: [{ id: otherId, done: true, note: 'Ledger read; the open point is invoice INV-77123.' }] }));
    await condensePart(t.services, shown.runner, { agent: t.tom, said: 'Ist die Rechnung INV-77123 jetzt raus?', thread: 'main', deadlineMs: LOOK_MS });
    const kept = t.ledger.items(t.tom.id, 'main').find((item) => item.itemId === otherId)!;
    assert.equal(kept.state, 'condensed');
    assert.match(kept.condensed!, /^Ledger read; the open point is invoice INV-77123\.\n/, 'the value stood in what the call was shown');
  } finally { t.cleanup(); }
});

test("service: the call's lines stand in the turn's live block as \"## From my memory\" – not in its trace, which holds only what was kept; a held turn gets them too", async () => {
  const f = fixture();
  const ida = f.org.add(agent('ag_ida', 'Ida', { role: 'Assistant' }));
  f.knowledge.memoryWrite({ folder: 'company/partner', title: 'Studio Bellavista', text: 'Studio Bellavista: no calls before 10:00, video preferred.' });
  const brain = answering((call) => ({ hints: enumOf(call, 'hints').map((id) => ({ id, line: 'No calls to Studio Bellavista before 10:00 – video preferred.' })) }));
  const impl = new SubconsciousImpl({ services: () => f.services, runner: brain.runner });
  impl.putBack(ida.id, 'main', { calls: [{ tool: 'knowledge.find', args: { query: 'x' }, output: 'kept' }] });
  const trace = await impl.beforeTurn({ agent: ida, thread: 'main', said: 'Ruf bitte Studio Bellavista an.' });
  assert.deepEqual(trace?.calls.map((item) => item.tool), ['knowledge.find'], 'no knowledge.open pair');
  const memory = volatileSections(f.services, { agent: ida, thread: 'main', route: { modelId: 'fake:fake-1', engine: 'fake', accountId: 'acc', effort: 'medium' } as never }).find((section) => section.name === 'memory');
  assert.match(memory?.text ?? '', /^## From my memory\n- No calls to Studio Bellavista before 10:00 – video preferred\. \(knowledge\.open "note:company:partner:studio-bellavista\.md"\)$/);
  // the turn never reached its engine: the trace it got goes back (agents/turn.ts) and carries its hints to the next turn
  impl.putBack(ida.id, 'main', trace!);
  const retry = await impl.beforeTurn({ agent: ida, thread: 'main', said: 'ok' });
  assert.deepEqual(retry?.calls.map((item) => item.tool), ['knowledge.find'], 'the kept call goes back with it, no knowledge.open');
  assert.match(turnHints(f.services, ida.id, 'main')[0]?.line ?? '', /No calls to Studio Bellavista before 10:00/, 'the wake is still open: its hints stay');
  const quiet = await impl.beforeTurn({ agent: ida, thread: 'main', said: 'ok' });
  assert.equal(quiet, undefined);
  assert.ok(!volatileSections(f.services, { agent: ida, thread: 'main', route: { modelId: 'fake:fake-1', engine: 'fake', accountId: 'acc', effort: 'medium' } as never }).some((section) => section.name === 'memory'), 'the next turn without hints shows none');
});

test('what another effort costs is said only where it costs something: while the cache of its engine lives, on an engine where the effort shapes the prompt, at the price table\'s write price', () => {
  assert.equal(effortKeepsCache('claude', 'claude:claude-opus-5-5'), true);
  assert.equal(effortKeepsCache('claude', 'claude:claude-fable-5-2'), true);
  assert.equal(effortKeepsCache('claude', 'claude:claude-opus-4-7'), false, 'Claude Code: each effort has its own cache on older models');
  assert.equal(effortKeepsCache('codex', 'codex:gpt-6.1-sol'), true);
  assert.equal(effortKeepsCache('codex', 'codex:gpt-5.5'), undefined);
  assert.equal(effortKeepsCache('anthropic', 'anthropic:claude-opus-5-5'), false, 'our own API engine sends the effort at the top of the request');
  assert.equal(effortKeepsCache(undefined, 'codex:gpt-6.1-sol'), undefined);
  const f = fixture();
  const now = f.clock.now();
  Object.assign(f.services, { runs: { list: () => [{ model: 'codex:gpt-6.1-sol', engine: 'codex', effort: 'medium', endedAt: now - 2 * 60_000 }] } });
  assert.equal(effortCost(f.services, f.vid, now), '', 'Codex keeps the cache over an effort change: nothing to weigh');
  const api = (minutes: number) => Object.assign(f.services, { runs: { list: () => [{ model: 'anthropic:claude-opus-5-5', engine: 'anthropic', effort: 'high', endedAt: now - minutes * 60_000 }] } });
  // On the code before 17.11.2026 a cache was called warm for 5 minutes and "maybe" up to an hour, and a re-read was priced "uncached at its own input price".
  // review 17.11.2026: our API engines send cache_control without a ttl – the five-minute cache, not an hour
  api(4);
  const line = effortCost(f.services, f.vid, now);
  assert.match(line, /^What another effort costs now: the main AI's last turn ran 4 min ago on anthropic:claude-opus-5-5 at effort high, and its cache lives five minutes\. On this engine another effort writes the whole context into the cache again – \$[\d.]+ per 1M tokens written against \$[\d.]+ read; the same effort reads it from there\.$/);
  const [written, read] = [...line.matchAll(/\$([\d.]+)/g)].map((match) => Number(match[1]));
  assert.ok(written > read * 10, `${written} written against ${read} read: the price table's own numbers`);
  api(6);
  assert.equal(effortCost(f.services, f.vid, now), '', 'past its five minutes the cache is gone: any effort costs the same');
  assert.deepEqual([cacheLife('claude').text, cacheLife('codex').text, cacheLife('anthropic').text, cacheLife('openai').ms], ['an hour', 'an hour', 'five minutes', 5 * 60_000]);
});

test('final6, 14.11.: an entry the call opened is kept whole in the ledger like a loaded skill; a note the main AI opened itself goes lean', async () => {
  const t = ledgerSetup();
  try {
    const rule = `Studio Bellavista: no calls before 10:00, video preferred.\n${'Background on the studio. '.repeat(40)}`;
    const run = t.turn();
    t.journal.item(run, { kind: 'tool_call', name: 'knowledge.open', data: { callId: 'c1', args: JSON.stringify({ id: 'note:company:partner:studio-bellavista.md' }), summary: 'Subconscious: knowledge.open', subconscious: true }, effectStatus: 'none', idemKey: `${run}:c1` });
    journalResult(t.services, run, 'knowledge.open', 'c1', `${run}:c1:result`, { content: [{ type: 'text', text: rule }] }, []);
    t.ourCall(run, 'knowledge.open', { id: 'note:company:partner:larsen-marine.md' }, `Larsen Marine: prices only in NOK.\n${'More text. '.repeat(120)}`, 'c2');
    t.done(run);
    await t.journal.settled();
    const items = t.ledger.view(t.tom.id, 'main');
    const traced = items.find((item) => item.call?.callId === 'c1')!;
    const own = items.find((item) => item.call?.callId === 'c2')!;
    assert.equal(traced.kind, 'skill');
    assert.match(t.ledger.items(t.tom.id, 'main').find((item) => item.itemId === traced.itemId)!.title, /^Note company:partner:studio-bellavista\.md/);
    assert.equal(own.kind, 'tool');
    const marks = leanMarks(items, { runs: new Set(['run_newer']), pinned: new Set() });
    assert.ok(!marks.some((mark) => mark.itemId === traced.itemId), 'the rule stays in the context after a rebuild');
    assert.ok(marks.some((mark) => mark.itemId === own.itemId && mark.state === 'condensed'), 'the main AI\'s own open is finished work');
  } finally { t.cleanup(); }
});
