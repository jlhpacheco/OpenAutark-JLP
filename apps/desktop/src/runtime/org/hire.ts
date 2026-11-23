// Hiring (OrgService.create): the new agent, checked against the org before anything is saved. Any agent may hire:
// the new agent reports to the creator unless another manager is named. A human – the owner or (F13) a CEO person –
// hires as the person does. A template that reports to the human (the
// secretary) is a step apart from the company: hired by an agent she still works for the person (role, mode and
// instructions come from the template only). Placed in the template's area (areaKind/forKind in
// org/spaces.ts), a same-kind manager's first.
// Every new agent starts from the standard SYSTEM.md of its kind (org/standard.ts: resources/prompts/standard-manager.md
// for a hire from a leading template – manager, head –, else standard-agent.md, or the person's own version in <data>/prompts) – "# How I work", then
// "## My role" with the template's or creator's text right below its lines, then "## What I have here" – and makes it its
// own in its first turn (the standard's role part says so; skill system-prompt). The creator's instructions are the new
// agent's "who you are"; for a template hire by an agent they stand below the template's body (withTemplateBody). A text that begins with "## My role" is the whole own part; one that begins with "# How I work" is
// a whole SYSTEM.md. A hire without a name gets a free human first name (org/first-names.ts); a taken name gets a number;
// the template's role stays its role. How far the team goes on this PC is no line of SYSTEM.md: the security mode stands
// in the stable prompt (owner 19.11.2026, security/agreements.ts). A hire starts without a fixed effort (modelPolicy {}).
// Owns: these hiring rules and the new agent's fields. Never: saves it or emits events
// (org/service.ts), or reads the database itself – the org facts come from the caller.

import { WorkforceError } from '../../shared/errors.ts';
import { MAX_SYSTEM_MD } from '../../shared/model/agent-core.ts';
import { newId } from '../../shared/ids.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import type { Agent, AgentTemplate, Space } from '../../shared/model/org.ts';
import type { Settings } from '../../shared/model/system.ts';
import type { OrgService } from '../contracts.ts';
import { defaultAvatar } from './avatar.ts';
import { freeFirstName } from './first-names.ts';
import { areaKind } from './spaces.ts';
import { HAVE_HEADING, hasHavePart, isRoleHeading, ownHowIWork, WORK_HEADING } from './system-parts.ts';
import { cleanMode, cleanName, cleanSkills, cleanText } from './validate.ts';
import { LEAD_TEMPLATES, standardKind, type StandardKind } from './standard.ts';

export type CreateInput = Parameters<OrgService['create']>[0];

/** The org facts a hire is checked against. */
export interface HireFacts {
  template(key: string): AgentTemplate | undefined;
  /** Throws when the org is full. */
  checkRoom(): void;
  requireActive(id: string): Agent;
  nameTaken(name: string): boolean;
  uniqueName(base: string): string;
  space(id: string): Space | undefined;
  /** The active space of an area kind (created on demand), near the manager's space. */
  spaceForKind(kind: Space['kind'], near?: string): Space | undefined;
  now(): number;
  /** The standard SYSTEM.md of `kind` rendered for the new agent (`values`: its role); absent or '' = none. */
  systemMd?(values: Readonly<Record<string, string>>, kind: StandardKind): string | undefined;
}

/** The longest instructions a hire takes (cleanText's limit below). */
const MAX_INSTRUCTIONS = MAX_SYSTEM_MD; // one cap for SYSTEM.md (shared/model/agent-core.ts)

/** The system-md prompt's values from the settings: the person's name (or "the person"). */
export function systemMdValues(settings: Pick<Settings, 'profile'>): Record<string, string> {
  const owner = settings.profile.name.trim() || 'the person';
  return { owner, user_name: owner };
}

/** `text` split at "## What I have here": what stands above it and that part itself ('' without one). */
export function splitAtHave(text: string): { head: string; tail: string } {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === HAVE_HEADING);
  if (at < 0) return { head: text.trim(), tail: '' };
  return { head: lines.slice(0, at).join('\n').trim(), tail: lines.slice(at).join('\n').trim() };
}

const firstLine = (text: string): string => text.trim().split('\n', 1)[0]?.trim() ?? '';

/**
 * The new agent's SYSTEM.md: `body` right under the template's role line, the template's "What I have here" below it
 * (unless `body` has its own). A body that begins with "## My role" replaces the template's role heading and line; one
 * that begins with "# How I work" is taken whole. When both would not fit, the body alone.
 */
export function withSystemMd(body: string, template: string | undefined): string {
  const standard = template?.trim();
  const own = body.trim();
  if (!standard || firstLine(own) === WORK_HEADING) return body;
  const { head, tail } = splitAtHave(standard);
  const above = isRoleHeading(firstLine(own)) ? ownHowIWork(head).how : head; // an own role part keeps the standard's "# How I work"
  const text = [above, own, own && hasHavePart(own) ? '' : tail].filter(Boolean).join('\n\n');
  return text.length <= MAX_INSTRUCTIONS ? text : body;
}

/**
 * An agent's "who you are" for a template hire joins the template's body, as patterns/library.ts does – a head keeps
 * head.md. The body goes first; an own part that starts with the role heading keeps it on top and gets the body before
 * its "## What I have here". A whole SYSTEM.md or a text that already holds the body is taken as it is.
 */
export function withTemplateBody(own: string, base: string | undefined): string {
  const body = base?.trim() ?? '';
  const text = own.trim();
  if (!body || !text || firstLine(text) === WORK_HEADING || text.includes(body)) return own;
  if (!isRoleHeading(firstLine(text))) return `${body}\n\n${text}`;
  const { head, tail } = splitAtHave(text);
  return [head, body, tail].filter(Boolean).join('\n\n');
}

/** The agent `input` hires, validated; throws a user-safe WorkforceError. */
export function hiredAgent(input: CreateInput, org: HireFacts): Agent {
  const template = input.template ? org.template(input.template) : undefined;
  if (input.template && !template) throw new WorkforceError('not_found', 'This agent template does not exist.', { details: { template: input.template } });
  org.checkRoom();
  const creator = input.createdBy;
  const human = isHumanActor(creator); // the owner or (F13) a CEO person hires as the person does; anyone else is an agent
  if (!human) org.requireActive(creator);

  const toHuman = template?.reportsTo === 'human';
  const managerId = toHuman ? undefined : input.managerId ?? (human ? undefined : creator);
  const boss = managerId ? org.requireActive(managerId) : undefined;
  const given: Pick<CreateInput, 'role' | 'instructions' | 'mode'> = toHuman && !human ? {} : input;

  const now = org.now();
  const id = newId('ag', now);
  // B-047 (D9): no name given – a free human first name (the template's role stays the role); all taken – the old "Writer 2".
  let name = cleanName(input.name ?? freeFirstName(id, (candidate) => org.nameTaken(candidate)) ?? template?.name ?? 'Agent');
  if (org.nameTaken(name)) name = org.uniqueName(name);
  const target = input.spaceId ? org.space(input.spaceId) : undefined;
  if (input.spaceId && !target) throw new WorkforceError('not_found', 'This space no longer exists.');
  if (target?.archivedAt) throw new WorkforceError('conflict', 'This space is archived.');
  const role = cleanText(given.role ?? template?.role ?? '', 'role', 80).trim();
  const own = given.instructions === undefined ? undefined : cleanText(given.instructions, 'instructions', MAX_INSTRUCTIONS);
  const joined = !human && own !== undefined ? withTemplateBody(own, template?.instructions) : undefined;
  const body = joined !== undefined && joined.length <= MAX_INSTRUCTIONS ? joined : cleanText(own ?? template?.instructions ?? '', 'instructions', MAX_INSTRUCTIONS);
  const agent: Agent = {
    id,
    name,
    role,
    avatar: defaultAvatar(id, name),
    spaceId: input.spaceId,
    managerId,
    instructions: '',
    mode: cleanMode(given.mode ?? template?.mode ?? 'general'),
    skills: template ? cleanSkills(template.skills) : [],
    modelPolicy: {},
    status: 'idle',
    template: template?.key,
    createdBy: creator,
    createdAt: now,
    updatedAt: now,
  };
  agent.instructions = withSystemMd(body, org.systemMd?.({ role }, standardKind(template !== undefined && LEAD_TEMPLATES.has(template.key))));
  // After validation (no space left behind by a refused hire): the area, a same-kind manager's first.
  const area = areaKind(template);
  if (!agent.spaceId && area) agent.spaceId = org.spaceForKind(area, boss?.spaceId)?.id;
  if (!agent.spaceId) delete agent.spaceId;
  if (!agent.managerId) delete agent.managerId;
  if (!agent.template) delete agent.template;
  return agent;
}
