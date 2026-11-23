// bridge 0.3.18 of the Eine-ID round 22.11.2026 (one Company ID per company, one My ID per person: remote/code.ts), at
// runtime start before the network opens the IDs (runtime/main.ts), idempotent: on an employee's PC (an employer link that is
// not revoked) kv 'remote.code' held the person's own code tree until now. Where that tree is not the company's (its ID
// is not the company's ID, company-facts.ts companyCode), it moves to 'remote.me' – the person keeps the number they had,
// now as My ID – unless a me tree is there already or its root is this PC's own key (My ID never equals the device ID:
// a fresh me tree starts on first use then), and 'remote.code' is cleared: the company's chain comes with the next
// 'company.facts' answer. The company's own PCs simply get a new me tree on first use – nothing to move. Trees opened
// already are read again. This file is deleted in the version after the bridge.
// Owns: that move. Never: touches a company's own PC, the company's tree, or anything beyond the two kv entries.

import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { companyCode } from '../devices/company-facts.ts';
import { DevicesRepo } from '../devices/repo.ts';
import { codeFor, employerPc, meFor, parseTree } from '../remote/code.ts';
import { remoteIdOf } from '../remote/id.ts';
import { fingerprintOf, fromB64url } from '../devices/keys.ts';
import { KvRepo } from '../store/kv.ts';

const KEY = 'tree';

/**
 * The move for one database; true when 'remote.code' was cleared (its tree kept as the me tree where none was and its root
 * is another key – a tree rooted at this PC's own key would make My ID its device ID: a fresh me tree starts instead).
 */
export function moveSeatCode(db: Db, now: number): boolean {
  if (!employerPc(db)) return false;
  const kv = new KvRepo(db);
  const tree = parseTree(kv.get('remote.code', KEY));
  if (!tree || remoteIdOf(fingerprintOf(fromB64url(tree.root))) === companyCode({ db })) return false;
  const self = new DevicesRepo(db).list({ kinds: ['pc'] }).find((device) => device.self);
  const ownRoot = fingerprintOf(fromB64url(tree.root)) === self?.fingerprint;
  if (!ownRoot && kv.get('remote.me', KEY) === undefined) kv.set('remote.me', KEY, tree, now);
  kv.delete('remote.code', KEY);
  return true;
}

/** The bridge (see the header); a failure is logged and tried again at the next start. */
export function runEineId1122(s: RuntimeServices): void {
  try {
    if (!moveSeatCode(s.db, s.clock.now())) return;
    const self = new DevicesRepo(s.db).list({ kinds: ['pc'] }).find((device) => device.self);
    if (self) { codeFor(self.fingerprint)?.refresh(); meFor(self.fingerprint)?.refresh(); }
    s.log.info('eine-id-1122 bridge: the seat\'s own code is now My ID');
  } catch (error) {
    s.log.warn('eine-id-1122 bridge failed', { error: String((error as Error)?.message ?? error) });
  }
}
