// The person's "Forget permanently" on every one of my PCs (review R1 H5): since the agents' records travel, each CEO PC
// holds copies of them and of their originals. The PC where it is pressed (rpc knowledge.forget) sends the fact's print
// (privacy/mentions.ts fingerprint – the distinctive words and ids, never its text) as op 'forget' of 'sync.ledger' to
// each online CEO PC and keeps it owed (kv) for the others until their link-up (LedgerSync.catchUp sends it first); each
// PC runs its own ledger Forget (context/ledger/forget.ts) over its rows and the originals it holds. A print is kept only
// until it went.
// Owns: sending, keeping and applying those prints. Never: logs a print, passes one on to a third PC, sends to an
// employee's PC.

import { randomUUID } from 'node:crypto';
import type { RuntimeServices } from '../../contracts.ts';
import '../../contracts/ledger.ts';
import { mentions, type Fingerprint } from '../../privacy/mentions.ts';
import { KvRepo } from '../../store/kv.ts';
import { links } from './home.ts';
import { LEDGER_METHOD } from './ledger-fetch.ts';

const OWED = 'sync.ledger.forget';

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 200).slice(0, 64) : []);

/** Runs the ledger Forget here for a print that came from another of my PCs. */
export function forgetHere(s: RuntimeServices, raw: unknown): { ok: true; items: number } {
  const value = (raw ?? {}) as Partial<Fingerprint>;
  const print: Fingerprint = { ids: strings(value.ids), words: strings(value.words) };
  if (!print.ids.length && !print.words.length) return { ok: true, items: 0 };
  const done = s.ledger?.forget?.((text) => mentions(text, print));
  return { ok: true, items: done?.items ?? 0 };
}

/** Sends the print to each of my CEO PCs: the online ones now, the others at their link-up (owed in kv until then). */
export function forgetOnMyPcs(s: RuntimeServices, print: Fingerprint): void {
  if (!s.db || !s.devices) return; // a runtime without a mesh has no other PCs
  const kv = new KvRepo(s.db);
  for (const { record, link } of links(s.db)) {
    if (link.kind !== 'ceo') continue;
    const key = `${record.id}/${randomUUID()}`;
    kv.set(OWED, key, print, s.clock.now());
    if (s.devices.online(record.id)) void sendOne(s, key, print, record.id);
  }
}

async function sendOne(s: RuntimeServices, key: string, print: Fingerprint, peer: string): Promise<boolean> {
  try {
    await s.devices.call(peer, LEDGER_METHOD, { op: 'forget', print });
    new KvRepo(s.db).delete(OWED, key);
    return true;
  } catch (error) {
    s.log.info('forget not sent yet', { peer, error: String((error as Error)?.message ?? error) });
    return false;
  }
}

/** The prints still owed to `peer` (its link-up); false when one did not go. */
export async function owedForgets(s: RuntimeServices, peer: string): Promise<boolean> {
  let ok = true;
  for (const { key, value } of new KvRepo(s.db).list<Fingerprint>(OWED, `${peer}/`)) ok = (await sendOne(s, key, value, peer)) && ok;
  return ok;
}

/** A removed PC is owed nothing. */
export function dropForgets(s: Pick<RuntimeServices, 'db'>, peer: string): void {
  new KvRepo(s.db).deletePrefix(OWED, `${peer}/`);
}
