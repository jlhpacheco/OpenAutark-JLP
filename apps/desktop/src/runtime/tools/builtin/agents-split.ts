// Split tools (Ultra is one being): an agent starts parts of ITSELF that work in parallel and come back into it
// (shared/model/splits.ts) and decides itself whether, when and how – agents.split (every mode, through tools.call; a
// learned tool joins the direct offer), agents.split_results (the full results of any of its groups, from any thread;
// with `steps` what its working parts do, their last commands; FIXES-3 A3: the ended parts my own turn read there come
// back with it, splits/service.ts) and agents.split_tell (agents-split-tell.ts: notes both
// ways, model, effort, temperature, stop – one part, a group, or every group of this thread).
// agents.split stores the group through services.splits (runtime/splits/service.ts – validation, limits) with the
// calling turn's facts – its run, chat, task, origin, thread (threadKey of the call = the turn plan's thread), mode and
// working folder (git/records.ts turnCwd = the turn's cwd) – and returns at once: the parts start when this turn ends
// (S3: a 'fork' part forks the finished turn), their results come back in one block on the next turn on that thread (S6).
// Owner 15.11.2026 ("wie wenn jemand einfach eine zweite CLI-Sitzung startet … kann auch gut ein anderes Modell nehmen"):
// a part starts fresh from its brief unless it asks for 'fork' (splits/validate.ts).
// B-083: a part's own agents.split adds parts to its group (depth 1, the group holds at most partsPerCall) – they start
// at once, its group already runs.
// KI-Runde 17.11.2026 (managers' briefs lacked their parts, parts ran on the origin's model): the brief's description names
// what a brief carries and the model's names the piece; a note from a part wakes the origin for a whole turn (nextText).
// Halb 21.11.2026 (0 of 23 parts named a model live): a fresh part says its `needs` – what its hardest step asks – and the
// router picks its model from that (splits/validate.ts requires it, routing/split-route.ts maps it).
// Decision 10 (a lead needs a look-up inside its own turn): with `wait` the parts start at the call and it answers with
// what each of them brought back – one tool call of the origin, the same brief, model, journal and cost as every part
// (splits/wait.ts, splits/service.ts waitFor); a line for that turn ends the wait early, and the parts are gathered when
// the turn ends 'done'.
// Owns: the tools' wording, schemas and results. Never: creates, starts or stops a split itself (the split service
// does), or passes agent-written text anywhere but the split service.

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { SPLIT_LIMITS, SPLIT_NEEDS, type SplitGroupView, type SplitPartInput } from '../../../shared/model/splits.ts';
import type { SplitCreateContext } from '../../contracts/splits.ts';
import { EFFORT_ORDER } from '../../models/efforts.ts';
import { turnCwd } from '../../git/records.ts';
import { STEPS_MAX, stepsText } from '../../splits/results.ts';
import { TEMPERATURE_MAX } from '../../splits/validate.ts';
import { clip, defineTool, internal } from './util.ts';
import { myGroup, ownThread, tellTool } from './agents-split-tell.ts';

export const SPLIT_TOOL = 'agents.split';
const UNAVAILABLE = 'Splitting is not available here. I do the parts myself, one after another.';

/** The tool result's note (S3): the origin's parts start when its turn ends; a part's new parts start at once. */
export function nextText(parts: number, fromPart = false): string {
  if (fromPart) return `My ${parts === 1 ? 'new part starts' : `${parts} new parts start`} now beside me in my group; like mine, ${parts === 1 ? 'its notes and last words go' : 'their notes and last words go'} to my origin.`;
  const start = parts === 1 ? 'My part starts' : `My ${parts} parts start`;
  return `${start} as soon as this turn ends, so I end it now (a short line to the person fits). Each part comes back to me on its own as soon as it ends – its last words and what it did; a note from a part wakes me for a whole turn in between.`;
}

const PART_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: SPLIT_LIMITS.titleChars },
    brief: { type: 'string', minLength: 1, maxLength: SPLIT_LIMITS.briefChars, description: 'All the part knows, in plain sentences: for whom and why, what good looks like, what is known and decided, how it checks its result itself.' },
    returns: { type: 'string', minLength: 1, maxLength: SPLIT_LIMITS.returnsChars, description: 'What I want back.' },
    context: { type: 'string', enum: ['brief', 'fork'], description: 'brief (default): starts fresh from its brief; fork: starts as me up to now, for a piece needing what I just learned.' },
    needs: { type: 'string', enum: [...SPLIT_NEEDS], description: 'What the piece\'s hardest step asks of whoever does it. check: its result can be held line by line against what is given. chain: a long way over many sources, cases or steps, each needing care. judgment: it hangs on meaning, tone, a decision or edge cases that must hold.' },
    model: { type: 'string', minLength: 1, maxLength: 200, description: 'A model by name instead; unset, needs decides.' },
    effort: { type: 'string', enum: [...EFFORT_ORDER] },
    temperature: { type: 'number', minimum: 0, maximum: TEMPERATURE_MAX },
    after: { type: 'array', items: { type: 'integer', minimum: 1, maximum: SPLIT_LIMITS.partsPerCall - 1 }, maxItems: SPLIT_LIMITS.partsPerCall - 1, description: 'Parts it waits for.' },
    worktree: { type: 'boolean', description: 'true: its own git worktree for file changes (agents.split_merge).' },
    chat: { type: 'string', minLength: 1, maxLength: 80, description: 'The chat its work is for.' },
  },
  required: ['title', 'brief'], additionalProperties: false,
};

const DESCRIPTION = 'Splits my work into parts of me that run in parallel and come back into me. '
  + 'They start when my turn ends, so I end it; each comes back with its last words; a note from one wakes me for a whole turn. '
  + 'A fresh part runs on the model its needs asks for, not on mine. '
  + 'With wait they start at once and this call brings their last words back inside my turn; a new line for me ends the wait. '
  + '4 run at once, more wait.';

/** The turn's working folder (agents/turn-attempt.ts: turnCwd of its task and agent). */
function cwdOf(ctx: ToolContext): string | undefined {
  try {
    const task = ctx.taskId ? ctx.services.tasks.get(ctx.taskId) : undefined;
    return turnCwd(ctx.services, task, ctx.agent.id);
  } catch {
    return undefined;
  }
}

/** The calling turn's facts (runtime-set, never the agent's text). */
export function createContext(ctx: ToolContext): SplitCreateContext {
  const cwd = cwdOf(ctx);
  return {
    agentId: ctx.agent.id, runId: ctx.runId, thread: ownThread(ctx), modeKey: ctx.mode,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}), ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx.origin ? { origin: ctx.origin } : {}), ...(cwd ? { cwd } : {}), ...(ctx.split ? { split: ctx.split } : {}),
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const split = defineTool<{ goal: string; parts: SplitPartInput[]; wait?: boolean }>({
  name: SPLIT_TOOL,
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: SPLIT_LIMITS.goalChars, description: 'The whole job.' },
      parts: { type: 'array', items: PART_SCHEMA, minItems: 1, maxItems: SPLIT_LIMITS.partsPerCall },
      wait: { type: 'boolean', description: 'true: they start now and this call answers with what each of them brought back.' },
    },
    required: ['goal', 'parts'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => {
    const parts = Array.isArray(args.parts) ? args.parts : [];
    return internal(clip(`Split into ${plural(parts.length, 'part')}: ${parts.map((part) => part.title).join(', ')}`, 200));
  },
  async run(args, ctx) {
    const splits = ctx.services.splits;
    if (!splits) return failure(UNAVAILABLE);
    // A part's new parts join its group and report to its origin like it does (nextText), so only my main turn waits –
    // a part holding its lane for parts that need a lane of the same four would wait for nothing.
    const waits = args.wait === true && !ctx.split && splits.waitFor !== undefined;
    let group: SplitGroupView;
    try {
      group = splits.create(createContext(ctx), { goal: args.goal, parts: args.parts, ...(waits ? { wait: true } : {}) });
    } catch (error) {
      if (error instanceof WorkforceError) return failure(`${error.message} Nothing was split.`);
      throw error;
    }
    const added = ctx.split ? group.splits.slice(-args.parts.length) : group.splits;
    const parts = added.map((part) => ({ idx: part.idx, title: part.title, id: part.id }));
    // Decision 10: this call holds while they work and answers with what they brought back (splits/wait.ts).
    if (waits) {
      ctx.status(`Waiting for ${plural(parts.length, 'part')} of me`);
      const waited = await splits.waitFor!({ agentId: ctx.agent.id, runId: ctx.runId, splitIds: parts.map((part) => part.id), signal: ctx.signal });
      return text(waited.text);
    }
    return json({ ok: true, groupId: group.id, parts, next: nextText(parts.length, Boolean(ctx.split)) });
  },
});

const results = defineTool<{ groupId?: string; idx?: number; steps?: number }>({
  name: 'agents.split_results',
  description: 'Returns the full results of my split parts, also while they run.',
  inputSchema: {
    type: 'object',
    properties: {
      groupId: { type: 'string', minLength: 1, maxLength: 80, description: "Default my newest group, this thread's first; any chat's." },
      idx: { type: 'integer', minimum: 1, maximum: SPLIT_LIMITS.partsPerCall, description: 'One part.' },
      steps: { type: 'integer', minimum: 1, maximum: STEPS_MAX, description: 'Instead, the last n commands of each working part.' },
    },
    additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Read ${args.steps ? 'the steps of my parts' : 'split results'}${args.groupId ? ` of ${args.groupId}` : ''}${args.idx ? ` #${args.idx}` : ''}`),
  async run(args, ctx) {
    const splits = ctx.services.splits;
    if (!splits) return failure(UNAVAILABLE);
    if (args.steps) {
      const group = myGroup(ctx, args.groupId);
      if (!group) return failure(args.groupId ? `I have no split group ${clip(args.groupId, 80)}.` : 'I have no split group yet.');
      return text(stepsText(ctx.services.runs, group, args.steps, args.idx));
    }
    // FIXES-3 A3: what my own turn reads here is gathered when it ends 'done' (a part's run gathers nothing).
    return text(splits.results(ctx.agent.id, { ...(args.groupId ? { groupId: args.groupId } : {}), ...(args.idx ? { idx: args.idx } : {}), thread: ownThread(ctx), ...(ctx.split ? {} : { runId: ctx.runId }) }));
  },
});

export const splitTools: ToolDef[] = [split, results, tellTool];
