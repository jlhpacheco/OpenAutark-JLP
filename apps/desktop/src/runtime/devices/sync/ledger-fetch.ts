// Originals of an agent's record that live on another of my PCs (Umzug 21.11.2026): op 'fetch' of 'sync.ledger' serves
// the named run items of an agent's runs (with their calls and runs, within one page); pullItems asks my online CEO
// PCs for them. A restore of an item whose original is not here (a hidden row's never travels; a row from a linked PC
// names it in `pc`) first fetches it from that PC – and then from my other online PCs, since a row passed on by a later
// writer names that writer – bounded by RESTORE_WAIT_MS (fetchAway, context/ledger/restore.ts restoreFetched); what
// still is not here says where it is (awayLine).
// Owns: these fetches and that line. Never: sends anything unasked, logs content, writes over a run item another run holds.

import { existsSync } from 'node:fs';
import type { RuntimeServices } from '../../contracts.ts';
import { blobIdsOf, withheldTool } from '../../context/ledger/originals.ts';
import type { LedgerRow } from '../../context/ledger/store.ts';
import { DevicesRepo } from '../repo.ts';
import { needBlob } from './blobs.ts';
import { links } from './home.ts';
import { originalsIn, originalsOf, PAGE_BYTES, putOriginals, type LocalRow, type WireRow } from './ledger-wire.ts';

export const LEDGER_METHOD = 'sync.ledger';
/** Run items per fetch call. */
export const FETCH = 50;
/** How long a restore waits for originals from another PC. */
export const RESTORE_WAIT_MS = 10_000;

/** My CEO PCs that are online, `first` (when online) ahead of the others. */
export function onlinePeers(s: Pick<RuntimeServices, 'db' | 'devices'>, first?: string): string[] {
  const peers = links(s.db).filter(({ link }) => link.kind === 'ceo').map(({ record }) => record.id).filter((id) => s.devices.online(id));
  return first && peers.includes(first) ? [first, ...peers.filter((id) => id !== first)] : peers;
}

/** Op 'fetch': the named run items of `agentId`'s runs this PC holds, with their calls and runs (within one page). */
export function serveFetch(s: RuntimeServices, agentId: unknown, raw: unknown): { ok: true; runs: unknown[]; items: unknown[] } {
  const ids = (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === 'string' && id.length <= 200).slice(0, FETCH);
  const held = ids.filter((id) => s.db.get('SELECT 1 AS hit FROM run_items i JOIN runs r ON r.id = i.run_id WHERE i.id = ? AND r.agent_id = ?', [id, String(agentId)]));
  const originals = originalsOf(s.db, held.map((id) => ({ state: 'keep', ref: `item:${id}` }) as unknown as WireRow)); // asked for by name: the original goes
  while (originals.items.length && Buffer.byteLength(JSON.stringify(originals)) > PAGE_BYTES) originals.items.pop();
  return { ok: true, ...originals };
}

/** Asks `peers` in turn for the run items `ids` of `agentId`'s runs that are still missing here; inserts what comes (ids kept). */
export async function pullItems(s: RuntimeServices, agentId: string, ids: readonly string[], peers: readonly string[]): Promise<void> {
  const missing = () => ids.filter((id) => !s.db.get('SELECT 1 AS hit FROM run_items WHERE id = ?', [id]));
  for (const peer of peers) {
    const left = missing();
    for (let index = 0; index < left.length; index += FETCH) {
      const answer = await s.devices.call(peer, LEDGER_METHOD, { op: 'fetch', agentId, ids: left.slice(index, index + FETCH) }).catch(() => undefined) as Record<string, unknown> | undefined;
      if (!answer) break; // that PC is not answering: the next one
      s.db.tx(() => putOriginals(s.db, originalsIn(answer), peer, false));
    }
  }
}

/** The blobs a run item names that are not here (none without a file store). */
function blobsMissing(s: Pick<RuntimeServices, 'files'>, data: string): string[] {
  if (!s.files) return [];
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { return []; }
  return blobIdsOf(parsed).filter((id) => { try { return !existsSync(s.files.path(id)); } catch { return false; } });
}

type PeerLedgerRow = LedgerRow & Pick<LocalRow, 'pc'>;

interface Away { itemId: string; runItem: string; pc: string }

/** The items among `itemIds` that came from a linked PC and whose original (run item or blob) is not here. */
function awayRows(s: RuntimeServices, agentId: string, thread: string, itemIds: readonly string[]): Away[] {
  const out: Away[] = [];
  for (const itemId of itemIds) {
    const row = s.db.get<PeerLedgerRow>('SELECT * FROM context_items WHERE agent_id = ? AND conversation_id = ? AND item_id = ?', [agentId, thread, itemId]);
    if (!row?.pc || !row.ref?.startsWith('item:')) continue;
    if (withheldTool({ db: s.db }, row)?.reason === 'blocked') continue;
    const runItem = row.ref.slice(5);
    const item = s.db.get<{ data: string }>('SELECT data FROM run_items WHERE id = ?', [runItem]);
    if (!item || blobsMissing(s, item.data).length) out.push({ itemId, runItem, pc: row.pc });
  }
  return out;
}

/** Fetches the originals of `itemIds` that are on another of my PCs (run items, then their blobs); at most `waitMs`, never throws. */
export async function fetchAway(s: RuntimeServices, agentId: string, thread: string, itemIds: readonly string[], waitMs = RESTORE_WAIT_MS): Promise<void> {
  const away = awayRows(s, agentId, thread, itemIds);
  if (!away.length) return;
  const work = (async () => {
    for (const pc of new Set(away.map((row) => row.pc))) {
      await pullItems(s, agentId, away.filter((row) => row.pc === pc).map((row) => row.runItem), onlinePeers(s, pc));
    }
    if (!s.paths) return;
    for (const { itemId, runItem } of away) {
      // A peer may have just supplied the name that identifies a withheld item. Do not fetch its body.
      const row = s.db.get<LedgerRow>('SELECT * FROM context_items WHERE agent_id = ? AND conversation_id = ? AND item_id = ?', [agentId, thread, itemId]);
      if (!row || withheldTool({ db: s.db }, row)) continue;
      const data = s.db.get<{ data: string }>('SELECT data FROM run_items WHERE id = ?', [runItem])?.data;
      for (const blob of data ? blobsMissing(s, data) : []) await needBlob(s, blob);
    }
  })().catch((error: unknown) => s.log.info('restore originals not fetched', { agentId, error: String((error as Error)?.message ?? error) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
}

/**
 * Where the original of `itemId` is when it is on another of my PCs and not here (undefined otherwise); when that PC is
 * online the fetch starts (again) in the background, so asking once more finds it.
 */
export function awayLine(s: RuntimeServices, agentId: string, thread: string, itemId: string): string | undefined {
  const away = awayRows(s, agentId, thread, [itemId])[0];
  if (!away) return undefined;
  const name = new DevicesRepo(s.db).get(away.pc)?.name ?? away.pc;
  if (!s.devices.online(away.pc)) return `The original is on ${name}, which is not reachable right now.`;
  void fetchAway(s, agentId, thread, [itemId]);
  return `The original is on ${name}; it is on its way here – I ask for ${itemId} again in a moment.`;
}
