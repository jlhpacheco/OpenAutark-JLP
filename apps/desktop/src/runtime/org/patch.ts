// An edit of an agent (OrgService.update): the patch's
// fields validated and applied to a copy. Generated initials follow a rename; their color (picked
// or given at hire) and custom avatars stay – the same rule as org/restore.ts. An absent or null
// optional field clears it.
// Owns: field-level checks of an edit and the org checks it needs from its caller (unique name,
// existing space, an active manager that is not the agent itself or one of its reports).
// Never: saves or emits events (org/service.ts), or decides who may edit.

import { WorkforceError } from '../../shared/errors.ts';
import { MAX_SYSTEM_MD } from '../../shared/model/agent-core.ts';
import type { Agent, AgentStatus } from '../../shared/model/org.ts';
import { defaultAvatar } from './avatar.ts';
import { checkAvatar } from './avatar-files.ts';
import { cleanAvatar, cleanMode, cleanName, cleanObject, cleanSkills, cleanText, cleanVoice } from './validate.ts';

/** More PCs than a person links: agents.update takes 20 names and adds the PC the agent runs on. */
const MAX_HOMES = 32;
export const STATUSES: readonly AgentStatus[] = ['idle', 'working', 'waiting', 'paused', 'error'];

/** What an edit needs to know about the rest of the org. */
export interface PatchRules {
  nameTaken(name: string): boolean;
  spaceExists(id: string): boolean;
  /** Throws unless `managerId` may manage this agent (active, no cycle). */
  checkManager(managerId: string): void;
}

/** The PC ids of an edit's `homes`: each once, in their order; undefined when there is none. */
function cleanHomes(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new WorkforceError('bad_request', 'homes is a list of PCs.');
  if (value.length > MAX_HOMES) throw new WorkforceError('bad_request', `homes takes at most ${MAX_HOMES} PCs.`);
  const ids = [...new Set(value.map((id) => cleanText(id, 'home PC', 80)).filter(Boolean))];
  return ids.length ? ids : undefined;
}

/** `agent` with `patch` applied after validation; `updatedAt` stays for the caller to set. */
export function patchedAgent(agent: Agent, patch: Partial<Agent>, rules: PatchRules): Agent {
  const next: Agent = { ...agent };
  const has = (key: keyof Agent) => Object.hasOwn(patch, key);
  const cleared = (key: keyof Agent) => has(key) && (patch[key] === undefined || patch[key] === null);

  if (has('name')) {
    next.name = cleanName(patch.name);
    if (next.name.toLocaleLowerCase() !== agent.name.toLocaleLowerCase() && rules.nameTaken(next.name)) {
      throw new WorkforceError('conflict', 'Choose a different agent name.');
    }
    if (agent.avatar.kind === 'initials' && !has('avatar')) {
      const letters = defaultAvatar(agent.id, next.name);
      next.avatar = agent.avatar.color === undefined ? letters : { ...letters, color: agent.avatar.color };
    }
  }
  if (has('role')) next.role = cleanText(patch.role ?? '', 'role', 80).trim();
  if (has('avatar')) next.avatar = checkAvatar(cleanAvatar(patch.avatar));
  if (has('instructions')) next.instructions = cleanText(patch.instructions ?? '', 'instructions', MAX_SYSTEM_MD);
  if (has('mode')) next.mode = cleanMode(patch.mode);
  if (has('skills')) next.skills = cleanSkills(patch.skills ?? []);
  if (has('modelPolicy')) next.modelPolicy = cleanObject(patch.modelPolicy ?? {}, 'model policy');
  if (has('team')) next.team = cleared('team') ? undefined : cleanText(patch.team, 'team', 80).trim() || undefined;
  if (has('deviceId')) next.deviceId = cleared('deviceId') ? undefined : cleanText(patch.deviceId, 'device', 80);
  if (has('homes')) next.homes = cleanHomes(patch.homes); // Umzug 21.11.2026: the PCs it is at home on; none = it waits for its PC
  if (has('voice')) next.voice = cleared('voice') || patch.voice === '' ? undefined : cleanVoice(patch.voice);
  if (has('statusNote')) next.statusNote = cleared('statusNote') ? undefined : cleanText(patch.statusNote, 'status', 200);
  if (has('status')) {
    if (!STATUSES.includes(patch.status as AgentStatus)) throw new WorkforceError('bad_request', 'Invalid agent status.');
    next.status = patch.status as AgentStatus;
  }
  if (has('spaceId')) {
    next.spaceId = cleared('spaceId') ? undefined : patch.spaceId;
    if (next.spaceId && !rules.spaceExists(next.spaceId)) throw new WorkforceError('not_found', 'This space no longer exists.');
  }
  if (has('managerId')) {
    next.managerId = cleared('managerId') ? undefined : patch.managerId;
    if (next.managerId) rules.checkManager(next.managerId);
  }
  return next;
}
