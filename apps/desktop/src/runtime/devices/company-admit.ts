// Admit through the company (Eine-ID 22.11.2026, owner: "jedes Mitglied … hat diese ID stehen und kann approven"). Every
// member's PC shows the company's ID and accepts a new member, but the person and their PC belong to the company: a member
// PC that is not one of the company's own PCs (it has an employer link) hands the accepted PC to its company's PC over the
// mesh – 'company.admit' { info: the new PC as the request proved it, person: { name } }. The company's PC makes the
// person, stores the new PC as theirs, signs it into the company's tree (remote/service.ts admitHere) and answers with
// its own identity (`employer`); the member PC passes that on in the accepted answer, and the new PC links the company's
// PC, not the member's (remote/join.ts). The member PC stores nothing. The method answers employee links only (a member's
// PC of this company), makes a person only with a non-empty plain name, and never for a key already linked here.
// Review 22.11.2026: the same admit asked again (a member's PC that missed the answer) answers again – the keys stored
// through an admit are marked (kv 'company.admit', admitMarks); a key linked any other way stays a conflict. A member's
// PC with several employer links asks an online one first (employerOf – Accept's check and the call use the same).
// Owns: the method name, its params check, both ends of the call, the admit marks and the line when the company's PC is away.
// Never: links or makes anything itself (remote/service.ts does), or answers a link that is not a member's PC.

import { WorkforceError } from '../../shared/errors.ts';
import type { Device } from '../../shared/model/devices.ts';
import { plainLabel } from '../../shared/text/device-label.ts';
import type { Db } from '../db/database.ts';
import { bad, input, obj, onlyKeys, text } from '../rpc/params.ts';
import { KvRepo } from '../store/kv.ts';
import { fingerprintOf, fromB64url } from './keys.ts';
import type { LinkKind } from './mesh.ts';
import { parseInfo, type PeerInfo } from './pair-proof.ts';
import type { PeerHandler } from './rpc-peer.ts';
import { linkOf } from './sync/home.ts';

export const ADMIT_METHOD = 'company.admit';
const MARKS = 'company.admit';
/** How long the company's PC may take (it stores a person and a device). */
export const ADMIT_MS = 15_000;
/** Its refusals as it said them; anything else means it did not answer. */
const REFUSALS: ReadonlySet<string> = new Set(['bad_request', 'conflict', 'forbidden']);

export interface AdmitMesh {
  register(method: string, handler: PeerHandler, kinds?: readonly LinkKind[]): void;
  call(deviceId: string, method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
  list(): Device[];
}

/** The company's PC this PC joined as a member's (its employer link; an online one first); undefined on the company's own PCs. */
export function employerOf(devices: readonly Device[]): Device | undefined {
  const employers = devices.filter((device) => linkOf(device)?.kind === 'employer');
  return employers.find((device) => device.status === 'online') ?? employers[0];
}

/** The keys this company's PC stored through an admit (kv), so the same admit asked again answers again. */
export interface AdmitMarks { has(fingerprint: string): boolean; add(fingerprint: string): void }

export function admitMarks(db: Db): AdmitMarks {
  const kv = new KvRepo(db);
  return {
    has: (fingerprint) => { try { return kv.get(MARKS, fingerprint) === true; } catch { return false; } },
    add: (fingerprint) => { kv.set(MARKS, fingerprint, true, Date.now()); },
  };
}

/** The line Accept shows while the PC that adds the new member is away (today the company's PC, by its name). */
export function unreachable(employer: Pick<Device, 'name'>): string {
  return `${plainLabel(employer.name) || 'The PC of the company'} is not reachable right now. The new member is added on it – try again once it is on.`;
}

/** company.admit's params, checked: the new PC as proven and a non-empty plain name. */
export function readAdmit(params: unknown): { info: PeerInfo; name: string } {
  const o = input(params);
  onlyKeys(o, ['info', 'person']);
  const info = parseInfo(o.info) ?? bad('info', 'a PC as its request proved it');
  const person = obj(o, 'person');
  onlyKeys(person, ['name'], 'person');
  const name = plainLabel(text(person, 'name', { max: 200 }), 80);
  if (!name) bad('person.name', 'a name');
  return { info, name };
}

/** The company's side: answers company.admit to its members' PCs with this PC's identity once `admit` stored the new one. */
export function serveAdmit(mesh: Pick<AdmitMesh, 'register' | 'list'>, admit: (info: PeerInfo, name: string) => PeerInfo): void {
  mesh.register(ADMIT_METHOD, async (params, from) => {
    if (linkOf(mesh.list().find((device) => device.id === from))?.kind !== 'employee') throw new WorkforceError('forbidden', 'A member\'s PC of this company adds new members here.');
    const { info, name } = readAdmit(params);
    return { employer: admit(info, name) };
  }, ['employee']);
}

/** The member's side: the company's PC adds the new member; returns that PC as it answered (its key checked against the link). */
export async function admitThrough(mesh: Pick<AdmitMesh, 'call'>, employer: Device, info: PeerInfo, name: string): Promise<PeerInfo> {
  let reply: unknown;
  try {
    reply = await mesh.call(employer.id, ADMIT_METHOD, { info, person: { name } }, undefined, ADMIT_MS);
  } catch (error) {
    if (error instanceof WorkforceError && REFUSALS.has(error.code)) throw error;
    if (error instanceof WorkforceError && error.code === 'not_found') throw new WorkforceError('unavailable', `Update Autark on ${plainLabel(employer.name) || 'the PC of the company'} – the new member is added on it.`);
    throw new WorkforceError('unavailable', unreachable(employer));
  }
  const pc = parseInfo((reply as { employer?: unknown } | null)?.employer);
  if (!pc || pc.id !== employer.id || fingerprintOf(fromB64url(pc.pub)) !== employer.fingerprint) throw new WorkforceError('forbidden', 'The company\'s PC answered as another PC.');
  return pc;
}
