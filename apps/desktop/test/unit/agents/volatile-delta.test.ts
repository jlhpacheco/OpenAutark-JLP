// B-049 F6 – volatile deltas: a resumed native session gets only the volatile sections that changed since its last
// finished turn (agents/volatile-delta.ts), with one line naming the sections no longer current; a new, renewed or
// rebuilt session gets them all. Unit cases on volatileDelta and its kv state, then the real
// turn path (TurnExecutor, the real context service, a recording Codex-like engine with sessions): new session full,
// resumed + unchanged, resumed + changed, a failed turn records nothing, a renewed session full again. S2: the stable
// delta (stableDelta, changedLines): the changed stable sections as was / now lines under their own name.
// Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import { journalAnswer } from '../../../src/runtime/agents/publishing.ts';
import { CHANGED_MAX, carries, changedLines, forgetSent, recordSent, sectionTitle, sentTo, STABLE_CHANGED, stableDelta, volatileDelta, type VolatileSection } from '../../../src/runtime/agents/volatile-delta.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';

const s = (name: string, text: string): VolatileSection => ({ name, text });
const NOW_1 = s('now', '## Now\nThu 29 Oct 2026, 10:00');
const NOW_2 = s('now', '## Now\nThu 29 Oct 2026, 10:05');
const PERMS = s('permissions', '## Permissions\nStandard: internal work is free.');
const CHAT = s('chat', '## This chat\nDesk (c_1) · 1:1 chat with Alex');
const TASK = s('task', '## Current task\nTitle: Cut the video');
const PINNED = s('pinned', '## Pinned memory (notes that always apply; I check them against the current state)\n- Brand: blue');

test('volatileDelta: a new session gets every section', () => {
  const all = volatileDelta([NOW_1, PERMS, CHAT], undefined);
  assert.equal(all.text, [NOW_1, PERMS, CHAT].map((part) => part.text).join('\n\n'));
  assert.deepEqual(Object.keys(all.sections), ['now', 'permissions', 'chat']);
  assert.equal(sectionTitle(PINNED), 'Pinned memory');
  assert.equal(sectionTitle(s('x', 'no header')), 'no header');
});

test('volatileDelta: resumed – only changed sections in full, one line for the ones no longer current', () => {
  const first = volatileDelta([NOW_1, PERMS, CHAT, TASK], undefined);
  const unchanged = volatileDelta([NOW_2, PERMS, CHAT, TASK], first.sections);
  assert.equal(unchanged.text, NOW_2.text, 'nothing is said about what did not change');
  const changedPerms = s('permissions', '## Permissions\nFull autonomy: this PC belongs to the AI team.');
  const changed = volatileDelta([NOW_2, changedPerms, CHAT, PINNED], unchanged.sections);
  assert.equal(changed.text, [changedPerms.text, PINNED.text, 'No longer current: Current task.'].join('\n\n'));
  assert.ok(!changed.text.includes('Standard: internal'), 'the old permissions are not repeated');
  assert.deepEqual(Object.keys(changed.sections), ['now', 'permissions', 'chat', 'pinned']);
  const again = volatileDelta([NOW_2, changedPerms, CHAT, PINNED], changed.sections);
  assert.equal(again.text, '', 'nothing changed: nothing to send');
});

test('volatileDelta: a section whose builder threw keeps its last record – not "no longer current", not shown', () => {
  const first = volatileDelta([NOW_1, PERMS, PINNED], undefined);
  const broken = volatileDelta([NOW_2, PERMS, { name: 'pinned', text: '', failed: true }], first.sections);
  assert.equal(broken.text, NOW_2.text);
  assert.deepEqual(broken.sections.pinned, first.sections.pinned, 'the session still holds the pinned memory it got');
  const back = volatileDelta([NOW_2, PERMS, PINNED], broken.sections);
  assert.equal(back.text, '', 'back as it was: nothing to send');
  const fresh = volatileDelta([NOW_1, { name: 'pinned', text: '', failed: true }], undefined);
  assert.equal(fresh.text, NOW_1.text, 'a new session gets no empty failed section');
  assert.deepEqual(Object.keys(fresh.sections), ['now']);
});

test('S2 stableDelta: only the changed stable sections, as their changed lines under their own name; a new and a gone section count against nothing', () => {
  const md = (text: string) => ({ name: 'system-md', text: `# My SYSTEM.md\nMy whole standing text.\n# How I work\n- I own outcomes.\n${text}\n## My role\nDesk.` });
  const env = { name: 'environment', text: '## My environment\nThis PC: Tower.' };
  const held = Object.fromEntries([md('- I write tight.'), env].map((section) => [section.name, section.text]));
  assert.deepEqual(stableDelta([md('- I write tight.'), env], held), { text: '', stable: held }, 'nothing changed: nothing to send');
  const changed = stableDelta([md('- I write tight and warm.\n- A new line.'), env, { name: 'human', text: '## From Alex\nNo calls before ten.' }], held);
  assert.equal(changed.text, [
    STABLE_CHANGED,
    '## My SYSTEM.md\nwas: - I write tight.\nnow: - I write tight and warm.\nnow: - A new line.',
    '## From Alex\nnow: ## From Alex\nnow: No calls before ten.',
  ].join('\n\n'));
  assert.ok(!changed.text.includes('This PC: Tower'), 'an unchanged section is not repeated');
  const gone = stableDelta([md('- I write tight and warm.\n- A new line.'), env], changed.stable);
  assert.equal(gone.text, [STABLE_CHANGED, '## From Alex\nwas: ## From Alex\nwas: No calls before ten.'].join('\n\n'));
  assert.deepEqual(Object.keys(gone.stable), ['system-md', 'environment']);
  assert.deepEqual(changedLines('a\nb\nc\nd', 'a\nB\nc\nd\ne'), ['was: b', 'now: B', 'now: e'], 'each replaced run: was before now, in order');
});

test('S2 fix: a line that only lost or gained trailing whitespace reads the same, so it is no change', () => {
  assert.deepEqual(changedLines('## X\n- one line', '## X\n- one line  '), [], 'trailing blanks are no change');
  assert.deepEqual(changedLines('## X\n- one line', '## X\n -one line'), ['was: - one line', 'now:  -one line'], 'a change inside the line is one');
  const section = { name: 'environment', text: '## My environment\nThis PC: Tower.' };
  assert.equal(stableDelta([{ ...section, text: `${section.text}   ` }], { environment: section.text }).text, '', 'and reaches no session');
});

test('S2 fix: a change longer than the bound comes as the part itself, or names the file the part is', () => {
  const long = (line: string) => `# My SYSTEM.md\nMy whole standing text.\n${Array.from({ length: 400 }, (_, index) => `- line ${index} ${line}`).join('\n')}`;
  const before = { name: 'system-md', text: long('as it was') };
  const after = { name: 'system-md', text: long('as it reads now') };
  assert.ok(changedLines(before.text, after.text).join('\n').length > CHANGED_MAX);
  const file = stableDelta([after], { 'system-md': before.text });
  assert.equal(file.text, `${STABLE_CHANGED}\n\n## My SYSTEM.md\nMore of this part changed than reads as lines; it is my SYSTEM.md, and the whole of it as it reads now stands there.`);
  assert.equal(file.stable['system-md'], after.text, 'the session holds the new text either way');
  // A part that is no file of mine comes whole as it reads now.
  const human = (line: string) => `## From Alex\n${Array.from({ length: 400 }, (_, index) => `- ${index} ${line}`).join('\n')}`;
  const whole = stableDelta([{ name: 'human', text: human('now') }], { human: human('before') });
  assert.equal(whole.text, `${STABLE_CHANGED}\n\n## From Alex\nMore of this part changed than reads as lines, so it stands here as it reads now:\n${human('now')}`);
  // A part that is gone says so instead of its lines.
  const left = stableDelta([], { human: human('before') });
  assert.equal(left.text, `${STABLE_CHANGED}\n\n## From Alex\nThis part is not in my standing text any more.`);
});

test('sentTo / recordSent: per agent, chat and engine, bound to the session ref', () => {
  const f = fixture();
  const key = { agentId: 'ag_1', conversationId: 'c_1', engine: 'codex' as const };
  assert.equal(sentTo(f.db, key, 'thr_1'), undefined);
  recordSent(f.db, key, 'thr_1', { sections: { now: { hash: 'a', title: 'Now' } } }, 1);
  assert.deepEqual(sentTo(f.db, key, 'thr_1'), { sections: { now: { hash: 'a', title: 'Now' } } });
  assert.equal(sentTo(f.db, key, 'thr_2'), undefined, 'another session ref holds nothing of it');
  assert.equal(sentTo(f.db, { ...key, engine: 'claude' }, 'thr_1'), undefined);
  assert.equal(sentTo(f.db, { ...key, conversationId: 'c_2' }, 'thr_1'), undefined);
});

const COMPUTER_MODE: ModeInfo = {
  key: 'computer', name: 'Computer', description: 'Work on the screen of a PC.', skills: [], tools: ['*'], category: 'computer-use',
  workspace: 'computer', instructions: '# Computer mode\n\nLook at the screen before every click.',
};

function setup() {
  const f = fixture();
  const vic = f.vid;
  const chat = f.chats.create({ title: 'Desk', agentIds: [vic.id], createdBy: 'human' });
  const calls: EngineTurnInput[] = [];
  const state: { fail?: boolean; compact?: boolean; sessions: number } = { sessions: 0 };
  const caps: EngineCaps = { sessions: true, dynamicTools: true, mcp: false, images: false, rebase: true, structured: false, ownTools: true };
  const engine = {
    id: 'codex', caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = input.session ?? { ref: `codex-s${++state.sessions}`, generation: 1 };
      if (state.fail) return { text: '', stop: 'error', session, error: { code: 'internal', message: 'model error' } };
      return { text: `answer ${calls.length}`, stop: 'done', session, ...(state.compact ? { compacted: true } : {}) };
    },
  } as unknown as Engine;
  const models = new Map<string, ModelInfo>([['codex:sol', model('codex:sol', 'frontier', 'GPT Sol')]]);
  const route: RouteDecision = { modelId: 'codex:sol', engine: 'codex', accountId: 'acc_codex', effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  const acc = account('acc_codex', 'codex');
  const modes = new Map([[GENERAL_MODE.key, GENERAL_MODE], [COMPUTER_MODE.key, COMPUTER_MODE]]);
  Object.assign(f.services, {
    modes: { get: (key: string) => { const mode = modes.get(key); if (!mode) throw new Error(`unknown mode ${key}`); return mode; }, list: () => [...modes.values()] },
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()] },
    subconscious: {},
    tools: { get: () => undefined, specsFor: () => [], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
  });
  let runs = 0;
  return {
    ...f, vic, chat, calls, state,
    send: (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' }),
    turn: () => new TurnExecutor(() => f.services).execute({
      runId: `run_${++runs}`, agentId: vic.id, conversationId: chat.id, reason: 'message', notes: [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    }),
  };
}

const volatileOf = (input: EngineTurnInput) => input.system.volatile;

test('turn path: new session full; resumed only what changed; a failed turn records nothing; a renewed session full again', async () => {
  const h = setup();
  h.send('Hello');
  assert.equal((await h.turn()).status, 'done');
  const first = volatileOf(h.calls[0]);
  assert.equal(h.calls[0].session, undefined);
  for (const header of ['## Now', '## My chats']) assert.ok(first.includes(header), `new session: ${header}`);

  h.clock.advance(5 * 60_000);
  h.send('Next');
  await h.turn();
  const resumed = volatileOf(h.calls[1]);
  assert.equal(h.calls[1].session?.ref, 'codex-s1');
  assert.ok(resumed.includes('## Now'), 'the time changed');
  assert.ok(!resumed.includes('## My chats'), 'stable chat lines: a new line in the waking chat is no news mark');
  assert.ok(resumed.length < first.length);

  h.tasks.create({ conversationId: h.chat.id, title: 'Cut the launch video', assigneeKind: 'agent', assigneeId: h.vic.id, createdBy: 'human' });
  h.state.fail = true;
  h.send('And?');
  await h.turn();
  const failed = volatileOf(h.calls[2]);
  assert.match(failed, /## My quests\nOther:\n- [^\n]*Cut the launch video/, 'a changed section goes in full');
  h.state.fail = false;
  h.send('Again');
  await h.turn();
  assert.match(volatileOf(h.calls[3]), /## My quests/, 'the failed turn recorded nothing: sent again');
  h.send('Once more');
  await h.turn();
  assert.ok(!volatileOf(h.calls[4]).includes('## My quests'), 'held after a finished turn');

  new SessionStore(h.db).remove(h.vic.id, 'main', 'codex'); // S2: the session starts anew (a mode switch alone keeps it)
  h.send('Take a screenshot');
  await h.turn();
  const renewed = h.calls[5];
  assert.equal(renewed.session, undefined, 'a renewed (new) session');
  for (const header of ['## Now', '## My chats', '## My quests']) assert.ok(volatileOf(renewed).includes(header), `renewed: ${header}`);
});

test('turn path: after the engine compacted the session (result.compacted) the next turn gets every section again', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn();
  h.send('Next');
  await h.turn();
  assert.ok(!volatileOf(h.calls[1]).includes('## My chats'), 'resumed: a delta');

  h.state.compact = true; // a long turn: the engine compacted its history, the earlier context blocks may be gone
  h.send('A long job');
  assert.equal((await h.turn()).status, 'done');
  assert.equal(sentTo(h.db, { agentId: h.vic.id, conversationId: 'main', engine: 'codex' }, 'codex-s1'), undefined, 'nothing recorded after a compaction');
  h.state.compact = false;
  h.send('And now?');
  await h.turn();
  const after = h.calls[3];
  assert.equal(after.session?.ref, 'codex-s1', 'the same session resumes');
  for (const header of ['## Now', '## My chats']) assert.ok(volatileOf(after).includes(header), `after compaction: ${header}`);
  h.send('Then');
  await h.turn();
  assert.ok(!volatileOf(h.calls[4]).includes('## My chats'), 'recorded again after a finished turn: deltas resume');
});

test('forgetSent: drops the record of that key only', () => {
  const f = fixture();
  const key = { agentId: 'ag_1', conversationId: 'c_1', engine: 'codex' as const };
  const other = { ...key, conversationId: 'c_2' };
  recordSent(f.db, key, 'thr_1', { sections: { now: { hash: 'a', title: 'Now' } } }, 1);
  recordSent(f.db, other, 'thr_2', { sections: { now: { hash: 'b', title: 'Now' } } }, 1);
  forgetSent(f.db, key);
  assert.equal(sentTo(f.db, key, 'thr_1'), undefined);
  assert.deepEqual(sentTo(f.db, other, 'thr_2'), { sections: { now: { hash: 'b', title: 'Now' } } });
});

test('turn path: a new session gets my latest answers from the run log right after the <live> block, not inside it', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn();
  journalAnswer(h.services, 'run_1', 'Die Liste ist geprüft, drei Punkte offen.', 'internal');
  new SessionStore(h.db).remove(h.vic.id, 'main', 'codex'); // a new session
  h.send('And?');
  await h.turn();
  const renewed = h.calls[1];
  assert.equal(renewed.session, undefined);
  assert.ok(!volatileOf(renewed).includes('Die Liste ist geprüft'), 'not in the live part');
  const text = renewed.input.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
  assert.match(text, /^My latest answers[^\n]*\n- [^\n]*Die Liste ist geprüft, drei Punkte offen\./, text);
});

test('carries: a section goes out on a new session, on a resumed one only when it changed – a reminder\'s quest then comes once (FIXREAL second round 3)', () => {
  const first = volatileDelta([NOW_1, TASK], undefined);
  assert.equal(carries([NOW_1, TASK], first, 'task'), true, 'a new session gets it');
  assert.equal(carries([NOW_2, TASK], volatileDelta([NOW_2, TASK], first.sections), 'task'), false, 'unchanged on a resumed session: left out');
  const moved = s('task', '## Current task\nTitle: Cut the video\nNow: one to-do open');
  assert.equal(carries([NOW_2, moved], volatileDelta([NOW_2, moved], first.sections), 'task'), true, 'changed: sent again');
  assert.equal(carries([NOW_1, s('task', '')], volatileDelta([NOW_1, s('task', '')], undefined), 'task'), false, 'no task this turn');
  assert.equal(carries(undefined, undefined, 'task'), false);
});
