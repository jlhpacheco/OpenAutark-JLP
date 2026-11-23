// agents.split_tell – the agent talking with its parts while they work, both ways, as one being:
//   part → origin: the note rides in the result of the call that waits for this part (decision 10 of 17.11.2026,
//     SplitService.tellWaiting), else it goes into the origin's running turn on the group's thread (dispatcher.tell, like
//     a folded line), else – or when that turn ends without having taken it – it wakes the origin there with it ('child',
//     the group's coalesce key – notes not yet read join one wake);
//   origin → part, part → another part ('all': every other part): a working part reads it at its next step
//     (dispatcher.tell on its lane; a turn that ends without it hands it to the part's retry), a part not started yet at
//     its start (SplitService.noteFor); model, effort and temperature go on the part's row for its next start
//     (SplitService.tune – checked like agents.split's) and a working part switches model or effort inside its turn where
//     its engine and account allow (dispatcher.continueNow with its run and the model its turn runs on now);
//     the part is told what changed and from when; stop ends a part (SplitService.stop) – the origin's to "all" with stop
//     and no groupId ends every active group of this thread.
// A part's note to its origin is journaled with the summary "To my origin: …" (TOLD_ORIGIN) – "My parts" shows the last –
// and whole as its own run item (splits/results.ts TOLD_ITEM), the part's result when it ends without last words.
// Also here: ownThread and myGroup, which agents-split.ts uses (one direction, no import cycle).
// KI-Runde 17.11.2026 (90 origin turns woken by parts' notes cost more than the parts): the description says what a note
// to the origin costs.
// Owns: this tool's wording, schema and where a note goes. Never: starts parts, routes a turn or posts in a chat.

import type { ToolContext } from '../types.ts';
import { failure, json } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { threadKey } from '../../../shared/model/origin.ts';
import type { Effort } from '../../../shared/model/providers.ts';
import { SPLIT_LIMITS, SPLIT_TERMINAL, TOLD_ORIGIN, type Split, type SplitGroupView, type SplitView } from '../../../shared/model/splits.ts';
import { EFFORT_ORDER } from '../../models/efforts.ts';
import { coalesceKey } from '../../splits/gather.ts';
import { TEMPERATURE_MAX } from '../../splits/validate.ts';
import { TOLD_ITEM } from '../../splits/results.ts';
import { clip, defineTool, internal } from './util.ts';
// SplitService.noteFor / tune (runtime/splits/service.ts) and Dispatcher.tell (agents/dispatch-lanes.ts) are module augmentations there.

export const TELL_TOOL = 'agents.split_tell';
const NOTE_CHARS = 2000;

type Args = { to: string | number; groupId?: string; text?: string; stop?: boolean; model?: string; effort?: Effort; temperature?: number };
type Tune = { model?: string; effort?: Effort; temperature?: number };

/** The thread a split call belongs to: the turn's (the plan's threadKey); a part's own call – its origin's. */
export function ownThread(ctx: ToolContext): string {
  return ctx.split?.parentThread ?? threadKey({});
}

/** My group `groupId` – else a part's own group, else this thread's newest, else my newest (B-080: any thread). */
export function myGroup(ctx: ToolContext, groupId?: string): SplitGroupView | undefined {
  const splits = ctx.services.splits;
  const id = groupId ?? ctx.split?.groupId;
  if (id) return splits?.list({ groupId: id, agentId: ctx.agent.id, limit: 1 }).find((group) => group.id === id && group.agentId === ctx.agent.id);
  const mine = (splits?.list({ agentId: ctx.agent.id, limit: 20 }) ?? []).filter((group) => group.agentId === ctx.agent.id);
  const thread = ownThread(ctx);
  return mine.find((group) => group.thread === thread) ?? mine[0];
}

const DESCRIPTION = 'Talks with my split parts while they work, steers or stops them. From a part, a note wakes my origin for a whole turn – or rides in the call that waits for me – so I send one when I need its answer to go on; what I found goes in my last words.';

/**
 * A note for my origin: it rides in the result of the call that waits for me (decision 10) – else the origin's running
 * main turn folds it in, and else, or when that turn ends without it, the origin wakes there with it.
 */
async function toOrigin(ctx: ToolContext, group: SplitGroupView, note: string): Promise<string> {
  const { dispatcher, wakes, splits } = ctx.services;
  if (ctx.split && splits?.tellWaiting?.(ctx.split.splitId, note)) return 'my origin reads it in the result of the call it waits in';
  const wake = () => wakes.wake({
    agentId: ctx.agent.id, reason: 'child', note, coalesceKey: coalesceKey(group.id),
    ...(group.conversationId ? { conversationId: group.conversationId } : {}), ...(group.taskId ? { taskId: group.taskId } : {}),
    ...(group.origin ? { origin: group.origin } : {}),
  });
  const running = dispatcher.activity().find((item) => item.agentId === ctx.agent.id && !item.split); // my one main turn
  if (running && (await dispatcher.tell?.(ctx.agent.id, running.runId, note, wake) ?? 'held') !== 'held') return 'my origin reads it at its next step';
  wake();
  return 'it wakes my origin';
}

/** A note into part `splitId`: its running turn at its next step, else its start – tried again when that turn ends without it. */
async function notePart(ctx: ToolContext, splitId: string, note: string): Promise<string | undefined> {
  const { dispatcher, splits } = ctx.services;
  const lane = dispatcher.splitLanes?.(ctx.agent.id).find((item) => item.splitId === splitId);
  const lost = () => { void notePart(ctx, splitId, note); }; // a retry's lane, else its start; an ended part has its result instead
  if (lane && (await dispatcher.tell?.(ctx.agent.id, lane.runId, note, lost) ?? 'held') !== 'held') return 'it reads it at its next step';
  return splits?.noteFor?.(splitId, note) ? 'it reads it when it starts' : undefined;
}

/** What changed, in a few words ("claude:claude-opus-5-5 · high · temperature 0.3"). */
const tuneText = (tune: Tune): string => [tune.model, tune.effort, tune.temperature !== undefined ? `temperature ${tune.temperature}` : undefined].filter(Boolean).join(' · ');

/** One part: stop it, or change it and tell it. */
async function toPart(ctx: ToolContext, part: SplitView, args: Args, from: string): Promise<Record<string, unknown>> {
  const splits = ctx.services.splits!;
  const dispatcher = ctx.services.dispatcher;
  if (SPLIT_TERMINAL.includes(part.status)) return { idx: part.idx, ended: part.status };
  if (args.stop) return { idx: part.idx, stopped: splits.stop({ splitId: part.id }, ctx.agent.id) > 0 };
  const tune: Tune = {
    ...(args.model !== undefined ? { model: args.model } : {}), ...(args.effort !== undefined ? { effort: args.effort } : {}),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  };
  const out: Record<string, unknown> = { idx: part.idx };
  const lane = part.status === 'running' ? dispatcher.splitLanes?.(ctx.agent.id).find((item) => item.splitId === part.id) : undefined;
  let changed = '';
  if (Object.keys(tune).length) {
    let next: Split | undefined;
    try { next = splits.tune?.(part.id, tune); } catch (error) {
      if (error instanceof WorkforceError) return { idx: part.idx, error: error.message };
      throw error;
    }
    if (!next) return { idx: part.idx, error: 'This part can no longer be changed.' };
    changed = tuneText({ ...tune, ...(tune.model !== undefined ? { model: next.model ?? 'my origin\'s model' } : {}) });
    // A working part switches inside its turn to a named model, or – effort alone – on what its turn runs on now (its
    // activity row: a run's model is written only when it ends); a word (same, cheap, strong) and a temperature are
    // routed at its next start.
    const live = lane ? dispatcher.activity().find((item) => item.runId === lane.runId)?.model : undefined;
    const modelId = next.model?.includes(':') ? next.model : tune.model === undefined ? live : undefined;
    const switched = lane !== undefined && modelId !== undefined && (tune.model !== undefined || tune.effort !== undefined)
      && (dispatcher.continueNow?.(ctx.agent.id, lane.runId, '', { modelId, ...(next.effort ? { effort: next.effort } : {}) }) ?? false);
    const later = switched && tune.temperature !== undefined;
    out.changed = !lane ? 'from its start' : switched ? `switched inside its turn${later ? ' (its temperature from its next start)' : ''}` : 'from its next start (its running turn stays on what it runs)';
    if (lane) changed += switched ? (later ? ' – the temperature from my next start' : '') : ' from my next start';
  }
  const text = args.text?.trim();
  const note = [text ? `${from} tells me: ${text}` : '', changed ? `${from} set me to ${changed}.` : ''].filter(Boolean).join('\n');
  if (!note) return out;
  out.note = (await notePart(ctx, part.id, note)) ?? 'not delivered: its engine takes nothing mid-turn – I tell it through its next start or read its result';
  return out;
}

export const tellTool = defineTool<Args>({
  name: TELL_TOOL,
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      to: { anyOf: [{ type: 'string', enum: ['origin', 'all'] }, { type: 'integer', minimum: 1, maximum: SPLIT_LIMITS.partsPerCall }], description: 'origin (from a part), a part number, or all.' },
      groupId: { type: 'string', minLength: 1, maxLength: 80, description: "Default this thread's newest; a part: its own." },
      text: { type: 'string', minLength: 1, maxLength: NOTE_CHARS, description: 'Read at its next step, or at its start.' },
      stop: { type: 'boolean', description: 'true ends it; to "all" without groupId ends every group of this thread.' },
      model: { type: 'string', minLength: 1, maxLength: 200, description: 'From its next start; a working part switches inside its turn where its engine allows.' },
      effort: { type: 'string', enum: [...EFFORT_ORDER] },
      temperature: { type: 'number', minimum: 0, maximum: TEMPERATURE_MAX },
    },
    required: ['to'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(clip(args.to === 'origin'
    ? `${TOLD_ORIGIN} ${args.text ?? ''}`
    : `To ${args.to === 'all' ? 'my other parts' : `my part #${args.to}`}: ${[args.stop ? 'stop' : '', tuneText(args), args.text ?? ''].filter(Boolean).join(' · ')}`, 300)),
  async run(args, ctx) {
    if (!ctx.services.splits) return failure('Splitting is not available here.');
    const self = ctx.split; // set when a part of me calls
    const text = args.text?.trim();
    const from = self ? `My part #${self.idx} “${clip(self.title, 80)}”` : 'My origin';
    if (args.to === 'origin') {
      if (!self) return failure('I am the origin: my notes go to a part number or "all".');
      if (args.stop || args.model !== undefined || args.effort !== undefined || args.temperature !== undefined) return failure('My origin sets its own model and stops its own work – I tell it what I see (text).');
      if (!text) return failure('Give the note (text).');
      const own = myGroup(ctx, self.groupId);
      if (!own) return failure('My group is no longer at work.');
      try { ctx.services.runs.item(ctx.runId, { kind: 'note', name: TOLD_ITEM, effectStatus: 'none', data: { text: ctx.services.secrets.redact(text) } }); } catch { /* the note still goes */ }
      return json({ ok: true, to: 'origin', note: await toOrigin(ctx, own, `${from} (group ${own.id}) tells me: ${text}`) });
    }
    if (!self && args.to === 'all' && args.stop && !args.groupId) { // every active group of this thread
      if (args.text?.trim() || args.model !== undefined || args.effort !== undefined || args.temperature !== undefined) return failure('Stopping every group takes stop alone.');
      const thread = ownThread(ctx);
      const groups = ctx.services.splits.list({ agentId: ctx.agent.id, active: true }).filter((group) => group.agentId === ctx.agent.id && group.thread === thread);
      return json({ ok: true, stopped: groups.reduce((sum, group) => sum + ctx.services.splits!.stop({ groupId: group.id }, ctx.agent.id), 0) });
    }
    const group = myGroup(ctx, args.groupId);
    if (!group) return failure(args.groupId ? `I have no split group ${clip(args.groupId, 80)}.` : 'I have no parts to talk with.');
    const idx = args.to === 'all' ? undefined : Number(args.to);
    const mine = (part: SplitView) => part.id === self?.splitId;
    if (idx !== undefined && group.splits.some((part) => part.idx === idx && mine(part))) return failure('That part is me.');
    const parts = group.splits.filter((part) => (idx === undefined ? !mine(part) : part.idx === idx));
    if (!parts.length) return failure(idx === undefined ? `Group ${group.id} has no other part.` : `Group ${group.id} has no part #${idx}.`);
    if (!text && !args.stop && args.model === undefined && args.effort === undefined && args.temperature === undefined) return failure('Say what: text, model, effort, temperature or stop.');
    const told: Array<Record<string, unknown>> = [];
    for (const part of parts) told.push(await toPart(ctx, part, args, from));
    return json({ ok: true, groupId: group.id, told });
  },
});
