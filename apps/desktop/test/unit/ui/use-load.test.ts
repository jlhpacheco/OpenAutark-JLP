// A view's own load runs again after every (re)connect (lib/use-load.ts, Fest round 22.11.2026): runOnOpen – what
// useLoad wraps in a useEffect – runs the effect now and after every rpc.open, each time after the previous run's cleanup
// (so a late answer of the old run is dropped and its listeners are not doubled), and its end stops both.
// Owns: these assertions only. Never: a real socket, runtime or rendered view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnOpen } from '../../../src/ui/lib/use-load.ts';

/** A stand-in for rpc.onOpen: `open()` is a (re)connect. */
function connection() {
  const listeners = new Set<() => void>();
  return {
    onOpen: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    open: () => { for (const fn of [...listeners]) fn(); },
    listening: () => listeners.size,
  };
}

test('the load runs now and again after every reconnect, the last run cleaned up first', () => {
  const link = connection();
  const log: string[] = [];
  let run = 0;
  const end = runOnOpen(() => {
    const mine = ++run;
    log.push(`load ${mine}`);
    return () => { log.push(`cleanup ${mine}`); };
  }, link.onOpen);
  assert.deepEqual(log, ['load 1']);
  link.open();
  link.open();
  assert.deepEqual(log, ['load 1', 'cleanup 1', 'load 2', 'cleanup 2', 'load 3']);
  end();
  assert.deepEqual(log.slice(-1), ['cleanup 3'], 'unmount or new deps: the current run is cleaned up');
  assert.equal(link.listening(), 0, 'and no reconnect reaches it any more');
  link.open();
  assert.equal(run, 3);
});

test('a late answer of a run that was replaced is dropped by its own alive flag', async () => {
  const link = connection();
  const shown: string[] = [];
  const answers: Array<(value: string) => void> = [];
  const end = runOnOpen(() => {
    let alive = true;
    void new Promise<string>((resolve) => answers.push(resolve)).then((value) => { if (alive) shown.push(value); });
    return () => { alive = false; };
  }, link.onOpen);
  link.open(); // the connection came back while the first answer was still on its way
  answers[1]('fresh');
  answers[0]('stale');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, ['fresh']);
  end();
});

test('an effect without a cleanup (a plain load) runs again too', () => {
  const link = connection();
  let loads = 0;
  const end = runOnOpen(() => { loads += 1; }, link.onOpen);
  link.open();
  end();
  link.open();
  assert.equal(loads, 2);
});
