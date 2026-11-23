// Where a person's pane lives, as this PC knows it (shared/model/pane.ts): this PC's own person ('human') on this PC and
// its 'ceo' links (their own PCs); a colleague ('per_…') on the PCs linked here as theirs ('employee' links) – on an
// employee's PC the company names its colleagues' PCs (company.facts `pcs`); the CEO seen from an employee's PC
// ('owner') on the company's PCs ('employer' links). No PC: the person's pane lives on the company's PCs
// (space 'person:<id>'). defaultPc picks where a tab goes when nobody names a PC: the one that is already here, else
// their only PC, else one that is online.
// Owns: those lists and that default. Never: calls a PC or writes a pane.

import { HUMAN_ID } from '../../shared/ids.ts';
import { OWNER_ALIAS } from '../../shared/model/people.ts';
import type { PanePc, PanePerson } from '../../shared/model/pane.ts';
import type { RuntimeServices } from '../contracts.ts';
import { links } from '../devices/sync/home.ts';
import { employerFacts } from '../devices/company-facts.ts';

type Services = Pick<RuntimeServices, 'db' | 'devices'> & Partial<Pick<RuntimeServices, 'people'>>;

const online = (s: Services, id: string): boolean => { try { return s.devices.online(id); } catch { return false; } };

/** This PC as a PanePc. */
export function selfPc(s: Pick<RuntimeServices, 'devices'>): PanePc {
  const self = s.devices.self();
  return { id: self.id, name: self.name || 'This PC', online: true, self: true };
}

/** The PCs `person`'s pane lives on, this one first, then online before offline. */
export function pcsOf(s: Services, person: string): PanePc[] {
  const out: PanePc[] = person === HUMAN_ID ? [selfPc(s)] : [];
  for (const { record, link } of links(s.db)) {
    const match = person === HUMAN_ID ? link.kind === 'ceo' : person === OWNER_ALIAS ? link.kind === 'employer' : link.kind === 'employee' && link.personId === person;
    if (match) out.push({ id: record.id, name: record.name, online: online(s, record.id) });
  }
  if (person !== HUMAN_ID && person !== OWNER_ALIAS && !out.length) {
    const colleague = employerFacts(s)?.people?.find((entry) => entry.id === person);
    for (const pc of colleague?.pcs ?? []) out.push({ id: pc.id, name: pc.name, online: false });
  }
  return out.sort((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)) || Number(b.online) - Number(a.online));
}

/** The PC a tab for `person` goes to when none is named: `here` when it is theirs, else their only one, else the first online. */
export function defaultPc(pcs: readonly PanePc[], here?: string): PanePc | undefined {
  return pcs.find((pc) => pc.id === here) ?? (pcs.length === 1 ? pcs[0] : pcs.find((pc) => pc.online) ?? pcs[0]);
}

/** Every person of the company with their PCs, this PC's person first. */
export function paneTargets(s: Services): PanePerson[] {
  const people = (s.people?.list() ?? []).filter((person) => person.status !== 'revoked');
  const ids = [HUMAN_ID, ...people.map((person) => person.id).filter((id) => id !== HUMAN_ID)];
  return [...new Set(ids)].map((id) => ({
    id, me: id === HUMAN_ID, pcs: pcsOf(s, id),
    name: s.people?.nameOf(id) ?? people.find((person) => person.id === id)?.name ?? (id === HUMAN_ID ? 'Me' : id),
  }));
}
