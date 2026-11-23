// Round 2 (Umzug 21.11.2026): a restore on the agent's new PC of an item whose original stayed on the PC it came from (a
// hidden row's original never travels) – context/ledger/restore.ts restoreFetched, devices/sync/ledger-fetch.ts: it comes
// from that PC first and is restored as usual; with that PC offline the result says where the original is; the plain
// restoreItems starts the fetch and says it is on its way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextLedgerService } from '../../../src/runtime/context/ledger/service.ts';
import { restoreFetched, restoreItems } from '../../../src/runtime/context/ledger/restore.ts';
import { link, Net, settle } from './sync-net.ts';
import { homeOf, items, journal, ledgerPc, MARA, row, THREAD } from './sync-ledger-rig.ts';

/** Mara's record went from A to B with one hidden tool row; then she moved to B. */
async function moved() {
  const net = new Net();
  const a = ledgerPc(net, 'dev_a', 'dev_a');
  const b = ledgerPc(net, 'dev_b', 'dev_a');
  link(a, b);
  journal(a, 'run_1', 'ri_hidden', 30);
  const hidden = row(a, 'tool', { ref: 'item:ri_hidden', runId: 'run_1', state: 'hidden', title: 'shell.exec ls' });
  await a.ledger.catchUp('dev_b');
  for (const pc of [a, b]) homeOf(pc, 'dev_b');
  b.h.services.ledger = new ContextLedgerService({ services: () => b.h.services });
  return { net, a, b, id: hidden.item_id };
}

test('restore on the new PC: the hidden item\'s original comes from the PC it was written on, then it is restored as usual', async () => {
  const { b, id } = await moved();
  assert.deepEqual(items(b), [], 'a hidden row travels without its original');
  const result = await restoreFetched(b.h.services, MARA, THREAD, { ids: [id] });
  assert.match(result, new RegExp(`^Restored ${id} – kept in my context`));
  assert.match(result, /x{30}/, 'the original text');
  assert.deepEqual(items(b), ['ri_hidden', 'ri_hidden_call'], 'it is here now');
  assert.equal(b.h.services.ledger!.items(MARA, THREAD)[0].state, 'keep');
});

test('restore on the new PC while the other PC is offline says where the original is; the plain restore starts the fetch', async () => {
  const { net, b, id } = await moved();
  net.up = false;
  const offline = await restoreFetched(b.h.services, MARA, THREAD, { ids: [id] });
  assert.match(offline, /^Nothing restored\./);
  assert.match(offline, /The original is on dev_a, which is not reachable right now\. What is left: shell\.exec ls/);
  net.up = true;
  const plain = restoreItems(b.h.services, MARA, THREAD, { ids: [id] });
  assert.match(plain, new RegExp(`The original is on dev_a; it is on its way here – I ask for ${id} again in a moment\.`));
  await settle();
  assert.match(restoreItems(b.h.services, MARA, THREAD, { ids: [id] }), new RegExp(`^Restored ${id}`), 'asked again, it is there');
});
