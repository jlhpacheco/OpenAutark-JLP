// Mode strategy: the mode is the agent's own (13.11.2026) – no chat or task mode. When a part of my work is another kind of
// work, a colleague who works in that mode can take it (tasks.add, or tasks.update with for); when the rest of my work is, I switch
// my own mode (agents.update). checkModeSwitch names those colleagues when I switch.
// Owns: that check and the specialist lookup. Never: switches a mode or gives work itself, or forbids anything (a
// colleague hint is only advice).

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';

const SPECIALISTS = 3;

export interface Specialist { id: string; name: string }

/** Active agents (not archived, not paused) whose own mode is `key`, except `exceptId`; at most three. None for 'general' (no specialist mode). */
export function specialistsFor(services: Pick<RuntimeServices, 'org'>, key: string, exceptId?: string): Specialist[] {
  if (key === 'general') return [];
  let agents: Agent[];
  try { agents = services.org.list(); } catch { return []; }
  return agents
    .filter((agent) => agent.mode === key && agent.id !== exceptId && !agent.archivedAt && agent.status !== 'paused')
    .slice(0, SPECIALISTS)
    .map((agent) => ({ id: agent.id, name: agent.name }));
}

export interface SwitchCheck {
  /** A colleague works in the target mode: giving a separate part to them may fit better. */
  advice?: string;
}

/** When I switch my own mode to `to`: the colleagues who work in it (advice only). */
export function checkModeSwitch(services: Pick<RuntimeServices, 'org'>, input: { agentId: string; mode: string; to: string }): SwitchCheck {
  if (input.to === input.mode) return {};
  const colleagues = specialistsFor(services, input.to, input.agentId);
  if (!colleagues.length) return {};
  const names = colleagues.map((colleague) => `${colleague.name} (${colleague.id})`).join(', ');
  return { advice: `${names} ${colleagues.length === 1 ? 'works' : 'work'} in ${input.to} mode. A part that stands on its own I can give them (tasks.add, or tasks.update with for): their knowledge stays with it and I go on meanwhile.` };
}
