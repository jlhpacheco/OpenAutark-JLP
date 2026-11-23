// Network paths (20.11.2026, review of FCMWO5R5): a path on another computer (`\\host\share\…`, `//host/share/…`) makes
// this PC look the host up – by DNS, LLMNR, NetBIOS or mDNS, all answerable by any machine on the network – and sign in
// to it over SMB with the person's Windows account. A path in an agent's text can come from a web page or a mail, so a
// host is reached only after the person has confirmed that host once on this PC: the file methods (files-path.ts,
// files.ts) ask `checkNetHost` first, and the refusal names the host in `details.netHost`, so the app asks the person
// one question and remembers the answer (files.allowHost, the person's own call). The list lives in this PC's kv store,
// per host, lowercased; a host is never forgotten by itself. Near-path suggestions never walk a network path
// (near-paths.ts).
// Owns: what a network path's host is, the confirmed hosts and that check. Never: opens a path, or confirms a host for
// anyone but the person.

import { WorkforceError } from '../../shared/errors.ts';
import type { Db } from '../db/database.ts';
import { KvRepo } from '../store/kv.ts';

const NS = 'files';
const KEY = 'netHosts';
/** How many hosts the list keeps (newest last): far more than one person's shares. */
const HOSTS_MAX = 200;

/** The host a network path names (`\\nas\share\x`, `//nas/share/x`, `\\?\UNC\nas\…`), lowercased; undefined for any other path. */
export function netHostOf(target: string): string | undefined {
  const unc = /^[\\/]{2}(?:[?.][\\/]UNC[\\/])?([^\\/]+)/i.exec(target);
  if (!unc) return undefined;
  const host = unc[1]!.toLowerCase();
  return host === '?' || host === '.' ? undefined : host; // \\?\C:\… and \\.\… are this PC's own namespaces
}

/** The hosts the person confirmed on this PC. */
export function confirmedHosts(db: Db): string[] {
  const list = new KvRepo(db).get<unknown>(NS, KEY);
  return Array.isArray(list) ? list.filter((host): host is string => typeof host === 'string') : [];
}

/** Remembers `host` as confirmed by the person (idempotent). */
export function confirmHost(db: Db, host: string, at: number): string {
  const name = host.trim().toLowerCase();
  if (!name || name.length > 255 || /[\\/\s]/.test(name) || name === '?' || name === '.') {
    throw new WorkforceError('bad_request', 'Invalid parameter "host": expected a host name.', { details: { param: 'host' } });
  }
  const hosts = confirmedHosts(db).filter((known) => known !== name);
  new KvRepo(db).set(NS, KEY, [...hosts, name].slice(-HOSTS_MAX), at);
  return name;
}

/** Throws 'forbidden' with `details.netHost` while `target` is a network path on a host the person has not confirmed here. */
export function checkNetHost(db: Db, target: unknown): void {
  if (typeof target !== 'string') return;
  const host = netHostOf(target);
  if (!host || confirmedHosts(db).includes(host)) return;
  throw new WorkforceError('forbidden', `${host} is another computer on the network. Opening a file there signs this PC in to it, so Autark asks once before it goes there.`, { details: { netHost: host } });
}
