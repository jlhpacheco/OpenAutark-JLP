// The people of the company and the PCs their panes live on (pane.targets, shared/model/pane.ts), for the three-dots
// menu's "Open on" and "Share with" (share-tab.ts). One pane.targets on first need, again after a reconnect and when a
// PC or a person comes, changes or goes ('device.*', 'person.*'); no polling. A burst of events asks once more after the
// answer in flight, not once per event. Where this connection has no pane.targets (a person's device, a phone without
// it) the list stays empty and the menu has no such rows.
// Owns: that list. Never: opens or shares a tab, draws anything.

import { signal } from '@preact/signals';
import type { PanePerson } from '../../shared/model/pane.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';

/** Every person of the company with their PCs, me first (as pane.targets gives them). */
export const paneTargets = signal<PanePerson[]>([]);
let watched = false;
let asking = false;
let again = false;

function refresh(): void {
  if (asking) { again = true; return; }
  asking = true;
  rpc.call('pane.targets').then((list) => { paneTargets.value = list; }, () => undefined).finally(() => {
    asking = false;
    if (again) { again = false; refresh(); }
  });
}

/** Starts keeping paneTargets current (idempotent; nothing where this connection has no pane.targets). */
export function watchPaneTargets(): void {
  if (watched || !can('pane.targets')) return;
  watched = true;
  for (const event of ['device.upserted', 'device.removed', 'person.upserted', 'person.removed'] as const) rpc.on(event, refresh);
  rpc.onOpen(refresh);
  refresh();
}
