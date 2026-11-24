// Org-building tools, open to every agent: agents.templates (what can be hired), agents.create (one hire or a team of
// up to six, results per hire) and agents.archive (any agent, itself included; with `successorId` the successor takes
// over the role, place, reports and open tasks – org/service.ts). So a manager can hire a successor, hand over and
// archive itself; at least one agent stays.
// Where a hire lands is placement(); OrgService decides the chain of command (a template that
// reports to the human – the secretary – stays outside every branch).
// The summary names every hire with its role, a changed mode and "own instructions"; B-059: a hire without a name
// reads "a new <template> (…, gets a first name)" – the name is picked only when the hire runs.
// B-047 (D9): without a name OrgService picks a free human first name; the job goes in role. Feedback 1b136d01 (owner
// 19.11.2026: "nenn die nicht nur nach menschlichen Namen … oder einfach nur Firmenberater, Verkaufsagent"): a name given
// is the name – a first name is the default, never a rule, so "Firmenberater" or "Mara · Firmenberaterin" stand as given. Every hire starts from the team's standard
// SYSTEM.md of its kind (org/hire.ts, org/standard.ts) and makes it its own in its first turn (skill system-prompt).
// B-078 (D15): the creator's `instructions` are the new agent's "who you are"; the result returns the SYSTEM.md path and
// its own part (from "## My role" on) with one line: how I start them and help them write the file. A hire from the `head` template stands beside me – it reports to
// the person unless managerId names someone.
// `device` gives a hire its home PC (devices.list; default this PC) – like agents.update's device.
// 0.3.20 (Konrad #830, 24.11.2026): a hire is at home on all of the person's own PCs (Agent.homes, agents/own-homes.ts) – the one
// it runs on first –, so another of them goes on with it while that one is off; agents that exist keep their homes (0.3.21).
// 17.11.2026 (measured 15.–17.11.: no hire could name a model, every new agent landed on the strongest one and its giver's
// "strong" on the first task then raised its effort to max): `model` and `effort` settle a hire where its context starts –
// the model as its start model with my name on it (ModelPolicy.pin / pinBy, like agents.update), described by the work the
// colleague will do; without one Auto settles it by its kind (routing/kind.ts). The result's `runsOn` says which model and
// effort the colleague starts on and why, so the choice is seen.
// Owns: those three tools. Never: hires a second secretary (the existing one is returned) or archives the last
// active agent.

import path from 'node:path';
import type { ToolContext, ToolDef } from '../types.ts';
import { EFFORT_PROPERTY, MODEL_PROPERTY, failure, json } from '../types.ts';
import type { Effort } from '../../../shared/model/providers.ts';
import { pinFor } from './agent-pin.ts';
import { areaKind } from '../../org/spaces.ts';
import { SYSTEM_FILE } from '../../../shared/model/agent-core.ts';
import type { Agent } from '../../../shared/model/org.ts';
import type { ModeInfo } from '../../../shared/model/knowledge.ts';
import '../../contracts/agent-core.ts';
import { resolveDevice } from '../registry.ts';
import { coreInstructions } from '../../agent-core/prompt.ts';
import { ownHowIWork } from '../../org/system-parts.ts';
import { homeOnOwnPcs } from '../../agents/own-homes.ts';
import { clip, defineTool } from './util.ts';

export const MAX_HIRES = 6;

type Hire = { name?: string; template?: string; role?: string; instructions?: string; mode?: string; managerId?: string; spaceId?: string; device?: string; model?: string; effort?: Effort };
type CreateArgs = Hire & { agents?: Hire[] };
type SystemFile = { path?: string; text: string; next?: string };
type HireResult = { ok: true; agentId: string; name: string; role: string; spaceId?: string; space?: string; worksOn?: string; runsOn?: string; existing?: true; note?: string; system?: SystemFile } | { ok: false; hire: string; error: string };

/** The SYSTEM.md text a hire result shows at most (a team call returns up to six). */
const SYSTEM_TEXT_MAX = 6000;
/** B-078: templates whose hires stand beside me and report to the person (a department head). */
const BESIDE: ReadonlySet<string> = new Set(['head']);

/** B-078: the line a hire result carries – the SYSTEM.md is the new agent's own, and how I start them. */
export function startLine(name: string): string {
  return `${name} starts from the team's standard SYSTEM.md with the "who you are" I gave under "## My role" (above: that part) and makes the file their own in their first turn (skill system-prompt). I start ${name} now with the brief for it: a first line in our 1:1 (chat.direct) with who they are for the person and what I found – the colleagues, folders and accounts of the work, an earlier piece that shows what good looks like – or a first real to-do (tasks.add for ${name}). Then I read what they wrote and say what I would sharpen.`;
}

const HIRE_PROPS = {
  name: { type: 'string', maxLength: 60, description: 'The name the hire goes by, as the person wants it: a first name ("Mara"), a role ("Firmenberater") or both. Without it the hire gets a free first name.' },
  template: { type: 'string' }, role: { type: 'string', maxLength: 120, description: 'The job.' },
  instructions: { type: 'string', maxLength: 8000, description: 'Who the colleague is and for whom they work, a few lines under "## My role"; from there they grow it. Their first piece of work is a to-do of its own (tasks.add).' },
  mode: { type: 'string' }, managerId: { type: 'string', description: "'' = the person." },
  spaceId: { type: 'string', description: "Default the template's or its manager's space; a private one only from inside it." },
  device: { type: 'string', minLength: 1, maxLength: 120, description: "Its home PC, where its turns, terminal and screen work run; default this one. Whichever it is, the hire is at home on all of the person's own PCs, so another goes on with it while its PC is off." },
  model: MODEL_PROPERTY, effort: EFFORT_PROPERTY,
} as const;
/** The same fields inside "agents", said once at the top level. */
const HIRE_ITEM = Object.fromEntries(Object.entries(HIRE_PROPS).map(([key, prop]) => { const { description: _said, ...rest } = prop as { description?: string }; return [key, rest]; }));

/**
 * Where a hire lands: an explicit active space; else the template's area – the new manager's
 * space when it is of that kind (a second company keeps its own hires), otherwise the first
 * active space of that kind (created on demand; OrgService.create applies the same area rule);
 * without an area, the new manager's space (only this tool – a human hire without a space and
 * template stays space-less).
 */
function placement(args: Hire, ctx: ToolContext): { spaceId?: string; label?: string; error?: string } {
  const org = ctx.services.org;
  const spaces = org.spaces();
  const boss = org.get(args.managerId ?? ctx.agent.id);
  const home = spaces.find((space) => space.id === boss?.spaceId);
  const kind = areaKind(args.template ? org.templates().find((template) => template.key === args.template) : undefined);
  if (args.spaceId) {
    const space = spaces.find((entry) => entry.id === args.spaceId);
    if (!space) return { error: 'This space does not exist or is archived (spaces.list shows the active ones).' };
    return { spaceId: space.id, label: space.name };
  }
  if (!kind) return home ? { spaceId: home.id, label: home.name } : {};
  if (home?.kind === kind) return { spaceId: home.id, label: home.name };
  const area = spaces.find((space) => space.kind === kind);
  return { label: area?.name ?? (kind === 'custom' ? undefined : `a new ${kind} space`) };
}

/** The hires of a call: the `agents` list, else the single hire in the top-level fields. */
function hiresOf(args: CreateArgs): Hire[] {
  if (args.agents?.length) return args.agents;
  const { agents: _list, ...single } = args;
  return [single];
}

/**
 * "Vic (Video editor, mode video, own instructions) into Company" – what the call's summary shows of one
 * hire. The person's own assistant keeps her template's role, mode and instructions (OrgService).
 * B-059: without a name the hire gets a free first name only when it runs (org/hire.ts, seeded by the new id) –
 * "a new Researcher (gets a first name)", so the person never matches the card to a template name.
 */
function hireLabel(hire: Hire, ctx: ToolContext): string {
  const template = hire.template ? ctx.services.org.templates().find((entry) => entry.key === hire.template) : undefined;
  const own = template?.reportsTo === 'human' ? undefined : hire;
  const kind = template?.name ?? 'agent';
  const who = hire.name ?? `a new ${kind}`;
  const role = own?.role ?? template?.role;
  const extras = [
    role && role !== (hire.name ?? kind) ? role : '',
    hire.name === undefined ? 'gets a first name' : '',
    own?.mode && own.mode !== template?.mode ? `mode ${own.mode}` : '',
    own?.instructions?.trim() ? 'own instructions' : '',
  ].filter(Boolean);
  const into = placement(hire, ctx).label;
  return `${who}${extras.length ? ` (${extras.join(', ')})` : ''}${into ? ` into ${into}` : ''}`;
}

/** B-047: the new agent's SYSTEM.md (path when the agent core is wired) and how I start them (B-078). */
function systemFile(agent: Agent, ctx: ToolContext): SystemFile {
  let folder: string | undefined;
  try { folder = ctx.services.agentCore?.folder(agent.id); } catch { folder = undefined; }
  const own = ownHowIWork(coreInstructions(ctx.services, agent)).rest; // the standard's "# How I work" above and the comment below are the same for every hire
  const text = own.length > SYSTEM_TEXT_MAX ? `${own.slice(0, SYSTEM_TEXT_MAX - 1)}…` : own;
  return { ...(folder ? { path: path.join(folder, SYSTEM_FILE) } : {}), text, next: startLine(agent.name) };
}

/**
 * "Claude Sonnet 5.5 · medium – executing runs on the strong tier's best value": the model and effort the new colleague's
 * first turn runs on (one route preview) and why – the model I named, else what Auto settles for its kind; undefined when no
 * route can be read now.
 */
async function startsOn(ctx: ToolContext, agent: Agent): Promise<string | undefined> {
  try {
    let mode: ModeInfo;
    try { mode = ctx.services.modes.get(agent.mode); } catch { mode = ctx.services.modes.get('general'); }
    const route = await ctx.services.router.route({ agent, mode });
    const name = ctx.services.catalog.get(route.modelId)?.name ?? route.modelId;
    return `${name} · ${route.effort} – ${route.modelId === agent.modelPolicy.pin ? 'the model I named' : route.reason.split(' · ')[0]}`;
  } catch {
    return undefined;
  }
}

/** One hire; a refused one is a result, not an error, so the others still happen. */
async function hire(args: Hire, ctx: ToolContext): Promise<HireResult> {
  const org = ctx.services.org;
  const label = args.name ?? args.template ?? args.role ?? 'agent';
  const template = args.template ? org.templates().find((entry) => entry.key === args.template) : undefined;
  if (template?.reportsTo === 'human') {
    // Agents never hire a second secretary: the one there is works for the person.
    const existing = org.list().find((agent) => agent.template === template.key);
    if (existing) {
      return { ok: true, agentId: existing.id, name: existing.name, role: existing.role, spaceId: existing.spaceId, existing: true, note: `${existing.name} already works for the person; I talk to them instead of hiring another.` };
    }
  }
  const managerId = args.managerId ?? (template && BESIDE.has(template.key) ? '' : ctx.agent.id); // '' = reports to the person
  const place = placement(args, ctx);
  if (place.error) return { ok: false, hire: label, error: place.error };
  const { device, model, effort, ...fields } = args;
  const pc = device === undefined ? undefined : resolveDevice(ctx.services, device);
  if (pc && 'error' in pc) return { ok: false, hire: label, error: pc.error };
  const pin = model === undefined ? undefined : await pinFor(ctx, model);
  if (pin && 'error' in pin) return { ok: false, hire: label, error: pin.error };
  try {
    let agent = org.create({ ...fields, managerId, spaceId: place.spaceId, createdBy: ctx.agent.id });
    if (pc && !pc.self) agent = org.update(agent.id, { deviceId: pc.id }, { by: ctx.agent.id, runId: ctx.runId, reason: 'home device' }); // this PC is the default (no deviceId)
    agent = homeOnOwnPcs(ctx.services, agent, { by: ctx.agent.id, runId: ctx.runId, reason: "at home on the person's own PCs" }); // 0.3.20 (Konrad #830): all of them, whichever PC it starts on; existing agents stay
    if (pin?.pin || effort) {
      // the model is its start model with my name on it, the effort its fixed one – what agents.update sets for a colleague
      const named = pin?.pin ? { pin: pin.pin, pinBy: { name: ctx.agent.name, at: ctx.services.clock.now() } } : {};
      agent = org.update(agent.id, { modelPolicy: { ...agent.modelPolicy, ...named, ...(effort ? { effort } : {}) } }, { by: ctx.agent.id, runId: ctx.runId, reason: 'model and effort for its work' });
    }
    const space = agent.spaceId ? org.spaces().find((entry) => entry.id === agent.spaceId)?.name : undefined;
    const ignored = template?.reportsTo === 'human' && (args.role || args.mode || args.instructions);
    const notes = [ignored ? `${agent.name} works for the person, so role, mode and instructions come from the template. I say anything else in a chat.` : '', pin?.note ?? ''].filter(Boolean).join(' ');
    const runsOn = await startsOn(ctx, agent);
    const system = systemFile(agent, ctx);
    return { ok: true, agentId: agent.id, name: agent.name, role: agent.role, spaceId: agent.spaceId, space, ...(pc ? { worksOn: pc.name } : {}), ...(runsOn ? { runsOn } : {}), ...(notes ? { note: notes } : {}), system };
  } catch (error) {
    return { ok: false, hire: label, error: error instanceof Error ? error.message : String(error) };
  }
}

const listTemplates = defineTool<Record<string, never>>({
  name: 'agents.templates',
  description: 'Lists the agent templates I can hire from, and who a hire reports to.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  category: 'read',
  describe: () => ({ summary: 'List agent templates', reversible: true, external: false }),
  async run(_args, ctx) {
    return json(ctx.services.org.templates().map((template) => ({
      key: template.key, name: template.name, role: template.role, description: template.description, mode: template.mode,
      area: template.spaceKind, reportsTo: template.reportsTo,
    })));
  },
});

const createAgent = defineTool<CreateArgs>({
  name: 'agents.create',
  description: 'Hires one agent or a whole team, from a template or a role. Each reports to me unless managerId says otherwise; a head from template "head" stands beside me and reports to the person. A new colleague\'s context starts here, so this is where I name the model and effort its work asks for; without a model its kind settles one: an agent that leads runs on the frontier tier, one that executes on the strong tier, as the person\'s Model choice shifts them.',
  inputSchema: {
    type: 'object',
    properties: {
      ...HIRE_PROPS,
      agents: { type: 'array', items: { type: 'object', properties: HIRE_ITEM, additionalProperties: false }, minItems: 1, maxItems: MAX_HIRES, description: 'Several hires, each with these fields.' },
    },
    additionalProperties: false,
  },
  category: 'agents',
  describe: (args, ctx) => {
    const hires = hiresOf(args);
    const labels = hires.map((item) => hireLabel(item, ctx));
    const summary = hires.length === 1 ? `Hire ${hires[0].name === undefined ? '' : 'agent '}${labels[0]}` : `Hire ${hires.length} agents: ${labels.join(', ')}`;
    return { summary: clip(summary, 1500), reversible: true, external: false };
  },
  async run(args, ctx) {
    const { agents: list, ...single } = args;
    if (list?.length && Object.values(single).some((value) => value !== undefined)) {
      return failure('Give either one hire in the top-level fields or a team in "agents", not both.');
    }
    const results: HireResult[] = [];
    for (const item of hiresOf(args)) results.push(await hire(item, ctx)); // one after another: each sees the names taken before it
    if (!list?.length) {
      const [only] = results;
      return only.ok ? json({ ...only }) : failure(only.error);
    }
    return json({ ok: results.every((result) => result.ok), results });
  },
});

const archiveAgent = defineTool<{ agentId?: string; successorId?: string; reason: string }>({
  name: 'agents.archive',
  description: 'Archives an agent or myself. The successor takes over role, reports and open tasks; without one they move up to the manager.',
  inputSchema: {
    type: 'object',
    properties: { agentId: { type: 'string' }, successorId: { type: 'string' }, reason: { type: 'string', minLength: 3, maxLength: 300 } },
    required: ['reason'], additionalProperties: false,
  },
  category: 'agents',
  describe: (args, ctx) => {
    const id = args.agentId ?? ctx.agent.id;
    const name = ctx.services.org.get(id)?.name ?? id;
    const successor = args.successorId ? ` (successor ${ctx.services.org.get(args.successorId)?.name ?? args.successorId})` : '';
    return { summary: `Archive agent ${name}${successor}: ${clip(args.reason, 160)}`, resource: id, reversible: true, external: false };
  },
  async run(args, ctx) {
    const org = ctx.services.org;
    const targetId = args.agentId ?? ctx.agent.id;
    const target = org.get(targetId);
    if (!target || target.archivedAt) return failure('Agent not found.');
    const active = org.list();
    if (active.length <= 1) return failure('The last agent stays.');
    const successor = args.successorId ? org.get(args.successorId) : undefined;
    if (args.successorId && (!successor || successor.archivedAt)) return failure('Successor not found.');
    const reports = active.filter((agent) => agent.managerId === targetId && agent.id !== successor?.id).map((agent) => agent.name);
    org.archive(targetId, { by: ctx.agent.id, runId: ctx.runId, reason: args.reason, ...(successor ? { successorId: successor.id } : {}) });
    return json({ ok: true, agentId: targetId, ...(successor ? { successor: successor.name, reportsMovedTo: successor.name } : {}), reportsMoved: reports, reason: args.reason });
  },
});

export const agentOrgTools: ToolDef[] = [listTemplates, createAgent, archiveAgent];
