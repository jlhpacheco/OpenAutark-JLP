// Org tools: who is in the company and editing agents (hiring, templates and archiving: agents-org.ts; giving work to a
// colleague is tasks.add / tasks.update for).
// Owns: agents.list (each agent with its avatar kind and palette colour, B-044),
// agents.update (including the PC an agent works on, `device`, B-044 its home project – `home`, agent-home.ts –, who a report reports to, its space,
// its avatar colour, emoji or – B-044 – a portrait its own run made (rules: agent-avatar.ts), its speaking voice – MM3 – and a start model (`model`) checked against the
// catalog: exact id, bare provider model id or name, stored as the catalog id, a model several
// providers list as its available plan/local copy before an API key – RT4, resolved in agent-pin.ts; B-080: effort 'auto'
// drops a fixed effort, so each turn's work sets it again; B-083: a changed pin names the calling agent as who set it –
// ModelPolicy.pinBy, `self` on its own –, an unchanged one keeps its origin, a cleared one has none); my own mode
// changed here names the colleagues who work in that mode (modes/strategy.ts checkModeSwitch).
// Any agent updates any agent, itself included – hand-overs (managerId) too; OrgService refuses cycles.
// Umzug 21.11.2026: `device` on another of the person's PCs moves the agent there with its record – refused while that PC
// is out of reach, the result says what happens (agents/move.ts does it) – and `homes` names the PCs it is at home on
// (names or ids of the person's own PCs, stored as ids with the PC it runs on; [] = none): only among them does it go on
// by itself while its PC is off, and only from its complete record (devices/sync/home.ts goesOn).
// B-078 (D15): SYSTEM.md is each agent's own – `instructions` are the calling agent's whole SYSTEM.md; for another
// agent they are left out and the result says that I tell them in a chat (every other field stays open; the person
// edits everything in the app).
// Never: changes a photo the person chose or sets an image its own run did not make, points
// an agent at a revoked, unknown or non-PC device (resolveDevice decides, like for tool calls), or
// pin a model the catalog does not know or a specialist that cannot run an agent.

import type { ToolContext, ToolDef } from '../types.ts';
import { MAX_SYSTEM_MD } from '../../../shared/model/agent-core.ts';
import { failure, json } from '../types.ts';
import { resolveDevice } from '../registry.ts';
import type { Agent } from '../../../shared/model/org.ts';
import type { Effort } from '../../../shared/model/providers.ts';
import { paletteIndex } from '../../org/avatar.ts';
import { homeElsewhere, isCeoPc, liveHomes, selfId } from '../../devices/sync/home.ts'; // Umzug 21.11.2026: where its turns run, the person's own PCs
import { moveRefused, movingMyself } from '../../agents/move.ts';

/** Review L3: what agents.update says when a part of my work tries to change my own PC. */
export const OWN_MOVE_IN_PART = 'I change my own PC from my main turn, not from a part of my work – this part goes on where it is.';

/** B-078: what agents.update says when I send another agent's instructions. */
export function notMineLine(name: string): string {
  return `SYSTEM.md is ${name}'s own – they write it themselves. I tell ${name} in a chat what I would change there (chat.direct, or the group we work in), and they take in what fits.`;
}
import { avatarPatch, portraitLine, type AvatarArgs } from './agent-avatar.ts';
import { HOME_ARG, applyHome, homeAction } from './agent-home.ts';
import { pinFor } from './agent-pin.ts';
import { clip, defineTool, internal } from './util.ts';
import { checkModeSwitch } from '../../modes/strategy.ts';

const listAgents = defineTool<{ team?: string; includeArchived?: boolean }>({
  name: 'agents.list',
  description: 'Lists my colleagues with id, name, role, team, manager, space, PC and status. What one of them or I really did lately is in agents.log.',
  inputSchema: { type: 'object', properties: { team: { type: 'string' }, includeArchived: { type: 'boolean' } }, additionalProperties: false },
  category: 'read',
  describe: () => internal('List agents'),
  async run(args, ctx) {
    const agents = ctx.services.org.list({ includeArchived: args.includeArchived }).filter((agent) => !args.team || agent.team === args.team);
    const spaceNames = new Map(ctx.services.org.spaces().map((space) => [space.id, space.name]));
    const severalPcs = otherPcs(ctx); // 21.11.2026: with another PC linked, every colleague names its PC – the same rule as the app's "Runs on"
    const local = agents.map((agent) => ({
      id: agent.id, name: agent.name, role: agent.role, team: agent.team, managerId: agent.managerId,
      spaceId: agent.spaceId, space: agent.spaceId ? spaceNames.get(agent.spaceId) : undefined,
      mode: agent.mode, status: agent.status, note: agent.statusNote, me: agent.id === ctx.agent.id || undefined,
      worksOn: severalPcs || agent.deviceId ? deviceName(ctx, agent.deviceId) : undefined,
      avatar: agent.avatar.kind, color: agent.avatar.color ?? paletteIndex(agent.id), // B-044: skill agent-portrait
    }));
    return json(local);
  },
});

type UpdateArgs = {
  agentId?: string; name?: string; role?: string; instructions?: string; mode?: string; skills?: string[]; team?: string; effort?: Effort | 'auto'; model?: string; device?: string; homes?: string[];
  managerId?: string; spaceId?: string; avatar?: AvatarArgs; voice?: string; home?: string; reason?: string;
};

/** Who an agent reports to and where it works. */
function placementPatch(args: UpdateArgs, ctx: ToolContext): Partial<Agent> | string {
  const org = ctx.services.org;
  const patch: Partial<Agent> = {};
  if (args.managerId !== undefined) patch.managerId = args.managerId || undefined; // '' = reports to the person; OrgService refuses cycles
  if (args.spaceId !== undefined) {
    const space = org.spaces().find((entry) => entry.id === args.spaceId);
    if (!space) return 'This space does not exist or is archived (spaces.list shows the active ones).';
    patch.spaceId = space.id;
  }
  return patch;
}

const updateAgent = defineTool<UpdateArgs>({
  name: 'agents.update',
  description: 'Changes an agent or myself: name, role, instructions, mode, model, effort, PC, manager. Each agent writes its own SYSTEM.md; to a colleague I say in a chat what I would change.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 60 }, role: { type: 'string', maxLength: 120 },
      instructions: { type: 'string', maxLength: MAX_SYSTEM_MD, description: 'My own SYSTEM.md, whole: "# How I work", my role and what I have here (the app keeps the standard comment at its end).' },
      mode: { type: 'string', description: 'Default mode.' }, skills: { type: 'array', items: { type: 'string' }, maxItems: 50, description: "Skills beyond its mode's." },
      team: { type: 'string' },
      effort: { type: 'string', enum: ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'], description: "For all its turns; auto: each turn's work sets it. One hard step or task I raise with model.set." },
      model: { type: 'string', description: "The model it settles on – the smallest that does the hardest step of its work as well as the strongest would; it runs there from its next context (another model rereads the whole context) and stays on it until it, its lead or the person names another. '' = automatic: its kind settles it, leading on the frontier tier, executing on the strong one." },
      device: { type: 'string', minLength: 1, maxLength: 120, description: "The PC it works on: on one of the person's own PCs its turns run there too, with its record; elsewhere its computer, browser and phone tools use it. An idle PC takes load off a busy one." },
      homes: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 120 }, maxItems: 20, description: "The person's own PCs it is at home on, by name: while the one it runs on is off, another of them goes on with it from its complete record. A new colleague (agents.create) starts at home on all of them; [] it waits for its PC." },
      managerId: { type: 'string', description: "'' = the person; this way I hand my team over." }, spaceId: { type: 'string' },
      avatar: {
        type: 'object', properties: { color: { type: 'integer', minimum: 0, maximum: 5 }, emoji: { type: 'string', maxLength: 16 }, fileId: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, additionalProperties: false,
        description: "emoji ('' = initials), color, or fileId of a portrait my run made; a photo the person chose stays.",
      },
      voice: { type: 'string', maxLength: 40, description: "For media.speak; '' = default." }, home: HOME_ARG, reason: { type: 'string', maxLength: 300, description: 'Shown in the summary.' },
    },
    additionalProperties: false,
  },
  category: 'agents',
  describe: (args, ctx) => {
    const id = args.agentId ?? ctx.agent.id;
    const reason = args.reason?.trim();
    const name = ctx.services.org.get(id)?.name ?? id;
    const home = args.home === undefined ? undefined : homeAction(ctx, args.home);
    const parts = [
      args.mode === undefined ? '' : `mode ${args.mode}`,
      args.device === undefined ? '' : `works on ${worksOnLabel(ctx, args.device)}`,
      args.homes === undefined ? '' : args.homes.length ? `at home on ${args.homes.map((value) => worksOnLabel(ctx, value)).join(', ')}` : 'waits for its own PC',
      args.managerId === undefined ? '' : `reports to ${ctx.services.org.get(args.managerId)?.name ?? args.managerId}`,
      args.spaceId === undefined ? '' : `moves to ${ctx.services.org.spaces().find((space) => space.id === args.spaceId)?.name ?? args.spaceId}`,
      home?.part ?? '',
    ].filter(Boolean);
    return {
      summary: `Update agent ${name}${parts.length ? `: ${parts.join(', ')}` : ''}${reason ? ` (${clip(reason, 160)})` : ''}`,
      resource: home?.resource ?? id, reversible: true, external: false,
    };
  },
  async run(args, ctx) {
    const targetId = args.agentId ?? ctx.agent.id;
    const target = ctx.services.org.get(targetId);
    if (!target) return failure('Agent not found.');
    const patch: Partial<Agent> = {};
    const ranOn = turnsRunOn(ctx, targetId); // Umzug 21.11.2026: undefined = its turns run here
    if (args.device !== undefined) {
      if (ctx.split && targetId === ctx.agent.id) return failure(OWN_MOVE_IN_PART); // review L3: a part never moves (and so stops) itself
      const pc = resolveDevice(ctx.services, args.device);
      if ('error' in pc) return failure(pc.error);
      const refused = pc.self ? undefined : moveRefused(ctx.services, targetId, pc.id); // its record goes with it (agents/move.ts)
      if (refused) return failure(refused);
      patch.deviceId = pc.self ? undefined : pc.id; // this PC is the default (no deviceId)
    }
    if (args.homes !== undefined) {
      const homes = homesPatch(ctx, args.homes, patch.deviceId ?? (args.device === undefined ? ranOn : undefined), targetId === ctx.agent.id ? 'I am' : `${target.name} is`);
      if (typeof homes === 'string') return failure(homes);
      patch.homes = homes;
    }
    const placed = placementPatch(args, ctx);
    if (typeof placed === 'string') return failure(placed);
    Object.assign(patch, placed);
    if (args.avatar !== undefined) {
      const avatar = await avatarPatch(ctx, target, args.avatar); // B-059: may shrink an oversized PNG portrait
      if (typeof avatar === 'string') return failure(avatar);
      patch.avatar = avatar;
    }
    if (args.name !== undefined) patch.name = args.name;
    if (args.role !== undefined) patch.role = args.role;
    const notMine = args.instructions !== undefined && targetId !== ctx.agent.id ? notMineLine(target.name) : undefined;
    if (args.instructions !== undefined && !notMine) patch.instructions = args.instructions;
    if (args.mode !== undefined) patch.mode = args.mode;
    const advice = args.mode !== undefined && targetId === ctx.agent.id ? checkModeSwitch(ctx.services, { agentId: ctx.agent.id, mode: ctx.mode, to: args.mode }).advice : undefined;
    if (args.skills !== undefined) patch.skills = args.skills;
    if (args.team !== undefined) patch.team = args.team;
    if (args.voice !== undefined) patch.voice = args.voice.trim() || undefined; // OrgService validates the name
    let pin: { pin?: string; note?: string } | undefined;
    if (args.effort !== undefined || args.model !== undefined) {
      const checked = args.model === undefined ? undefined : await pinFor(ctx, args.model);
      if (checked && 'error' in checked) return failure(checked.error);
      pin = checked;
      const { effort: fixed, pinBy: setBy, ...rest } = target.modelPolicy ?? {};
      // B-080 (live 06.11.: Konrad's "max for all" ran every turn at max and could not be cleared): 'auto' drops the fixed effort.
      const effort = args.effort === undefined ? fixed : args.effort === 'auto' ? undefined : args.effort;
      // B-083: who set my start model – a new pin is the caller's; an unchanged one (or no pin argument) keeps its origin.
      const pinBy = !pin ? setBy : !pin.pin ? undefined : pin.pin === rest.pin ? setBy
        : { name: ctx.agent.name, at: ctx.services.clock.now(), ...(targetId === ctx.agent.id ? { self: true } : {}) };
      patch.modelPolicy = { ...rest, ...(effort ? { effort } : {}), ...(pin ? { pin: pin.pin } : {}), ...(pinBy ? { pinBy } : {}) };
    }
    if (notMine && !Object.keys(patch).length && args.home === undefined) return failure(`Nothing written. ${notMine}`);
    // Umzug 21.11.2026: my own move ends this turn right after this call, not inside it (agents/move.ts movingMyself).
    const mine = args.device !== undefined && targetId === ctx.agent.id ? movingMyself(ctx.services, targetId, ctx.runId) : undefined;
    let updated: Agent;
    try {
      updated = args.home !== undefined && !Object.keys(patch).length ? target : ctx.services.org.update(targetId, patch, { by: ctx.agent.id, runId: ctx.runId, reason: args.reason }); // B-044: home alone = agent.json only
    } finally {
      mine?.();
    }
    if (args.avatar?.fileId !== undefined && target.avatar.value !== updated.avatar.value) portraitLine(ctx, updated);
    const runsOn = turnsRunOn(ctx, targetId);
    const moved = args.device === undefined || runsOn === ranOn ? undefined : targetId === ctx.agent.id
      ? `I move to ${deviceName(ctx, runsOn)}; this turn ends here, my next turn runs there with my record.`
      : `${updated.name} moves to ${deviceName(ctx, runsOn)}; a turn of ${updated.name} that runs now ends at its next step and goes on there with the record.`;
    return json({
      ok: true, agentId: updated.id, ...(args.device !== undefined ? { worksOn: deviceName(ctx, updated.deviceId) } : {}), ...(moved ? { moved } : {}),
      ...(args.homes === undefined ? {} : { homes: liveHomes(ctx.services.db, updated.homes ?? []).map((id) => deviceName(ctx, id)) }),
      ...(pin?.pin ? { model: pin.pin } : {}), ...(pin?.note ? { note: pin.note } : {}), ...(notMine ? { instructions: `Left as it is. ${notMine}` } : {}),
      ...(args.home === undefined ? {} : applyHome(ctx, targetId, args.home)), ...(advice ? { advice } : {}),
    });
  },
});

/**
 * The ids of the PCs named in `homes` – the person's own PCs only – with the PC the agent runs on (`runsOn`, undefined =
 * this PC) first; none for []. A text says which name is no such PC (`who`: "I am" or "<Name> is").
 */
function homesPatch(ctx: ToolContext, homes: string[], runsOn: string | undefined, who: string): string[] | string {
  if (!homes.length) return [];
  const self = selfId(ctx.services.db);
  const ids = [runsOn ?? self];
  for (const value of homes) {
    const pc = resolveDevice(ctx.services, value);
    if ('error' in pc) return pc.error;
    const id = pc.self ? self : pc.id;
    if (!id || !(pc.self || isCeoPc(ctx.services.db, id))) return `${who} at home on the person's own PCs; ${pc.name} is not one of them.`;
    ids.push(id);
  }
  return [...new Set(ids.filter(Boolean))];
}

/** The PC name for a device id (undefined = this PC); unknown ids stay as they are. */
/** Whether this PC has another PC linked (then where each agent runs tells them apart). */
function otherPcs(ctx: ToolContext): boolean {
  try { return ctx.services.devices.list().some((device) => device.kind === 'pc' && !device.self && device.status !== 'revoked' && device.status !== 'pairing'); } catch { return false; }
}

function deviceName(ctx: ToolContext, deviceId: string | undefined): string {
  try {
    const self = ctx.services.devices.self();
    if (!deviceId || deviceId === self.id) return self.name;
    return ctx.services.devices.list().find((device) => device.id === deviceId)?.name ?? deviceId;
  } catch {
    return deviceId ?? 'this PC';
  }
}

/** Where the agent's turns run: another PC of mine, undefined = here (also where the PCs cannot be read). */
function turnsRunOn(ctx: ToolContext, agentId: string): string | undefined {
  try { return homeElsewhere(ctx.services, agentId); } catch { return undefined; }
}

/** The summary text for a `device` value: the resolved PC's name, else the value as given. */
function worksOnLabel(ctx: ToolContext, value: string): string {
  const pc = resolveDevice(ctx.services, value);
  return 'error' in pc ? value.slice(0, 60) : pc.name;
}

export const agentTools: ToolDef[] = [listAgents, updateAgent];
