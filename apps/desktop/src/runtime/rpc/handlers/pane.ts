// RPC handlers: the pane between people for the window and the owner's phone (shared/model/pane.ts) – pane.targets
// (every person with the PCs their pane lives on), pane.open (put a tab on a PC of a person; a website runs there anew,
// a tab that keeps running here – an agent's browser, a path – is shared with that person, so they reach it and it ends
// with the share) and pane.share (add or remove people, or the whole set; none of them only reads who has it). 'manage'
// on a secure transport, like side.open. The tab is given in side-tabs.json's form (a website with its address).
// Owns: param checks and that choice. Never: the rules of where a tab goes (runtime/pane/put.ts).

import '../../../shared/model/pane.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { shareKey } from '../../../shared/model/pane.ts';
import { paneTargets } from '../../pane/targets.ts';
import { putOn, shareOn } from '../../pane/put.ts';
import { entryOf, shareChangeOf } from '../../pane/mesh.ts';
import { input, onlyKeys, optId, optText } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const PANE = { capability: 'manage', secure: true } as const;
const YOU = { id: HUMAN_ID, name: 'You' };

export function register(table: HandlerTable): void {
  table.add('pane.targets', (_params, ctx) => paneTargets(ctx.services), PANE);
  table.add('pane.open', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['person', 'pc', 'entry']);
    const person = optText(o, 'person', { max: 90 }) ?? HUMAN_ID;
    const pc = optId(o, 'pc');
    const entry = entryOf(o.entry);
    if (person !== HUMAN_ID && entry.panel !== undefined && entry.panel !== 'remote' && shareKey(entry)) {
      await shareOn(ctx.services, { entry, add: [person], ...(pc ? { pcs: { [person]: pc } } : {}), by: YOU }, ctx.signal);
      return { ok: true as const, ...(pc ? { pc } : {}) };
    }
    const put = await putOn(ctx.services, { person, ...(pc ? { pc } : {}), entry, mode: 'open', by: YOU }, ctx.signal);
    return { ok: true as const, pc: put.pc.id };
  }, PANE);
  table.add('pane.share', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['entry', 'people', 'add', 'remove', 'pcs']);
    return { ok: true as const, people: await shareOn(ctx.services, shareChangeOf(o, YOU), ctx.signal) };
  }, PANE);
}
