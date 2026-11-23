// Turn phase 1 – plan and route: who runs, in which mode, on which model/account, with
// which session, prompt and input. Owns: mode resolution (the agent's own mode), the focus
// text for routing, the subconscious's look before this turn (subconscious/service.ts beforeTurn: on a person's message with content – or a colleague's when no person wrote, else the turn's task – one call first, bounded, which sets the turn's effort and gives a line for each hit of the word search it picks, v2 15.11.2026; Runde „Halb“ 21.11.2026: those lines reach the turn as its live block's "## From my memory" – subconscious/hints.ts, context/prompt-volatile.ts –, not as tool calls; its trace holds only what a run kept for the thread, e.g. timeout decisions), the model the turn starts from (17.11.2026: the model the
// session is on and whether the turn stands at a boundary – boundary.ts, asked once; next-route.ts: the request in force on top, read after the look), session choice
// (session-choice.ts; CTX7, compaction-policy.ts; B-080: no working set – a session lives on, the subconscious's marks keep it lean item by
// item, and only a context that no longer fits the model's window has its oldest tool work hidden or, when even that is not
// enough, is renewed = dropped binding; S2 17.11.2026: a changed prompt key – stable prompt + offered tools – keeps the
// session: it resumes on the system text and tool names it started with (session-key.ts start record) and gets each changed
// stable section once as changed lines in front of its live block (volatile-delta.ts stableDelta); a session that starts
// anew takes the current prompt and offer and its start is recorded with its binding (turn-finish.ts); a Codex revert keeps
// the thread, so it keeps its start; a session bound before the record existed, whose key differs, gets every current
// section once; the first turn after a mode switch says "My mode is now Y (was X)"; a row from
// before SES2 is accepted once; another engine rebuilds from the record too). 13.11.2026 evening (owner: "der Kontext geht nie verloren … nie
// auf null angefangen oder mit einem Chat"): a turn without a session that holds the context – a rebuild that could not run, a
// session-less engine – starts its input with the agent's own record as text (history-text.ts), never a chat's history; the
// wake's chat gives only its new lines. The tool offer, attachment extraction before the delta, and one note for cut-off work
// (interruption-context.ts): when and why it was cut, what came in since, and (PR3) what I already did then when this engine
// cannot know it. The prompt: the stable part is the system prompt; the live (volatile) part goes to the engine with the turn,
// which sends it as the first block of the input (engines/shared.ts contextText) – all of it on a new, renewed or rebuilt
// session or a stateless engine (my latest answers kept in my run log follow it as the input's first lines), only what changed since my last finished
// turn on a resumed one (B-049 F6, volatile-delta.ts; turn-finish records what it then holds). B-066: last-prompt.md shows
// both as they go out this turn, written once the session is chosen.
// Whose turn (tasks/owners.ts): a follow-up (retry/review) for a task another agent owns now plans
// no turn (its owner's manager's review does). Only a wake the human caused
// (answer, approval, or a manual run – messages.retry wakes 'manual' with the stopped run's task)
// resumes a task the human paused, for its owner or lead; a chat or mini-app 'message' wake runs
// without the task (it stays paused); every other wake (retry, review, schedule, task, handoff,
// child – agents and timers) plans no turn for it. An archived chat runs like any other (C2); notes
// before the delta are quoted (quoteHeaders), a 'review' wake's as the app's, never the agent's own.
// 13.11.2026 (owner: one context per agent): the plan's thread is the agent's main thread (shared/model/origin.ts) – one
// native session, volatile-delta record and ledger for every wake, whatever chat, task or source it comes from; the wake's
// chat only decides which lines the input carries.
// A native rebuild from the context ledger (agents/rebuild.ts) where the session starts anew anyway – an engine switch, a missing
// session, a fold waiting to be replayed, past the fit, a cold cache – and nowhere else (KI-Runde 17.11.2026: no rebuild of a
// warm session for a saving); a session that starts anew, rebuilt ones included, takes the agent's learned tools. A fold's own
// turn (agents/context-fold.ts) is planned there and resumes its session as it stands with the fold note as its whole input. A turn
// whose history starts from the projection gets the call naming what is condensed or hidden there (turnTrace).
// B-057 (agents/split-turn.ts): a split's turn plans, routes, seeds its session and gets its parent's tool offer there (F26: a
// 'fork' part's first start condenses its own copy of my record before it is seeded – splits/fork.ts); the
// agent's own turn gets its settled splits' "Split results" block in its input (RoutedTurn.splitParts).
// Never: starts the engine, posts chat messages (only TaskService.resume's quiet line) or
// advances cursors (turn-finish does that).

import type { RuntimeServices, RouteRequest } from '../contracts.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RouteDecision } from '../../shared/model/providers.ts';
import { MAIN_THREAD } from '../../shared/model/origin.ts';
import { hasTrace, type SubconsciousTrace } from '../../shared/model/subconscious.ts';
import type { Engine } from '../engines/types.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { DeltaInput, DeltaResult } from '../context/delta.ts';
import { PROJECTION, quoteHeaders } from '../context/projection.ts';
import { answersRecap, needsRecap, recapScope, recapText, recentActions } from '../context/recent-actions.ts';
import { writeLastPrompt } from '../context/last-prompt.ts';
import { contextText } from '../engines/shared.ts';
import { INTERRUPTED_NOTE } from '../tasks/recover-notes.ts';
import { REDELIVERY_NOTE } from './redelivery.ts';
import { fromPerson } from './publishing.ts';
import { isExternalAgent } from '../../shared/model/external-agents.ts';
import { SessionStore, type SessionBinding } from './sessions.ts';
import { pendingRoute, returnChoice } from './next-route.ts';
import { boundaryOf } from './boundary.ts';
import { modeChangeNote, offeredTools, promptKey, sessionOffer, startOf } from './session-key.ts';
import { promoteLearned } from '../tools/learned.ts'; // B-049 F4 (TOOLS-CORE)
import { carries, forgetSent, sentTo, stableDelta, volatileDelta } from './volatile-delta.ts'; // B-049 F6, S2
import { isPaused } from '../../shared/model/tasks.ts';
import { fitLimit } from './compaction-policy.ts';
import { engineUnit } from '../../shared/model/context-ledger.ts';
import { historyText } from './history-text.ts';
import { chooseSession, type SeedContext } from './session-choice.ts';
import { foldNote, planFold } from './context-fold.ts'; // KI-Runde 17.11.2026: the fold's own turn
import { callRunning } from '../calls/call-log.ts'; // KI-Runde 17.11.2026: a call turn only while that call runs
import { carriedCalls, marksCall, marksOf } from '../context/ledger/marks.ts';
import type { RoutedTurn, TurnPlan, TurnRequest } from './turn-types.ts';
import { planSplit, splitResults, splitRoute } from './split-turn.ts'; // B-057
import { visionInputs } from '../media/vision-image.ts'; // B-058 G10 (T4): image inputs normalized for every engine
import { interruptionNote } from './interruption-context.ts';
import { reminderSnapshot } from '../context/quest-text.ts'; // FIXREAL 5: a reminder's note carries its quest as it stands
import { displayZone } from '../context/time.ts';
import { noteLabel, scheduleSubject, taskSubject } from './note-label.ts';
import { riderInput } from './turn-riders.ts'; // Runde „Halb“ 21.11.2026

/** Runs read for the effort and kind of work of my newest done run on the model I am on. */
const RETURN_WINDOW = 50;
/** Wakes the human caused (a retry of a stopped answer is 'manual'): the only ones that end the human's pause of a task. */
const BY_HUMAN: ReadonlySet<WakeReason> = new Set(['answer', 'manual']);
/** Task states in which a bare 'task' wake has nothing to continue (the owner set the work aside, or it is over). */
const SET_ASIDE: ReadonlySet<string> = new Set(['waiting', 'done', 'dropped']);

/** Unknown mode keys already logged (once per key while the runtime runs). */
const unknownModes = new Set<string>();

/** The turn's mode: the first key the mode library answers (the agent's own; a split part's first) – an unknown
 *  (deleted, never defined) key is answered with general and logged once. Experience notes use it too (experience.ts). */
export function resolveMode(services: RuntimeServices, keys: Array<string | undefined>): ModeInfo {
  for (const key of keys) {
    if (!key) continue;
    try { return services.modes.get(key); } catch {
      if (!unknownModes.has(key)) {
        unknownModes.add(key);
        services.log?.warn('unknown mode key – the turn runs in general', { mode: key });
      }
    }
  }
  return services.modes.get('general');
}

/** Loads agent, task, chat and mode; the subconscious's trace; then asks whether the turn stands at a boundary and reads the request in force – model.set's, my task's or my subconscious's for this turn (B-080: turn.ts takes what the turn used up). */
export async function planTurn(services: RuntimeServices, request: TurnRequest): Promise<TurnPlan | undefined> {
  if (request.split) return planSplit(services, request, resolveMode); // B-057: a split's own plan (agents/split-turn.ts)
  if (request.fold) return planFold(services, request, resolveMode); // KI-Runde 17.11.2026: a context fold's own plan (agents/context-fold.ts)
  const agent = services.org.get(request.agentId);
  if (!agent || agent.archivedAt || agent.status === 'paused') return undefined;
  let task = request.taskId ? services.tasks.get(request.taskId) : undefined;
  if (task) {
    const owner = task.assigneeKind === 'agent' && task.assigneeId === agent.id;
    if ((request.reason === 'retry' || request.reason === 'review') && !owner) return undefined; // a look back at work I no longer own
    // B-047: a bare 'task' wake (no note: nothing new) for work its owner already set aside is stale – it was queued while
    // that work ran (e.g. at the task's creation) and would restart what the owner just paused, maybe on the person's
    // "stop". Wakes with news (an answer, a finished step, a reopening) carry a note.
    if (request.reason === 'task' && !request.notes.length && SET_ASIDE.has(task.status)) return undefined;
    if (isPaused(task)) {
      if (BY_HUMAN.has(request.reason)) {
        if (owner) task = resumed(services, task, agent.id);
      } else if (request.reason === 'message') {
        task = undefined; // a chat or mini-app event is answered; the work stays paused
      } else {
        return undefined; // only the human resumes paused work
      }
    }
  }
  const conversationId = request.conversationId ?? task?.conversationId;
  const conversation = conversationId ? services.chats.get(conversationId) : undefined;
  if (conversationId && !conversation) return undefined;
  const mode = resolveMode(services, [agent.mode]); // the mode is the agent's own (13.11.2026)

  const room = conversationId ? services.chats.members(conversationId) : [];
  const member = room.find((item) => item.memberId === agent.id && !item.leftAt);
  const memberCursor = member?.readSeq ?? 0;
  const unseen = conversationId ? services.chats.messages(conversationId, { afterSeq: memberCursor, limit: 40 }) : [];
  const lastInput = unseen.filter(message => message.authorKind === 'human' && message.kind !== 'status').at(-1);
  // KI-Runde 17.11.2026 (decision 8.3): a turn is a call turn only while that call still runs; the lines of an ended call
  // read as said in a call that has ended (context/speech-notes.ts) and the turn posts only what it addresses.
  // FIXES-3 D2 (review R2): a line of a running call does not wait for the subconscious, also when it resumes my task
  // (onCall); its answer is spoken only from a turn without a task (callId).
  const lineCall = request.reason === 'message' ? lastInput?.meta.call?.id : undefined;
  const onCall = lineCall && conversationId && callRunning(services, conversationId, lineCall) ? lineCall : undefined;
  const callId = task ? undefined : onCall;
  // Routing reads what I am asked now: the person's newest line, else my task. Colleagues' reports, paths and
  // addresses in this chat name the topics of the work, not its kind (routing/categories.ts). The card of my task
  // (its title only) reads as the whole task, so every turn of a task has one kind.
  const asked = lastInput && !(lastInput.kind === 'task' && lastInput.taskId === task?.id) ? lastInput.body : undefined;
  const focus = asked ?? (task ? `${task.title}\n${task.notes}` : undefined);
  const needsVision = unseen.some((message) => message.attachments.some((file) => file.mime.startsWith('image/')));

  const thread = MAIN_THREAD; // one context per agent
  const origin = request.origin;
  // The person's lines; a message with only files names them, so a screenshot alone still is the person's turn (v1 routes it as theirs).
  const said = unseen.filter((message) => fromPerson(message, agent.id)).map((message) => message.body.trim() || `[${message.attachments.map((file) => `${file.name} (${file.mime})`).join(', ')}]`).filter((line) => line !== '[]').join('\n');
  const woke = unseen.filter((message) => message.authorId !== agent.id && message.kind !== 'status' && (message.authorKind === 'agent' || isExternalAgent(message.authorId))).map((message) => message.body).join('\n'); // colleagues' lines (v1: routed when no person wrote)
  // My task as this turn reads it (its title, the wake's newest note, else its notes): v1 routes a wake with nobody's words on it. A chat
  // wake's ('message') note is a mini-app event or a waiting task's notice, not the work – there the task's own notes stand.
  const taskNote = request.reason === 'message' ? undefined : request.notes.at(-1)?.text;
  const taskText = task ? [task.title, taskNote ?? task.notes].map((part) => part.trim()).filter(Boolean).join('\n') : undefined;
  // The call before the turn stores its hints for this turn's live block (subconscious/hints.ts); the trace is what was kept for the thread.
  const trace = await subconsciousTrace(services, request.signal, { agent, thread, conversationId, taskId: task?.id, mode: mode.key, said, woke, ...(taskText ? { taskText } : {}), ...(needsVision ? { vision: true } : {}), ...(onCall ? { callId: onCall } : {}), signal: request.signal }); // FIXES-3 D2: a running call's line does not wait for it
  // 17.11.2026 (the model settles): the one question whether this turn's context starts anew anyway (boundary.ts) – off a
  // boundary the router keeps the model the session is on, whoever asks for another; the model I am on is that session's,
  // else my newest done run's (next-route.ts returnChoice). A request in force – my step's effort over my task's, the model
  // I asked for – rides on it, marked explicit. B-080: taken by turn.ts as the engine starts (those it read: their `at`
  // rides on the plan, as the temperature does). B-083: read after the look, so the effort my subconscious set for this
  // turn (subconscious/route-turn.ts) runs it; a failing read gives the trace it took back to the thread.
  let requested: ReturnType<typeof pendingRoute>;
  let previous: ReturnType<typeof returnChoice>;
  let boundary: ReturnType<typeof boundaryOf>;
  try {
    boundary = boundaryOf(services, agent.id, thread);
    requested = pendingRoute(services.db, agent.id, task?.id, (taskId) => finished(services, taskId));
    previous = returnChoice(services.runs.list(agent.id, RETURN_WINDOW), requested, { on: boundary.on?.modelId });
  } catch (error) {
    if (trace) services.subconscious.putBack?.(agent.id, thread, trace);
    throw error;
  }
  return {
    agent, mode, task, conversationId, ...(origin ? { origin } : {}), thread,
    memberCursor, callId, focus, ...(trace ? { trace } : {}), previous, boundary: boundary.at, ...(requested?.temperature !== undefined ? { temperature: requested.temperature } : {}),
    ...(requested?.stepAt !== undefined ? { nextStepAt: requested.stepAt } : {}),
    ...(requested?.modelAt !== undefined && (boundary.at || requested.now) ? { nextModelAt: requested.modelAt } : {}), needsVision,
  };
}

/**
 * What the subconscious shows this turn (runAttempt journals its calls: the run does not exist yet here); nothing when it has nothing or fails.
 * A stop (the emergency stop, a chat's stop) does not wait for its look: the turn ends now, what the look still hands over waits for the thread's next turn.
 */
async function subconsciousTrace(services: RuntimeServices, signal: AbortSignal, input: Parameters<NonNullable<RuntimeServices['subconscious']['beforeTurn']>>[0]): Promise<SubconsciousTrace | undefined> {
  try {
    if (signal.aborted) return undefined;
    const look = Promise.resolve(services.subconscious.beforeTurn?.(input));
    const stopped = new Promise<'stopped'>((resolve) => signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
    const trace = await Promise.race([look, stopped]);
    if (trace === 'stopped') {
      look.then((late) => { if (hasTrace(late)) services.subconscious.putBack?.(input.agent.id, input.thread, late); }).catch((error) => services.log.warn('the subconscious before the turn failed', { agentId: input.agent.id, error: String(error) }));
      return undefined;
    }
    return trace ?? undefined; // an empty one is kept too: it carries the turn's hints back if the turn never reaches its engine (service.ts putBack)
  } catch (error) {
    services.log.warn('the subconscious before the turn failed', { agentId: input.agent.id, error: String(error) });
    return undefined;
  }
}

/** RT2: a task's model.set request ends with the task (done, cancelled or gone). */
function finished(services: RuntimeServices, taskId: string): boolean {
  const status = services.tasks.get(taskId)?.status;
  return !status || status === 'done' || status === 'dropped';
}

/** Ends the human's pause for this turn of the owner; the task as it is now. */
function resumed(services: RuntimeServices, task: TaskView, agentId: string): TaskView {
  try { return services.tasks.resume?.(task.id, agentId) ?? task; } catch (error) {
    services.log.warn('resuming a paused task failed', { taskId: task.id, error: String(error) });
    return task;
  }
}

/** True when routing failed only because no connected model can read images. */
export function visionUnavailable(error: unknown): boolean {
  return error instanceof WorkforceError && error.code === 'unavailable' && error.details?.need === 'vision';
}

/** The same turn without image input; buildTurn then tells the agent it cannot see them. */
export function withoutImages(plan: TurnPlan): TurnPlan {
  return { ...plan, needsVision: false, imagesHidden: true };
}

/** Told to the agent instead of the images (they stay listed by name and stored path). */
export const IMAGES_HIDDEN_NOTE = 'I cannot see the images in this chat right now: no connected model can read images. They are listed by name and stored path. I use a saved description (media.search) when there is one, and say so when I would need to see an image.';

export function routeRequest(plan: TurnPlan, exclude?: string[]): RouteRequest {
  return {
    agent: plan.agent, conversationId: plan.conversationId, taskId: plan.task?.id, mode: plan.mode, text: plan.focus,
    previous: plan.previous, ...(plan.boundary !== undefined ? { boundary: plan.boundary } : {}), exclude, needs: plan.needsVision ? { vision: true } : undefined,
    ...splitRoute(plan), // B-057 S10: a split's own model choice (routing/split-route.ts)
  };
}

/**
 * Each note under the one label (note-label.ts) with its own subject: the turn's task (a reminder about a quest or to-do
 * names it), else my schedule for a schedule's note. `snapshot` – the task's quest as it stands now – follows the last
 * schedule's note (a reminder's), in the note's own text – buildTurn gives it when this turn's live block leaves the
 * quest's "## Current quest" out (a resumed session whose section did not change; FIXREAL 5), so it comes once.
 */
export function noteLines(request: Pick<TurnRequest, 'reason' | 'notes' | 'origin'>, timezone: string | undefined, task?: Pick<TaskView, 'id' | 'title'>, scheduleTitle?: string, snapshot?: string): string[] {
  const id = request.origin?.source.startsWith('schedule:') ? request.origin.source.slice('schedule:'.length) : undefined;
  const schedule = scheduleSubject(id, scheduleTitle);
  const reminder = task && snapshot ? request.notes.findLastIndex((note) => (note.reason ?? request.reason) === 'schedule') : -1;
  return request.notes.map((note, index) => {
    const subject = task ? taskSubject(task) : (note.reason ?? request.reason) === 'schedule' ? schedule : undefined;
    return `${noteLabel(note.at, timezone, subject)} ${note.text}${index === reminder ? `\n${snapshot}` : ''}`;
  });
}

/** The title of the schedule a wake came from ('' when it is gone or the wake is not a schedule's). */
function scheduleTitleOf(services: RuntimeServices, origin: TurnRequest['origin']): string | undefined {
  if (!origin?.source.startsWith('schedule:')) return undefined;
  try { return services.scheduler.get(origin.source.slice('schedule:'.length))?.title; } catch { return undefined; }
}

/**
 * PR3: the tool calls of unfinished attempts (also this run's, after a failover) when the engine
 * that runs now cannot know them – a new session, another engine or account, or no sessions at all.
 */
function previousAttempt(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, now: Parameters<typeof needsRecap>[1], timezone: string | undefined): string | undefined {
  try {
    const actions = recentActions(services, recapScope(plan), request.runId);
    if (!needsRecap(actions, now)) return undefined;
    services.runs.item(request.runId, { kind: 'note', data: { previousAttempt: actions.length }, effectStatus: 'none' });
    return recapText(actions, timezone);
  } catch (error) {
    services.log.warn('previous attempt recap failed', { agentId: plan.agent.id, error: String(error) });
    return undefined;
  }
}

/**
 * The calls the engine shows this turn: the subconscious's; for a history that starts from the projection the call naming what is
 * marked there; and – a stateless engine holds nothing between turns – the subconscious's earlier calls, as a CLI session holds them.
 */
function turnTrace(services: RuntimeServices, plan: TurnPlan, session: SessionBinding | undefined, engine: Engine, runId: string): SubconsciousTrace | undefined {
  const marks = !session ? marksCall(marksOf(services, plan.agent.id, plan.thread)) : undefined;
  const earlier = !engine.caps.sessions ? carriedCalls(services, plan.agent.id, plan.thread, runId) : [];
  const calls = [...(marks ? [marks] : []), ...earlier, ...(plan.trace?.calls ?? [])];
  return calls.length ? { calls } : undefined;
}

/** One input item as last-prompt.md shows it: text as it is, an image by its path. */
function inputLine(item: RoutedTurn['input'][number]): string {
  return item.type === 'text' ? item.text : `[image: ${item.path}]`;
}

/** Resolves engine/account/model for a route, then prompt, tool offer, session and turn input. */
export async function buildTurn(services: RuntimeServices, plan: TurnPlan, request: TurnRequest, route: RouteDecision, repairNotes: string[]): Promise<RoutedTurn> {
  const engine = services.engines.get(route.engine);
  const account = services.accounts.get(route.accountId);
  if (!account) throw new WorkforceError('unavailable', 'The chosen account is not available.');
  const info = services.catalog.get(route.modelId);
  const model = info?.model ?? route.modelId.slice(route.modelId.indexOf(':') + 1);
  const promptInput = { agent: plan.agent, conversationId: plan.conversationId, taskId: plan.task?.id, thread: plan.thread, mode: plan.mode, route };
  let prompt = services.context.prompt(promptInput);
  let offer = offeredTools(services, plan, engine.caps); // B-049 F4: may grow by learned tools below (fresh session only); a part gets its agent's, like its parent
  let key = promptKey(prompt.stable, offer.names);
  // B-057: a split's seeded session starts with this turn's prompt (its volatile part as below).
  // B-049 F4 (TOOLS-CORE), KI-Runde 17.11.2026: tools this agent ran through tools.call join its offer whenever its session
  // starts anew – a fresh one (new, renewed, dropped, stateless engine) or a rebuilt one, which asks here once it is certain
  // to run – never in a resumed one (tools/learned.ts); never for a split (B-057).
  const anew = () => {
    if (!plan.split && promoteLearned(services, plan.agent.id)) {
      prompt = services.context.prompt(promptInput); // its "More tools" list no longer names what became direct
      offer = offeredTools(services, plan, engine.caps);
      key = promptKey(prompt.stable, offer.names);
    }
    return { offer, prompt: { stable: prompt.stable, volatile: prompt.volatile }, promptKey: key };
  };
  const native: SeedContext = { account, model, offer, prompt: { stable: prompt.stable, volatile: prompt.volatile }, anew };
  // The first turn after my mode changed says so (the binding keeps the mode of its last turn).
  const bound = engine.caps.sessions ? new SessionStore(services.db).get(plan.agent.id, plan.thread, engine.id) : undefined;
  const note = bound?.mode && bound.mode !== plan.mode.key ? modeChangeNote(services, bound.mode, plan.mode) : undefined;
  const { session, contextWindow, sinceSeq, seeded: rebuilt, prefix } = await chooseSession(services, plan, request, engine, account.id, route, info?.caps.contextTokens, key, native);
  if (!session && !rebuilt) anew(); // a fresh session takes my learned tools here; a rebuilt one took them as it was built
  // S2 (session-key.ts): a resumed session runs on the system text and tools it started with – its "More tools" counted
  // against those – and gets its changed stable sections below; a session that starts now records what it starts with.
  // A revert rebuilds the thread the session already holds (rebuild.ts, Codex), and a native fork part runs on its parent's
  // start (split-turn.ts seedSplit records it on the part's thread): both keep the start they run on, like a resume.
  const revert = Boolean(rebuilt && session && bound && session.ref === bound.ref);
  const forked = Boolean(plan.split && rebuilt && session && startOf(services.db, { agentId: plan.agent.id, thread: plan.thread, engine: engine.id }, session.promptKey));
  const resumed = session && (!rebuilt || revert || forked) ? session : undefined;
  const heldKey = revert ? bound?.promptKey : resumed?.promptKey; // the key the session was bound with before this turn
  const start = resumed ? startOf(services.db, { agentId: plan.agent.id, thread: plan.thread, engine: engine.id }, heldKey) : undefined;
  // A session bound before the start record existed, whose prompt changed since: it gets every current section once.
  const whole = Boolean(resumed && !start && heldKey !== undefined && heldKey !== key);
  if (start && start.key !== key) {
    const own = sessionOffer(services, start);
    if (own.names.join('\n') !== offer.names.join('\n')) prompt = services.context.prompt({ ...promptInput, direct: own.names });
    offer = own;
    key = start.key;
  }
  const system = start ? start.sections.map((section) => section.text).join('\n\n') : prompt.stable;
  // What a session that starts (or is accepted) this turn holds – recorded where its binding is saved, once it exists (turn-finish.ts).
  const sessionStart = !start && engine.caps.sessions && prompt.stableSections
    ? { key, native: offer.native.map((tool) => tool.name), hub: offer.hub, sections: prompt.stableSections } : undefined;
  if (plan.fold) { // the context fold's own turn (agents/context-fold.ts): the session as it stands, no live block, the note as its whole input
    if (!resumed) throw new WorkforceError('unavailable', 'The session to fold is not there to resume.');
    return {
      // No start is recorded here and the session keeps its own key: the fold sends no changed lines, so a session without a
      // record gets them on its next turn.
      route, engine, account, model, modelName: info?.name ?? model, contextWindow, session: resumed, prompt: { ...prompt, stable: system, volatile: '' }, tools: offer.native, hubTools: offer.hub,
      promptKey: start ? key : heldKey ?? key,
      input: [{ type: 'text', text: `${noteLabel(services.clock.now(), services.settings.get().profile.timezone)} ${foldNote(resumed.contextTokens)}` }], lastSeq: plan.memberCursor,
    };
  }

  let delta: DeltaResult = { text: '', images: [], lastSeq: 0 };
  if (plan.conversationId) {
    // Freshly attached PDFs/text files are extracted first, so the delta carries their text.
    try { await services.context.prepare?.({ agentId: plan.agent.id, conversationId: plan.conversationId, sinceSeq }); } catch (error) {
      services.log.warn('attachment extraction failed; the delta only names the files', { agentId: plan.agent.id, error: String(error) });
    }
    const query: DeltaInput = { agent: plan.agent, conversationId: plan.conversationId, sinceSeq };
    delta = services.context.delta(query);
  }
  // No session holds my context (a rebuild that could not run, a session-less engine, a part not forked): my own record as text.
  const history = !session && !prefix ? historyText(services, plan.agent.id, plan.thread, Math.floor(fitLimit(contextWindow) / 2 * engineUnit(engine.id))) : undefined; // the window's tokens in the record's unit

  const timezone = services.settings.get().profile.timezone;
  // A seeded split session holds its parent's context already.
  const recap = rebuilt ? undefined : previousAttempt(services, plan, request, { engine: engine.id, accountId: account.id, sessionNew: !session, stateless: !engine.caps.sessions }, timezone);
  const cut = interruptionNote(services, plan, request, delta.lastSeq, timezone, recap);
  // The cut-off note says what the recovery wake's and the redelivery's notes say: one note, not two.
  const wakeNotes = cut ? request.notes.filter((wake) => wake.text !== INTERRUPTED_NOTE && wake.text !== REDELIVERY_NOTE) : request.notes;
  const results = splitResults(services, plan); // B-057 S6: the agent's own turn gets its settled splits' results once
  // B-049 F6: a resumed (not seeded) native session gets only the volatile sections changed since its last finished turn.
  const sentKey = { agentId: plan.agent.id, conversationId: plan.thread, engine: engine.id };
  if (rebuilt) forgetSent(services.db, sentKey); // a seeded session starts without the old record
  const sent = resumed ? sentTo(services.db, sentKey, resumed.ref) : undefined;
  const shown = prompt.sections ? volatileDelta(prompt.sections, sent?.sections) : undefined;
  // FIXREAL: a reminder's quest as it stands comes once – under its note when this turn's live block leaves its section out.
  const snapshot = plan.task && wakeNotes.some((wake) => (wake.reason ?? request.reason) === 'schedule') && !carries(prompt.sections, shown, 'task')
    ? reminderSnapshot(services, plan.task.id, plan.agent.id, displayZone(timezone)) : undefined;
  const notes = [cut, ...noteLines({ reason: request.reason, notes: wakeNotes, origin: request.origin }, timezone, plan.task, scheduleTitleOf(services, request.origin), snapshot), results?.text, ...repairNotes, note].map((line) => line && quoteHeaders(line)); // only the header lines below are headers
  const lines = [...notes, delta.text].filter((line): line is string => Boolean(line && line.trim()));
  const riders = await riderInput(services, plan, request, timezone); // Runde „Halb“ 21.11.2026: other chats due at the start, each under its chat's label
  // Nothing new arrived: said as a note, so it never reads as a person's instruction (B-047 eval: "resumed on the person's instruction").
  const now = services.clock.now();
  if (!lines.length && plan.task) lines.push(`${noteLabel(now, timezone, taskSubject(plan.task))} Nothing new arrived since my last turn; this task is ${plan.task.status}.`);
  if (!lines.length && !riders.lines.length) lines.push(`${noteLabel(now, timezone)} Nothing new arrived since my last turn.`);
  lines.push(...riders.lines);
  if (plan.imagesHidden) lines.push(IMAGES_HIDDEN_NOTE);
  // For a session that cannot know them: the agent's latest answers that stayed in its run log – right after the <live> block.
  const answers = !history && (!session || !engine.caps.sessions) ? answersRecap(services, recapScope(plan), request.runId, timezone) : undefined;
  if (answers) lines.unshift(answers);
  const record = prefix ?? history; // a part's seed or my own record: what is new follows it under its own header
  if (record) lines.unshift(record, PROJECTION.fresh);
  const input: RoutedTurn['input'] = [{ type: 'text', text: lines.join('\n\n') }];
  if (engine.caps.images && !plan.imagesHidden) input.push(...await visionInputs(services, [...delta.images, ...riders.images])); // B-058 G10: as they are, a converted copy or a media.view line
  // S2: the stable sections changed since the session's start (or since the change it last got), as changed lines first;
  // a session from before the start record counts against nothing, so every current section comes once.
  const held = start ? Object.fromEntries(start.sections.map((section) => [section.name, section.text])) : whole ? {} : undefined;
  const changed = held && prompt.stableSections ? stableDelta(prompt.stableSections, sent?.stable ?? held) : undefined;
  const volatile = [changed?.text, shown ? shown.text : prompt.volatile].filter(Boolean).join('\n\n');
  // B-066: what goes out this turn, readable; B-076: the main lane only, like last-run.md beside it.
  const dataDir = plan.split ? undefined : services.paths?.data;
  if (dataDir) writeLastPrompt(dataDir, plan.agent.id, { system, input: services.secrets.redact([contextText(volatile), ...input.map(inputLine)].filter(Boolean).join('\n\n')) }, (message, data) => services.log?.debug(message, data));

  const trace = turnTrace(services, plan, session, engine, request.runId);
  return {
    route, engine, account, model, modelName: info?.name ?? model, contextWindow, session, prompt: { ...prompt, stable: system, volatile }, tools: offer.native, hubTools: offer.hub, promptKey: key,
    ...(sessionStart ? { sessionStart } : {}),
    input, lastSeq: Math.max(delta.lastSeq, plan.memberCursor), ...(shown ? { volatileSent: { sections: shown.sections, ...(changed ? { stable: changed.stable } : {}) } } : {}), ...(trace ? { trace } : {}),
    ...(results ? { splitParts: results.splitIds } : {}), // B-057: these parts are gathered when this turn ends done
  };
}
