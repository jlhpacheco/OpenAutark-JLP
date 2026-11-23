// Team-Call 21.11.2026 (owner: "an Jonas jetzt den Momo zuteilen"): what dropping one row of the team tree on another
// changes. One rule: a drop pairs an agent with its new manager – an agent dropped on an agent reports to it, a person
// dropped on an agent makes that agent theirs (the agent reports to the person: their personal manager is the agent
// reporting to them, org/member-welcome.ts), an agent dropped on a person reports to that person. The owner as the new
// manager is the top (managerId cleared). A drop onto itself, one that would close a loop (the new manager reports up to
// the agent) or that changes nothing is no drop. A company colleague shown on an employee's PC (Person.fromEmployer)
// is read-only here.
// Owns: that decision. Never: calls RPC, reads the store or touches the DOM (team-drag.ts does).

import type { Agent } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';

export interface DragItem { kind: 'agent' | 'person'; id: string }

/** The edit a drop makes: `agentId` gets `managerId` as its manager (null = the top, i.e. the owner). */
export interface DropChange { agentId: string; managerId: string | null }

type OrgAgent = Pick<Agent, 'id' | 'managerId' | 'archivedAt'>;
type OrgPerson = Pick<Person, 'id' | 'managerId' | 'owner' | 'fromEmployer'>;

/** True when `from` reports (directly or further up, across people and agents) to `id`; loops in damaged data end. */
function reportsUpTo(from: string, id: string, managerOf: (node: string) => string | undefined): boolean {
  const seen = new Set<string>();
  for (let node: string | undefined = from; node && !seen.has(node); node = managerOf(node)) {
    if (node === id) return true;
    seen.add(node);
  }
  return false;
}

export function dropChange(dragged: DragItem, target: DragItem, agents: readonly OrgAgent[], people: readonly OrgPerson[]): DropChange | null {
  if (dragged.id === target.id) return null;
  const agentById = new Map(agents.filter((agent) => agent.archivedAt === undefined).map((agent) => [agent.id, agent]));
  const personById = new Map(people.map((person) => [person.id, person]));
  let agent: OrgAgent | undefined;
  let manager: DragItem;
  if (dragged.kind === 'agent') { agent = agentById.get(dragged.id); manager = target; }
  else if (target.kind === 'agent') { agent = agentById.get(target.id); manager = dragged; }
  else return null; // a person onto a person is no drop here
  if (!agent) return null;
  let managerId: string | null;
  if (manager.kind === 'agent') {
    if (!agentById.has(manager.id)) return null;
    managerId = manager.id;
  } else {
    const person = personById.get(manager.id);
    if (!person || person.fromEmployer) return null;
    managerId = person.owner ? null : person.id;
  }
  if ((agent.managerId ?? null) === managerId) return null;
  const managerOf = (node: string) => agentById.get(node)?.managerId ?? personById.get(node)?.managerId;
  if (managerId && reportsUpTo(managerId, agent.id, managerOf)) return null;
  return { agentId: agent.id, managerId };
}
