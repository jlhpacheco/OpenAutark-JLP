// A new agent is at home on all of the person's own PCs (Konrad #830, 24.11.2026: "kein PC hat Vorrang"): Agent.homes names
// this PC, the PC it was given to (deviceId) and every PC linked here as one of the person's own ('ceo' link) – so while the
// PC it runs on is off, the online one with the smallest id goes on with it (devices/sync/home.ts goesOn, takeover.ts).
// The person's own PCs are the 'ceo' links and this PC; an employee's PC (the person's company link) and the PCs of an
// employer this PC joined as an employee never count – the same rule agents.update {homes} checks (isCeoPc).
// Alone on one PC nothing is written: homes stay empty (the old shape) – a PC linked later is not yet in the list of agents
// made before it; that catch-up is the existing agents' (0.3.21, with the ledger).
// Owns: that one default for a NEW agent. Never: touches an agent that exists with homes or one made before (no migration),
// sends or dials anything.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ChangeBy } from '../org/service.ts';
import { links, selfId } from '../devices/sync/home.ts';

/** The most PCs one agent is at home on (org/patch.ts MAX_HOMES leaves room for the PC it runs on). */
const MAX = 20;

/** The ids of the person's own PCs – `first` (the PC an agent runs on, when it is one of them) first, then this PC, then the linked ones in id order. */
export function ownPcIds(db: RuntimeServices['db'], first?: string): string[] {
  const own = links(db).filter(({ link }) => link.kind === 'ceo').map(({ record }) => record.id).sort();
  const self = selfId(db);
  const ids = [...new Set([...(first && (first === self || own.includes(first)) ? [first] : []), self, ...own].filter(Boolean))];
  return ids.slice(0, MAX);
}

/**
 * The new agent `agent` at home on all of the person's own PCs when there is more than one; the agent as it is otherwise
 * (alone on one PC, or it already has homes). The PC it runs on (its deviceId) comes first.
 */
export function homeOnOwnPcs(s: Pick<RuntimeServices, 'db' | 'org' | 'log'>, agent: Agent, by: ChangeBy): Agent {
  if (agent.homes?.length) return agent;
  try {
    const ids = ownPcIds(s.db, agent.deviceId);
    if (ids.length < 2) return agent;
    return s.org.update(agent.id, { homes: ids }, by);
  } catch (error) {
    try { s.log.warn('new agent not set at home on my PCs', { agentId: agent.id, error: String(error) }); } catch { /* the hire itself stands, with or without a line */ }
    return agent;
  }
}
