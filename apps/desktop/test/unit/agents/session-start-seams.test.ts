// S2 (KI-Runde 17.11.2026, after the second review: r2-3 #5, r2-4 #15) – where a session's start record is written beside its
// binding: a session rebuilt in a turn whose first turn fails has its start (it is bound with that turn's key already), and a
// fresh session the engine names mid-turn ('session' event) gets its record with the binding that event saves. Over the
// native-rebuild harness. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIN_THREAD } from '../../../src/shared/model/origin.ts';
import { startOf } from '../../../src/runtime/agents/session-key.ts';
import { ContextLedgerService } from '../../../src/runtime/context/ledger/service.ts';
import { CACHE_COLD_MS } from '../../../src/runtime/agents/compaction-policy.ts';
import type { EngineRebuildInput, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import { setup, view } from './rebuild-harness.ts';

test('a session rebuilt in a turn whose first turn fails keeps the start it was built with', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn('claude');
  h.ledgerState.view = view([['a1', 'assistant', 'assistant', 'Long answer']]);
  h.codex.state.reply = () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'model error' } });
  h.send('On Codex now');
  assert.equal((await h.turn('codex')).status, 'failed');
  assert.equal(h.codex.rebuilds.length, 1, 'the switch rebuilt the session');
  const bound = h.binding('codex')!;
  assert.equal(bound.ref, 'codex-r1', 'the failed turn kept the rebuilt session');
  assert.ok(startOf(h.db, { agentId: h.agent.id, thread: MAIN_THREAD, engine: 'codex' }, bound.promptKey), 'its start is recorded');
});

test('a Codex revert keeps the key its thread started with, also when the turn fails before any save (r2-3 #6)', async () => {
  const h = setup();
  const ledger = new ContextLedgerService({ services: () => h.s });
  h.s.ledger = ledger;
  const stop = ledger.start();
  try {
    (h.codex.engine.caps as { revert?: boolean }).revert = true;
    const work = (input: EngineTurnInput): Partial<EngineTurnResult> => {
      for (const step of [1, 2, 3, 4]) { // eight steps in two runs: the oldest lie past the lean view's newest six (Runde "Halb" KEEP_STEPS)
        // 0.3.19: a Codex agent thread runs its commands in code-mode scripts with the managed-shell row mark (a native Bash row is legacy, withheld).
        input.onEvent({ type: 'tool_start', callId: `sh_${input.runId}_${step}`, name: 'exec', args: { source: 'text(await tools.shell__exec({ command: "npm test" }))' }, own: true, managed: true });
        input.onEvent({ type: 'tool_end', callId: `sh_${input.runId}_${step}`, ok: true, summary: 'exit 0', output: 'ok\n'.repeat(300) });
      }
      return { text: 'Done.', contextTokens: 20_000, session: { ref: 'codex-s1', generation: 1, turn: `t_${input.runId}` } };
    };
    h.codex.state.reply = work;
    h.send('One');
    await h.turn('codex');
    h.send('Two');
    await h.turn('codex');
    const key = h.binding('codex')!.promptKey;
    h.org.add({ ...h.org.require(h.agent.id), instructions: '# How I work\nI write tight and warm.' }); // the prompt moves on
    (h.codex.engine as { rebuild: (input: EngineRebuildInput) => Promise<unknown> }).rebuild = async (input) => {
      h.codex.rebuilds.push(input);
      return { ref: input.revert ? input.revert.ref : 'codex-new', generation: input.generation, items: input.items.length };
    };
    h.clock.set(h.clock.now() + CACHE_COLD_MS + 1); // rested past the cache: the thread is cut back
    h.codex.state.reply = () => ({ text: '', stop: 'error', error: { code: 'unavailable', message: 'the CLI did not start' }, session: undefined });
    h.send('Three');
    await h.turn('codex');
    assert.ok(h.notes('run_3').some((note) => note.revert === true), 'reverted');
    assert.equal(h.binding('codex')?.ref, 'codex-s1');
    assert.equal(h.binding('codex')?.promptKey, key, 'the thread still runs on its own start');
  } finally { stop(); }
});

test('a fresh session the engine names mid-turn is bound with its start record, also when the turn then dies', async () => {
  const h = setup();
  h.claude.state.reply = (input) => {
    input.onEvent({ type: 'session', ref: 'claude-early', generation: 1 });
    return { text: '', stop: 'error', error: { code: 'internal', message: 'the process died' }, session: undefined };
  };
  h.send('Hello');
  await h.turn('claude');
  const bound = h.binding('claude')!;
  assert.equal(bound.ref, 'claude-early');
  assert.ok(startOf(h.db, { agentId: h.agent.id, thread: MAIN_THREAD, engine: 'claude' }, bound.promptKey), 'a later resume runs on that start');
});
