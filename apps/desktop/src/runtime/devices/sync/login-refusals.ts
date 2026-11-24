// 24.11.2026 (ORENDA find: 231 sends in an hour to a PC that answered 'forbidden', and nobody was told): the PCs that refuse
// the plan logins this PC sends them (LoginSync, logins.ts). Such a PC gets no more logins – not on each catch-up round, not
// on each change of a login – until something relevant changes: a new connection (`reopen`, at a link-up: one try), its role
// or version there (`sig`), or a plan it was not tried with. The log says it once per PC and reason, not per try, and
// Settings › Devices says on its row that this PC's sign-ins are not shared there (devices/logins-refused.ts, memory only).
// Owns: who refuses which plans, and telling the windows. Never: sends or reads a login, or stores anything.

import type { RuntimeServices } from '../../contracts.ts';
import { DevicesRepo } from '../repo.ts';
import { clearLoginsRefused, noteLoginsRefused } from '../logins-refused.ts';

export class LoginRefusals {
  private readonly s: Pick<RuntimeServices, 'db' | 'bus' | 'log' | 'devices'>;
  /** Per PC that answered 'forbidden': what it was then (`sig`) and the plans it refused. */
  private readonly entries = new Map<string, { sig: string; accounts: Set<string> }>();
  /** Per PC: the state (sig) its refusal was last logged for. */
  private readonly told = new Map<string, string>();

  constructor(s: Pick<RuntimeServices, 'db' | 'bus' | 'log' | 'devices'>) { this.s = s; }

  /** What `peer` is by now – a change of it (its role or its version there) ends a refusal. */
  private sigOf(peer: string): string {
    const record = new DevicesRepo(this.s.db).get(peer);
    return record ? [record.personId ?? '', record.joinedAs ?? '', record.caps?.version ?? ''].join('|') : '';
  }

  /** Tells the windows that a device's row changed (its refusal began or ended). */
  private announce(peer: string): void {
    try {
      const device = this.s.devices.list?.().find((entry) => entry.id === peer);
      if (device) this.s.bus.emit('device.upserted', device);
    } catch { /* the row shows it at the next change */ }
  }

  /** The plans `peer` refused, while its refusal holds (undefined: it refuses nothing now). */
  held(peer: string): ReadonlySet<string> | undefined {
    const entry = this.entries.get(peer);
    if (entry && entry.sig !== this.sigOf(peer)) { this.forget(peer); return undefined; }
    return entry?.accounts;
  }

  /** `peer` answered 'forbidden' to these plans. */
  refuse(peer: string, accounts: readonly string[]): void {
    const sig = this.sigOf(peer);
    const entry = this.entries.get(peer);
    if (entry) for (const id of accounts) entry.accounts.add(id);
    else this.entries.set(peer, { sig, accounts: new Set(accounts) });
    if (noteLoginsRefused(peer)) this.announce(peer);
    if (this.told.get(peer) === sig) return;
    this.told.set(peer, sig);
    this.s.log.info('logins not sent: that PC takes none from this one', { peer, count: accounts.length, error: 'forbidden' });
  }

  /** A new connection: one more try (the row stays marked until the PC takes a login or its role changes). */
  reopen(peer: string): void { this.entries.delete(peer); }

  /** `peer` took a login: no refusal. */
  accepted(peer: string): void {
    this.entries.delete(peer);
    if (clearLoginsRefused(peer)) this.announce(peer);
  }

  /** Its role changed, or the PC is gone: nothing is known about it any more. */
  forget(peer: string): void {
    this.entries.delete(peer);
    this.told.delete(peer);
    if (clearLoginsRefused(peer)) this.announce(peer);
  }
}
