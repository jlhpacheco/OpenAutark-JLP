// Calls to "the PC a tab runs on" (shared/model/pane.ts). A PC linked here is called directly. An employee's PC has no
// link to a colleague's PC: it asks its company's PC (mesh 'pane.relay'), which passes the call on once – to the PCs
// of its employees only, only the pane's own methods, and with `for` set to the caller's person, so the PC at the end
// checks what is shared with whom (shares.ts reach). Nothing goes further than that one step.
// Owns: callPc, the relay's method list and its handler. Never: decides what is shared or answers for a tab itself.

import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import { DevicesRepo } from '../devices/repo.ts';
import { linkOf, links } from '../devices/sync/home.ts';
import type { PeerHandler } from '../devices/rpc-peer.ts';

export const RELAY_METHOD = 'pane.relay';
/** What the company's PC passes on between its employees' PCs. */
export const RELAYED: ReadonlySet<string> = new Set([
  'pane.put', 'pane.remove', 'side.pull', 'side.pullPart', 'side.input', 'side.nav',
  'browser.pull', 'browser.pullPart', 'browser.input', 'browser.navigate', 'browser.takeover', 'files.path',
]);
const UNREACHABLE = 'That PC cannot be reached from here.';
/** The longest a passed-on call waits for its answer. */
const MAX_WAIT_MS = 5 * 60_000;

type Services = Pick<RuntimeServices, 'db' | 'devices'>;

/** Calls `method` on PC `device`: directly when it is linked here, else through the company's PC. */
export async function callPc(s: Services, device: string, method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
  if (linkOf(new DevicesRepo(s.db).get(device))) return s.devices.call(device, method, params, signal, timeoutMs);
  const employer = links(s.db).find(({ link }) => link.kind === 'employer');
  if (!employer || !RELAYED.has(method)) throw new WorkforceError('unavailable', UNREACHABLE);
  const wait = timeoutMs === undefined ? {} : { timeoutMs };
  return s.devices.call(employer.record.id, RELAY_METHOD, { to: device, method, params, ...wait }, signal, timeoutMs === undefined ? undefined : timeoutMs + 10_000);
}

/** The company PC's side: an employee's call for a colleague's PC, passed on once with the caller's person as `for`. */
export function relayHandler(services: () => Services): PeerHandler {
  return async (params, from, signal) => {
    const s = services();
    const caller = linkOf(new DevicesRepo(s.db).get(from));
    const o = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const to = typeof o.to === 'string' ? o.to : '';
    const target = linkOf(new DevicesRepo(s.db).get(to));
    if (caller?.kind !== 'employee' || target?.kind !== 'employee' || typeof o.method !== 'string' || !RELAYED.has(o.method)) {
      throw new WorkforceError('forbidden', UNREACHABLE);
    }
    const inner = (o.params && typeof o.params === 'object' ? o.params : {}) as Record<string, unknown>;
    const wait = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? Math.min(o.timeoutMs, MAX_WAIT_MS) : undefined; // the caller's own wait, e.g. an ask there
    return s.devices.call(to, o.method, { ...inner, for: caller.personId }, signal, wait);
  };
}
