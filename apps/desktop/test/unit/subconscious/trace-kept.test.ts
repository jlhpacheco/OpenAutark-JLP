// A kept trace: a turn that never reached its engine gives it back and the next turn shows it, once; a note or hit older than a
// day is dropped, other calls stay.
// Owns: these assertions only. Never: real models or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { NOTE_CALL, type SubconsciousTrace } from '../../../src/shared/model/subconscious.ts';
import { setup } from '../agents/fixture.ts';

const DAY = 24 * 60 * 60_000;
const NOTE: SubconsciousTrace = { calls: [{ tool: NOTE_CALL, args: {}, output: 'Der Kunde wartet auf das Angebot.' }] };

function world() {
  const t = ledgerSetup();
  const impl = new SubconsciousImpl({ services: () => t.services, runner: false });
  const before = () => impl.beforeTurn({ agent: t.tom, thread: 'main' });
  return { t, impl, before };
}

test('a trace put back reaches the next turn once, also after that turn failed before its engine', async () => {
  const { t, impl, before } = world();
  try {
    impl.putBack(t.tom.id, 'main', NOTE);
    const first = await before();
    assert.equal(first?.calls[0].output, NOTE.calls[0].output);
    impl.putBack(t.tom.id, 'main', first!); // that turn failed before its engine
    const second = await before();
    assert.equal(second?.calls[0].output, NOTE.calls[0].output, 'given back whole');
    assert.equal(await before(), undefined, 'taken: not a third time');
  } finally { t.cleanup(); }
});

test('a note or hit older than a day is dropped, also when a turn keeps failing; another call stays', async () => {
  const { t, impl, before } = world();
  try {
    impl.putBack(t.tom.id, 'main', { calls: [
      ...NOTE.calls,
      { tool: 'vector.search', args: { query: 'x', in: ['memory'] }, output: 'h1 memory/a.md' },
      { tool: 'context.restore', args: { ids: ['t1'] }, output: 'restored' },
    ] });
    t.clock.advance(DAY - 1000);
    const kept = await before();
    assert.equal(kept?.calls.length, 3, 'younger than a day');
    impl.putBack(t.tom.id, 'main', kept!);
    t.clock.advance(2000);
    assert.deepEqual((await before())?.calls.map((call) => call.tool), ['context.restore'], 'putting it back does not make it young again');
  } finally { t.cleanup(); }
});

function failing() {
  const h = setup();
  const back: Array<{ agentId: string; thread: string; trace: SubconsciousTrace }> = [];
  Object.assign(h.services.subconscious, {
    beforeTurn: async () => NOTE,
    putBack: (agentId: string, thread: string, trace: SubconsciousTrace) => { back.push({ agentId, thread, trace }); },
  });
  return { h, back };
}

test('routing fails before the engine: the trace goes back for the thread', async () => {
  const { h, back } = failing();
  Object.assign(h.services, { router: { route: async () => { throw new WorkforceError('unavailable', 'No model is connected.'); } } });
  const outcome = await new TurnExecutor(() => h.services).execute(h.request());
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(back, [{ agentId: h.tom.id, thread: 'main', trace: NOTE }]);
});

test('preparing the turn fails before the engine: the trace goes back too; a turn that ran keeps nothing', async () => {
  const { h, back } = failing();
  Object.assign(h.services, { router: { route: async () => h.route } });
  const get = h.services.accounts.get;
  Object.assign(h.services.accounts, { get: () => undefined }); // buildTurn: "The chosen account is not available."
  assert.equal((await new TurnExecutor(() => h.services).execute(h.request())).status, 'failed');
  assert.equal(back.length, 1);
  Object.assign(h.services.accounts, { get });
  assert.notEqual((await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_ran' }))).status, 'skipped');
  assert.equal(back.length, 1, 'it reached the engine');
});
