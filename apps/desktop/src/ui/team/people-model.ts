// Team › People, pure parts (F-52): status labels, the "reports to" choices (the owner, other people
// or agents – one org chart), who reports to whom, and the short code grouping.
// B-041 §8: the org chart with people as nodes (peopleOrg: an agent under a person nests under that
// person), whom an agent reports to from this connection's side (managerOf: no manager is the top –
// the caller on the owner's PC, the CEO on a person's device) and which side a chat message is drawn
// on (messageSide: only the caller's own words are the right-hand bubble).
// F13/F14 (owner 15.11.2026): who is in the org chart and who still sits under "Invited" (splitInvited: a person counts
// once they joined), the person Team › Add person names for Accept (newPersonOf) and whether a browser elsewhere on the
// network can open this PC's invite link (browserReachable). F13: the role choice – a member or a second CEO – and its
// line (ROLE_OPTIONS, roleHint).
// Owns: these derivations. Never: calls the runtime or renders.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import { hasJoined, isHumanActor, OWNER_ALIAS } from '../../shared/model/people.ts';
import type { Person, PersonRole } from '../../shared/model/people.ts';
import type { NewPerson } from '../../shared/model/remote.ts';
import type { OrgEntry } from './model.ts';

export function statusLabel(person: Pick<Person, 'owner' | 'status'>): string {
  if (person.owner) return 'Owner';
  return person.status === 'active' ? 'Active' : person.status === 'invited' ? 'Invited' : 'Access removed';
}

/** Choices for "Reports to": nobody, the owner, other active people, active agents (never the person themself). */
export function managerOptions(selfId: string | undefined, people: readonly Person[], agents: readonly Agent[]): Array<{ value: string; label: string }> {
  const out = [{ value: '', label: 'Nobody (top of the organisation)' }];
  for (const person of people) {
    if (person.id === selfId || person.status === 'revoked') continue;
    out.push({ value: person.id, label: person.title ? `${person.name} · ${person.title}` : person.name });
  }
  for (const agent of agents) {
    if (agent.archivedAt !== undefined) continue;
    out.push({ value: agent.id, label: `${agent.name}${agent.role ? ` · ${agent.role}` : ''} (agent)` });
  }
  return out;
}

/** F14: the people of the org chart (the owner and everyone who joined) and those invited who never joined yet. */
export function splitInvited<T extends Pick<Person, 'owner' | 'joinedAt' | 'status'>>(people: readonly T[]): { members: T[]; invited: T[] } {
  const members: T[] = [];
  const invited: T[] = [];
  for (const person of people) (hasJoined(person) ? members : invited).push(person);
  return { members, invited };
}

/** F13: the person Add person's form names (undefined without a name); "" for Reports to is the top of the org. */
export function newPersonOf(form: { name: string; title: string; managerId: string; role?: PersonRole }): NewPerson | undefined {
  const name = form.name.trim();
  if (!name) return undefined;
  const title = form.title.trim();
  return { name, ...(title ? { title } : {}), ...(form.managerId ? { managerId: form.managerId } : {}), ...(form.role === 'ceo' ? { role: 'ceo' as const } : {}) };
}

/** F13: the role choice – a member of the organisation, or a second CEO beside the owner. */
export const ROLE_OPTIONS: Array<{ value: PersonRole; label: string }> = [{ value: 'member', label: 'Member' }, { value: 'ceo', label: 'CEO' }];

/** F13: the line under the role choice (it has its place for either role, so nothing below moves). */
export function roleHint(role: PersonRole): string {
  return role === 'ceo'
    ? 'Like you: every agent, person, task and company chat – not your plans, keys, secrets, Settings or 1:1s'
    : 'Their own chats, with the agents and permissions you give them';
}

/** F13: Add person's connect code row – how their phone and their PC use it. */
export const ADD_PERSON_CODE_HINT = 'Their phone: scan this in the Autark app · Autark on their PC: Join a company, these digits';

/** F13: Add person's request slot while no request row shows there: what to do next, or what happens now. */
export function requestSlotHint(state: { named: boolean; waiting: number; accepted?: string }): string {
  if (state.accepted) return `Accepted · ${state.accepted} is added as their device connects, then their page opens`;
  if (state.named) return 'Waiting for their phone or PC to ask';
  if (!state.waiting) return 'Enter their name above; their device’s request shows here';
  return `${state.waiting === 1 ? 'A device asks' : `${state.waiting} devices ask`} to connect · enter their name above to accept`;
}

/** F13: a browser elsewhere on the network can open this PC's link – an https or a non-loopback address (pwa.state urls). */
export function browserReachable(urls: readonly string[]): boolean {
  return urls.some((url) => url.startsWith('https://') || !/^http:\/\/(localhost|127\.|\[::1\])/i.test(url));
}

// ------------------------------------------------------------------ one org chart (B-041 §8)

/** A person in the org chart with the people and the agent branches that report to them. */
export interface PersonEntry { person: Person; people: PersonEntry[]; agents: OrgEntry[] }

/** The organisation's top from this connection's side: the owner's row ('human' on the owner's PC, 'owner' on a person's device). */
export function topPersonId(people: ReadonlyArray<Pick<Person, 'id' | 'owner'>>): string {
  return people.find((person) => person.owner)?.id ?? HUMAN_ID;
}

/** Number of people and agents below a person (all levels). */
export function countPersonReports(entry: PersonEntry): number {
  const agents = (list: OrgEntry[]): number => list.reduce((sum, report) => sum + 1 + agents(report.reports), 0);
  return entry.people.reduce((sum, report) => sum + 1 + countPersonReports(report), 0) + agents(entry.agents);
}

/**
 * The people part of the one org chart. `tree` is buildOrg's agent forest (an agent whose manager
 * is no agent is one of its roots). A root whose manager is a listed person other than the top
 * moves under that person with its whole branch; the top's own agents (no manager, or the top's
 * id) stay in `agents` – the space-grouped tree under People – and so does a root whose person
 * manager is not listed. People nest under a listed person manager (a cycle is broken: such a
 * person becomes a root); the top first, removed access last, else by name.
 */
export function peopleOrg(people: readonly Person[], tree: readonly OrgEntry[]): { people: PersonEntry[]; agents: OrgEntry[] } {
  const top = topPersonId(people);
  const byId = new Map(people.map((person) => [person.id, person]));
  const underPerson = new Map<string, OrgEntry[]>();
  const agents: OrgEntry[] = [];
  for (const entry of tree) {
    const manager = entry.agent.managerId;
    if (manager && manager !== top && byId.has(manager)) push(underPerson, manager, entry);
    else agents.push(entry);
  }
  const children = new Map<string, Person[]>();
  const roots: Person[] = [];
  for (const person of people) {
    const manager = person.managerId && person.managerId !== person.id ? byId.get(person.managerId) : undefined;
    if (manager && !reaches(person.id, manager.id, byId)) push(children, manager.id, person);
    else roots.push(person);
  }
  const order = (a: Person, b: Person) => Number(b.id === top) - Number(a.id === top)
    || Number(a.status === 'revoked') - Number(b.status === 'revoked') || a.name.localeCompare(b.name);
  const build = (person: Person): PersonEntry => ({
    person,
    people: (children.get(person.id) ?? []).sort(order).map(build),
    agents: underPerson.get(person.id) ?? [],
  });
  return { people: roots.sort(order).map(build), agents };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/** True when following managers up from `from` comes back to `self` (a cycle in damaged data). */
function reaches(self: string, from: string, byId: ReadonlyMap<string, Pick<Person, 'id' | 'managerId'>>): boolean {
  const seen = new Set<string>();
  for (let id: string | undefined = from; id && !seen.has(id); id = byId.get(id)?.managerId) {
    if (id === self) return true;
    seen.add(id);
  }
  return false;
}

/** Whom an agent reports to, as the agent page shows it. */
export type ManagerRef = { kind: 'self' } | { kind: 'agent'; id: string } | { kind: 'person'; id: string };

/**
 * An agent's manager from this connection's side. No manager (or an id that is neither an agent
 * nor a human – a removed manager) is the organisation's top: the caller on the owner's PC
 * ("You"), the CEO ('owner') on a person's device. 'human' is always the caller.
 */
export function managerOf(managerId: string | undefined, options: { isAgent: (id: string) => boolean; isPerson?: (id: string) => boolean; personSession: boolean }): ManagerRef {
  const top: ManagerRef = options.personSession ? { kind: 'person', id: OWNER_ALIAS } : { kind: 'self' };
  if (!managerId) return top;
  if (managerId === HUMAN_ID) return { kind: 'self' };
  if (options.isAgent(managerId)) return { kind: 'agent', id: managerId };
  const person = options.isPerson?.(managerId) || isHumanActor(managerId) || managerId === OWNER_ALIAS;
  return person ? { kind: 'person', id: managerId } : top;
}

/**
 * Where a chat message is drawn: 'own' – the caller's words, the right-hand bubble without a name
 * ('human' is the caller on every device); 'person' – another human (a colleague, or the CEO on a
 * person's device), on the left with name and round avatar; 'other' – agents, external contacts, system.
 */
export function messageSide(message: Pick<Message, 'authorKind' | 'authorId'>): 'own' | 'person' | 'other' {
  if (message.authorKind !== 'human') return 'other';
  return message.authorId === HUMAN_ID ? 'own' : 'person';
}
