// B-057 S5/S17, B-083 (owner 08.11.2026: Ultra is one being) – the volatile prompt sections of splits
// (context/prompt-volatile.ts). A part's own turn (thread `split:<id>`) gets 'split': design/principle.md "Ultra PART" with
// its name, piece and the whole filled in, its other parts (titles, for agents.split_tell) and the one files line – no
// bans: a part is the agent (it may write in chats, remember, set its model, add parts); it leaves out the sections that
// belong to its origin's own work (SPLIT_SKIP: my quests and the related open work). An agent's own turn, while groups
// of its parts are still at work, gets 'splits' – "## My parts": per group (B-080: from every chat, this thread's first, a
// group split in another chat named with that chat's title) one line per part: status, model · effort · temperature
// (a working part's from its activity row – what its turn runs on now), a working part's last RECENT_STEPS steps (tool and
// short subject) and its newest thought (owner 13.11.2026: I see what my parts do without asking), its last note to me and
// the first line of its result once done. Splitting is
// the agent's own call: How I work names it (resources/prompts/standard-*.md); ULTRA_NOTE stays only for older messages
// that carried the person's Ultra hint (render.ts, dispatch-steer.ts). B-075: these texts speak as the agent itself.
// Owns: those texts and which sections a part leaves out. Never: carries a part's brief (the split turn's input notes
// do), decides anything about a split's lifecycle, or shows another agent's work.

import type { RuntimeServices } from '../contracts.ts';
import type { SplitProgress } from '../contracts/splits.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { AgentActivity, RunItem } from '../../shared/model/runs.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isTaskThread } from '../../shared/model/chat.ts';
import { TOLD_ORIGIN, isSplitThread, splitThread, type SplitGroupView, type SplitView } from '../../shared/model/splits.ts';
import { displayTitle, excerpt } from '../../shared/text/chat-names.ts';
import { answerOf } from '../splits/results.ts';

/** Sections a part's turn leaves out: its origin's own work. */
export const SPLIT_SKIP: ReadonlySet<string> = new Set(['quests', 'related']);

/** B-083: older messages only (the composer's Ultra cell went – the agent sees for itself when parts help). */
export const ULTRA_NOTE = '(the person thought splitting could help)';

/** ' ' + ULTRA_NOTE for a person's message that carried the Ultra hint (meta.ultra), '' otherwise – never on an agent's line. */
export function ultraNote(message: { authorKind?: string; meta?: { ultra?: unknown } }): string {
  return message.authorKind === 'human' && message.meta?.ultra === true ? ` ${ULTRA_NOTE}` : '';
}

/** A split turn's facts as the split service has them (both absent when it does not know the split). */
export interface SplitFacts { split?: SplitView; group?: SplitGroupView }

/** The facts of a split's thread; undefined for every other thread. */
export function splitFacts(services: Pick<RuntimeServices, 'splits' | 'log'>, thread: string | undefined): SplitFacts | undefined {
  if (!thread || !isSplitThread(thread)) return undefined;
  try {
    const found = services.splits?.get(thread.slice(splitThread('').length));
    return found ? { split: found.split, group: found.group } : {};
  } catch (error) {
    services.log?.debug('split facts unavailable', { thread, error: String(error) });
    return {};
  }
}

/** The 'split' section of a part's turn: design/principle.md "Ultra PART", its other parts and its files line. */
export function splitSection(agent: Pick<Agent, 'name'>, facts: SplitFacts): string {
  const { split, group } = facts;
  if (!split) return `## My part\nI am ${agent.name} – this part of me takes one piece all the way (it is in my input), while my origin and my other parts carry the rest.`;
  const piece = `“${excerpt(split.title, 80)}”`;
  const lines = [
    `## My part #${split.idx} of ${split.of}`,
    `I am ${agent.name} – this part of me takes ${piece} all the way (the whole: ${group?.goal ? excerpt(group.goal, 400) : piece}), while my origin and my other parts carry the rest. `
      + 'Same knowledge, tools and way of working; what I learn here, I keep. What would change how my origin or another part works, '
      + 'I tell it as soon as I see it (agents.split_tell – to my origin, a part, or all); agents.split_results {steps} shows what my other parts do. '
      + 'When I end, my last words and what I did on the way go back to my origin on their own and merge into it; what a chat should see now, I post there myself.',
  ];
  const others = (group?.splits ?? []).filter((item) => item.id !== split.id).map((item) => `#${item.idx} ${excerpt(item.title, 80)}`);
  if (others.length) lines.push(`My other parts: ${others.join('; ')}.`);
  lines.push(split.worktree
    ? `I work in my own git worktree${split.branch?.name ? ` (branch ${split.branch.name})` : ''} – I change what my part needs there and leave it uncommitted: the app commits my work on that branch when I end; my origin merges it.`
    : 'I share the working folder with my origin and my other parts – I keep to the files of my part.');
  return lines.join('\n');
}

/** At most this many groups in "My parts" (SPLIT_LIMITS.activeGroupsPerAgent keeps an agent there anyway). */
export const ACTIVE_SHOWN = 3;
export const ACTIVE_HEADER = '## My parts';
export const ACTIVE_TAIL = 'Their notes reach me as they come; each part comes back to me on its own as soon as it ends – its last words and what it did. '
  + 'agents.split_tell talks to them, agents.split_results {steps} shows more of what one does.';
const LINE_CHARS = 640;
/** A working part's newest steps shown here (owner 13.11.2026: "was die gerade sagen … nicht Kontext überfüllt"). */
export const RECENT_STEPS = 3;

type ActiveServices = Pick<RuntimeServices, 'splits'> & Partial<Pick<RuntimeServices, 'chats' | 'org' | 'settings' | 'people' | 'runs' | 'dispatcher' | 'tasks'>>;

/** A chat's title as this agent sees it (shared/text/chat-names.ts displayTitle; a task's own thread by its task); 'another chat' when it cannot be read. */
function chatTitle(services: ActiveServices, agentId: string, conversationId: string): string {
  try {
    const task = isTaskThread(conversationId) ? services.tasks?.get(conversationId) : undefined;
    if (task) return task.title;
    const chat = services.chats?.get(conversationId);
    if (!chat) return 'another chat';
    const human = (() => { try { return services.settings?.get().profile.name?.trim() || 'the CEO'; } catch { return 'the CEO'; } })();
    const nameOf = (id: string) => (id === HUMAN_ID ? human : services.org?.get(id)?.name ?? services.people?.get(id)?.name);
    const members = (services.chats?.members(conversationId) ?? []).filter((member) => !member.leftAt);
    return displayTitle(chat, members, agentId, nameOf) || 'Untitled chat';
  } catch {
    return 'another chat';
  }
}

/** B-080: where a group was split, when that is not this turn's thread – '' for this thread (and for this chat's other threads). */
function splitWhere(services: ActiveServices, agentId: string, group: SplitProgress, thread: string, conversationId: string | undefined): string {
  if (group.thread === thread) return '';
  if (group.conversationId) return group.conversationId === conversationId ? '' : ` (split in "${excerpt(chatTitle(services, agentId, group.conversationId), 80)}")`;
  return ' (split outside a chat)';
}

/** How far a group is, in a few words. */
function groupState(group: SplitProgress): string {
  return group.status === 'pending' ? `${group.parts} parts, not started yet (they start when the turn that split them ends)`
    : `${group.done} of ${group.parts} done, ${group.running} running${group.waiting ? `, ${group.waiting} not started yet` : ''}${group.ended ? `, ${group.ended} did not finish` : ''}`;
}

function partStatus(part: SplitView): string {
  switch (part.status) {
    case 'running': return 'working';
    case 'pending': return part.after.length ? `waits for #${part.after.join(', #')}` : 'not started yet';
    case 'queued': return 'waiting to start';
    case 'done': return 'done';
    default: return `${part.status}${part.error ? ` (${excerpt(part.error, 80)})` : ''}`;
  }
}

/**
 * model · effort · temperature: what a working part's turn runs on now (its activity row, once routed – a run's model is
 * written only when it ends), else its newest run's, else what it was asked to run on.
 */
function partModel(part: SplitView, live: AgentActivity | undefined): string {
  const now = live?.model ? live : undefined;
  const model = now ? now.modelName ?? now.model : part.run?.model ?? part.model;
  const effort = now ? now.effort : part.run?.effort ?? part.effort;
  const temperature = now ? now.temperature : part.temperature;
  return [model, effort, temperature !== undefined ? `temperature ${temperature}` : undefined].filter(Boolean).join(' · ');
}

/** Its last step (tool and short subject) and its last note to me, from its newest run's journal. */
function partActivity(services: ActiveServices, part: SplitView): string[] {
  if (!part.run || !services.runs) return [];
  let items: RunItem[];
  try { items = services.runs.items(part.run.id); } catch { return []; }
  const calls = items.filter((item) => item.kind === 'tool_call');
  const note = calls.findLast((item) => item.name === 'agents.split_tell' && String(item.data.summary ?? '').startsWith(TOLD_ORIGIN));
  const working = part.status === 'running';
  const steps = working ? calls.filter((item) => item.name !== 'agents.split_tell').slice(-RECENT_STEPS) : [];
  const thought = working ? items.findLast((item) => item.kind === 'reasoning' && String(item.data.summary ?? '').trim()) : undefined;
  const out: string[] = [];
  if (steps.length) out.push(`last steps: ${steps.map((step) => `${step.name}${step.data.summary ? ` ${excerpt(String(step.data.summary), 80)}` : ''}`).join(' → ')}`);
  if (thought) out.push(`thinks: "${excerpt(String(thought.data.summary).replace(/\s+/g, ' ').trim(), 180)}"`);
  if (note) out.push(`told me: "${excerpt(String(note.data.summary).slice(TOLD_ORIGIN.length).trim(), 140)}"`);
  if (part.status === 'done') {
    const first = answerOf(services.runs, part.run)?.split('\n').find((line) => line.trim());
    if (first) out.push(`result: ${excerpt(first.trim(), 140)}`);
  }
  return out;
}

/** One line of "My parts" (`live`: the part's activity row while its turn runs). */
function partLine(services: ActiveServices, part: SplitView, live: AgentActivity | undefined): string {
  const facts = [partStatus(part), partModel(part, live), ...partActivity(services, part)].filter(Boolean);
  return excerpt(`- #${part.idx} ${excerpt(part.title, 80)} – ${facts.join(' · ')}`, LINE_CHARS);
}

/**
 * R1-4 / B-083: "My parts" of an agent's own turn – its groups still at work (pending or running; B-080: from every chat,
 * this thread's first) with one line per part, so it knows what each part of it does, neither redoes their pieces nor
 * says they are finished or not started. '' for a part's turn and without such groups, so the volatile prompt of an agent
 * without parts at work stays as it was.
 */
export function activeSplitsLine(services: ActiveServices, agentId: string, thread: string | undefined, conversationId?: string): string {
  if (!thread || isSplitThread(thread)) return '';
  const groups = (services.splits?.activeOn?.(agentId, thread, ACTIVE_SHOWN) ?? []).slice(0, ACTIVE_SHOWN);
  if (!groups.length) return '';
  let live: AgentActivity[] = [];
  try { live = services.dispatcher?.activity() ?? []; } catch { live = []; }
  const blocks = groups.map((group) => {
    let view: SplitGroupView | undefined;
    try { view = services.splits?.list({ groupId: group.id, limit: 1 })[0]; } catch { view = undefined; }
    const head = `Group ${group.id} "${excerpt(group.goal, 120)}"${splitWhere(services, agentId, group, thread, conversationId)} – ${groupState(group)}:`;
    return [head, ...(view?.splits ?? []).map((part) => partLine(services, part, live.find((item) => item.split?.id === part.id)))].join('\n');
  });
  // A header, so a resumed session's delta names it "My parts" (agents/volatile-delta.ts sectionTitle).
  return `${ACTIVE_HEADER}\n${blocks.join('\n')}\n${ACTIVE_TAIL}`;
}
