// The one rule for a view that loads its own data (Fest round 22.11.2026: such views loaded once and stayed stale after
// the connection came back, while the shell's snapshots reload with store.loadAll): `useLoad(effect, deps)` is the view's
// load effect – it runs on mount, when `deps` change, and again after every (re)connect (rpc.open, also a pull-down
// refresh), each time after the previous run's cleanup, so the run's own `alive` flag drops a late answer and its event
// listeners are never doubled. What the view shows stays until the fresh answer replaces it: clearing it belongs to a
// change of `deps` (the view's own effect), never to the effect itself.
// Owns: when a view's own load runs. Never: polls, or retries a failed load by itself (the next connect does).

import { useEffect } from 'preact/hooks';
import { rpc } from './rpc.ts';

/** A load effect, like useEffect's: may return its cleanup. */
export type LoadEffect = () => void | (() => void);

/** Runs `effect` now and again after every `onOpen`, the previous run's cleanup first; the returned function ends both. */
export function runOnOpen(effect: LoadEffect, onOpen: (fn: () => void) => () => void): () => void {
  let cleanup = effect();
  const end = () => { if (typeof cleanup === 'function') cleanup(); };
  const off = onOpen(() => {
    end();
    cleanup = effect();
  });
  return () => {
    off();
    end();
  };
}

/** useEffect for a view's own load, run again after every (re)connect. */
export function useLoad(effect: LoadEffect, deps: readonly unknown[]): void {
  useEffect(() => runOnOpen(effect, rpc.onOpen), deps);
}
