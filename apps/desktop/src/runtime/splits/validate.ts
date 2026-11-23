// The checks of a new split group (B-057 S8/S10/S11/S16), all before anything is written: the agent exists and is active
// (not archived, not paused by the person – S13), a goal, 1–12 parts with a title, a brief and an optional 'returns'
// within SPLIT_LIMITS, context fork|brief, model same|cheap|strong|a known and usable catalog model – Halb 21.11.2026: a
// fresh part without one names its needs check|chain|judgment, stored as its model word –, an effort of the
// Effort scale, a temperature 0..2 (B-083), `after` naming only lower parts, a worktree part only with a working folder,
// at most SPLIT_LIMITS.activeGroupsPerAgent groups of the agent pending or running.
// B-083 (owner 08.11.2026: parts are the agent): a part's own call adds parts to its group – depth stays 1, the group holds
// at most partsPerCall parts, the new parts are numbered after the group's and their `after` names group numbers.
// checkTune checks what agents.split_tell changes on a part (model, effort, temperature) the same way.
// Whether the working folder can give a part its own worktree needs git (asynchronous): the runner checks it when the
// part starts and fails that part with git's reason (runner.ts) – create stays synchronous.
// Owns: those checks and their texts. Never: writes, starts or routes anything.

import { WorkforceError, type ErrorCode } from '../../shared/errors.ts';
import type { Effort, ModelInfo } from '../../shared/model/providers.ts';
import { SPLIT_LIMITS, SPLIT_NEEDS, type SplitContext, type SplitGroup, type SplitNeeds, type SplitPartInput } from '../../shared/model/splits.ts';
import type { SplitCreateContext } from '../contracts/splits.ts';
import { EFFORT_ORDER } from '../models/efforts.ts';
import { catalogModel } from '../agents/next-route.ts';
import { BUSY_GROUPS, type SplitCore } from './core.ts';

/** The temperature range (as model.set's). */
export const TEMPERATURE_MAX = 2;

/** A part as stored: trimmed, defaults applied ('same' model = none named). */
export interface CheckedPart {
  title: string; brief: string; returns?: string; context: SplitContext; model?: string; effort?: Effort; temperature?: number; after: number[]; worktree: boolean; chat?: string;
}

/** What agents.split_tell changes on a part; a key that is present changes it (model undefined = 'same' again). */
export type CheckedTune = { model?: string; effort?: Effort; temperature?: number };

function no(message: string, code: ErrorCode = 'bad_request'): never {
  throw new WorkforceError(code, message);
}

function textOf(value: unknown, what: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) return required ? no(`${what} is missing.`) : undefined;
  if (typeof value !== 'string') return no(`${what} must be text.`);
  const text = value.trim();
  if (!text) return required ? no(`${what} is empty.`) : undefined;
  if (text.length > max) no(`${what} is ${text.length} characters long; at most ${max}.`);
  return text;
}

/**
 * 'cheap' | 'strong' | a catalog id; undefined for 'same' or nothing. B-080: a name resolves through the one model lookup
 * (agents/next-route.ts catalogModel – model.set, tasks.add and tasks.update use it too), so a part and a delegation name a model alike.
 */
function modelOf(core: SplitCore, given: unknown, part: string): string | undefined {
  if (given === undefined || given === null || given === '') return undefined;
  if (typeof given !== 'string') return no(`${part}: model must be same, cheap, strong or a model id from models.list.`);
  const name = given.trim();
  const word = name.toLowerCase();
  if (word === 'same') return undefined;
  if (word === 'cheap' || word === 'strong') return word;
  let found: ModelInfo | string | undefined;
  try {
    const catalog = core.services()?.catalog;
    found = catalog ? catalogModel(catalog, name) : undefined;
  } catch { found = undefined; }
  if (found === undefined) return no(`${part}: unknown model "${name.slice(0, 80)}" – use same, cheap, strong or a model id from models.list.`, 'not_found');
  if (typeof found === 'string') return no(`${part}: ${found} It also takes same, cheap or strong.`); // unknown, or no usable account
  return found.id;
}

/** The needs line an old call or a wrong value gets (the model calls again with one of the three). */
export const NEEDS_TEXT = 'needs says what its hardest step asks: check (its result can be held line by line against what is given), chain (a long way over many sources, cases or steps) or judgment (meaning, tone, a decision or edge cases that must hold).';

/**
 * Halb 21.11.2026: a fresh part without a model of its own names its needs, stored as its model word (the router maps it,
 * routing/split-route.ts); a fork part runs on my model and context, so its needs plays no part.
 */
function needsOf(given: unknown, context: SplitContext, part: string): SplitNeeds | undefined {
  if (context === 'fork') return undefined;
  if (given === undefined || given === null || given === '') return no(`${part} starts fresh: ${NEEDS_TEXT}`);
  if (typeof given === 'string' && (SPLIT_NEEDS as readonly string[]).includes(given)) return given as SplitNeeds;
  return no(`${part}: ${NEEDS_TEXT}`);
}

function effortOf(given: unknown, part: string): Effort | undefined {
  if (given === undefined || given === null || given === '') return undefined;
  if (typeof given === 'string' && (EFFORT_ORDER as readonly string[]).includes(given)) return given as Effort;
  return no(`${part}: effort must be one of ${EFFORT_ORDER.join(', ')}.`);
}

function temperatureOf(given: unknown, part: string): number | undefined {
  if (given === undefined || given === null) return undefined;
  if (typeof given === 'number' && Number.isFinite(given) && given >= 0 && given <= TEMPERATURE_MAX) return Math.round(given * 100) / 100;
  return no(`${part}: temperature is a number from 0 to ${TEMPERATURE_MAX}.`);
}

function afterOf(given: unknown, idx: number, part: string): number[] {
  if (given === undefined || given === null) return [];
  if (!Array.isArray(given)) return no(`${part}: after must be a list of part numbers.`);
  const out: number[] = [];
  for (const value of given) {
    if (!Number.isInteger(value) || value < 1 || value >= idx) {
      no(idx === 1 ? `${part}: the first part waits for no other – leave its after out.` : `${part}: after names earlier parts only (#1–#${idx - 1}).`);
    }
    if (!out.includes(value)) out.push(value);
  }
  return out.sort((a, b) => a - b);
}

function partOf(core: SplitCore, cwd: string | undefined, given: SplitPartInput, idx: number): CheckedPart {
  const part = `Part #${idx}`;
  if (!given || typeof given !== 'object' || Array.isArray(given)) return no(`${part} must be an object with a title and a brief.`);
  const title = textOf(given.title, `${part}'s title`, SPLIT_LIMITS.titleChars, true)!;
  const brief = textOf(given.brief, `${part}'s brief`, SPLIT_LIMITS.briefChars, true)!;
  const returns = textOf(given.returns, `${part}'s returns`, SPLIT_LIMITS.returnsChars, false);
  const context = given.context === undefined || given.context === null ? 'brief' : given.context; // owner 15.11.2026: a part starts fresh unless it needs what I know now
  if (context !== 'fork' && context !== 'brief') no(`${part}: context must be fork or brief.`);
  if (given.worktree !== undefined && given.worktree !== null && typeof given.worktree !== 'boolean') no(`${part}: worktree must be true or false.`);
  const worktree = given.worktree === true;
  if (worktree && !cwd) no(`${part} asks for its own worktree, but this turn has no working folder (a git repository in the workspace).`, 'conflict');
  const model = modelOf(core, given.model, part) ?? needsOf(given.needs, context, part);
  const effort = effortOf(given.effort, part);
  const temperature = temperatureOf(given.temperature, part);
  const chat = textOf(given.chat, `${part}'s chat`, 80, false);
  return {
    title, brief, ...(returns ? { returns } : {}), context, ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    ...(temperature !== undefined ? { temperature } : {}), after: afterOf(given.after, idx, part), worktree, ...(chat ? { chat } : {}),
  };
}

/** The checked goal and parts; `group` is set for a part's own call (the parts join that group, numbered from `offset` + 1). */
export interface CheckedCreate { goal: string; parts: CheckedPart[]; group?: SplitGroup; offset: number }

/** Every check of a new group – or, from a part, of the parts it adds to its own group (see the header). Throws WorkforceError. */
export function checkCreate(core: SplitCore, ctx: SplitCreateContext, input: { goal: unknown; parts: unknown }): CheckedCreate {
  const agent = core.deps.org.get(ctx.agentId);
  if (!agent) no(`No agent ${ctx.agentId}.`, 'not_found');
  if (agent!.archivedAt !== undefined) no(`${agent!.name} is archived.`, 'conflict');
  // S13: paused by the person (or a manager) while this turn ran – its splits would be stopped at once.
  if (agent!.status === 'paused') no(`${agent!.name} was paused, so it does not split now.`, 'conflict');
  const goal = textOf(input?.goal, 'The goal', SPLIT_LIMITS.goalChars, true)!;
  const given = input?.parts;
  const count = Array.isArray(given) ? given.length : 0;
  if (ctx.split) {
    const group = core.repo.getGroup(ctx.split.groupId);
    if (!group || group.agentId !== ctx.agentId || group.status !== 'running') no('My group is no longer at work, so I add no parts to it.', 'conflict');
    const offset = core.repo.listSplits({ groupId: group!.id }).length;
    const room = Math.max(0, SPLIT_LIMITS.partsPerCall - offset);
    if (count < 1 || count > room) no(`My group has ${offset} parts and holds ${SPLIT_LIMITS.partsPerCall}: I add 1–${room} (got ${Array.isArray(given) ? count : 'none'}).`, room ? 'bad_request' : 'conflict');
    const parts = (given as SplitPartInput[]).map((part, index) => partOf(core, group!.cwd, part, offset + index + 1));
    return { goal: group!.goal, parts, group: group!, offset };
  }
  if (count < 1 || count > SPLIT_LIMITS.partsPerCall) {
    no(`Give 1–${SPLIT_LIMITS.partsPerCall} parts (got ${Array.isArray(given) ? count : 'none'}).`);
  }
  const parts = (given as SplitPartInput[]).map((part, index) => partOf(core, ctx.cwd, part, index + 1));
  const busy = core.repo.listGroups({ agentId: ctx.agentId, statuses: BUSY_GROUPS }).length;
  if (busy >= SPLIT_LIMITS.activeGroupsPerAgent) {
    no(`${busy} groups of my parts are still at work (at most ${SPLIT_LIMITS.activeGroupsPerAgent}). I wait for their results, or stop one with agents.split_tell {to: "all", stop: true}.`, 'conflict');
  }
  return { goal, parts, offset: 0 };
}

/** B-083: what agents.split_tell changes on part `idx` – checked like a new part's model, effort and temperature. */
export function checkTune(core: SplitCore, idx: number, given: { model?: unknown; effort?: unknown; temperature?: unknown }): CheckedTune {
  const part = `Part #${idx}`;
  const out: CheckedTune = {};
  if (given.model !== undefined) out.model = modelOf(core, given.model, part);
  if (given.effort !== undefined) out.effort = effortOf(given.effort, part);
  if (given.temperature !== undefined) out.temperature = temperatureOf(given.temperature, part);
  return out;
}
