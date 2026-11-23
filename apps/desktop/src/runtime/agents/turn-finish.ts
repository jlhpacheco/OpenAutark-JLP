// Turn phase 3 – integrate the result: save the native session (with its prompt key and mode, SES2; F6: after a finished turn
// the volatile sections it then holds – none after an engine compaction –, volatile-delta.ts), post what has to be posted at
// the end, advance the agent's read cursors (the wake's chat – B-050 round 4: also over what the turn's chat.read showed of it,
// chat/turn-reads.ts –, and every chat whose lines were folded into the turn: one context saw them), record the cost, run the
// ownership loop and close
// the run. Cost (PR9, agents/turn-cost.ts): only a paid account's real charge is the run's costUsd and the agent's spend; a
// plan turn keeps its notional list-price cost as notionalUsd, a paid turn without a price is 'unpriced'.
// 13.11.2026 (owner: output only where addressed): the turn's <chat> blocks were posted by its outbox as they came
// (agents/chat-out.ts; turn.ts hands it the final text before this phase). What posts here: a call turn's answer – the final
// text outside blocks plus the blocks to the call's chat (the outbox held them, mid-turn ones too) – spoken and posted in the call's chat (a call that ended during the
// turn, or a turn that did not end done: those blocks as a normal line there); engine files (generated
// images) beside it or into the wake's chat; and one safety net – a person's line woke the turn (its input or a line folded
// in) and the turn addressed nothing at all: its final text outside blocks goes as a normal message into the chat of that
// person's newest line, counted by log.info('unaddressed answer posted') – only a line delivery gave this agent as its own
// (chat/addressed.ts; 15.11.2026 privacy fix: a colleague given a task in the person's chat had posted its closing text
// there). Every final text (and a failed or stopped turn's partial text) is journaled as the run item 'Answer' (visibility
// 'internal' when nothing of it reached a chat).
// A turn the person stopped posts what it had written as a 'stopped' message (nothing when it wrote nothing); B-080: every
// other interrupt (an important line, a shutdown) posts nothing, also with partial text – it stays in the run journal.
// Ownership outcome of a task turn: a human Stop → 'stopped' (the task pauses, no retry); an important message or shutdown
// → 'interrupted' (not a stall); any other interrupt → 'failed'; an account limit → 'limit'; an engine error that is no model
// failure (code 'unavailable': signed out, connection lost, a CLI that could not start; 'cancelled') → 'unavailable' (not a
// stall either; errorOutcome is shared with turns that fail before the engine, agents/turn.ts).
// A task turn that only met an outage leaves no failed bubble – one quiet line per outage instead (agents/outage-line.ts); a
// chat turn without a task that met one is noted for an automatic re-delivery (B-044, redelivery.ts; B-059 C9: a usage limit
// too) – B-080 wave 3: one quiet Paused line on its first attempt, no red bubble; partial text or files keep the bubble, and
// every failure nothing retries by itself keeps its bubble and Retry (a chat turn's; a task turn's failure stays in the run
// journal). B-083: the retry gets the engine error without its retry hint (accounts/failure.ts holds the cooling).
// The native session, its turn record, the volatile-delta record and the repair notes (invalid ```ui blocks, blocks to a chat
// I am no member of) are keyed by the turn's thread. An interrupted run keeps why it was cut (its abort reason) as its error.
// B-057 S9: a split's turn (plan.split) has no cursor, outage lines or ownership, no compaction pass; kept: its session under
// `split:<id>`, the journal with its 'Answer', the cost on its parent agent; then the split service hears how it ended
// (split-turn.ts). Unterbewusstsein v1 (14.11.2026): nothing of the subconscious runs after a turn.
// B-083: the run names what the turn really ended on – its route after an in-turn switch – and its temperature; B-089: its
// cached input, model calls and where the effort came from.
// KI-Runde 17.11.2026 (the context fold, agents/context-fold.ts): a main-lane turn that ended done says in its outcome when its
// session calls for a fold (wantsFold – the dispatcher starts it); a fold's own turn that ended done leaves its closing text as
// the hand-over in the ledger instead of an 'Answer' (endFold) – it has no chat, so nothing of it is posted – and writes no
// last-run.md (that file stays the agent's last piece of work); one that was cut or failed leaves its partial text as a plain
// note, never as my words, and its session's next turn hears that nothing was folded (FOLD_CUT_NOTE).
// Owns: those end-of-turn posts, repair notes, run status and outcome mapping.
// Never: advances the cursor for failed/stopped turns (their input is delivered again), counts account limits,
// sign-in/connection problems or user interrupts as model failures, lets a block that cannot become a to-do fail the turn
// (logged), books a plan's notional cost as spend, or blocks the turn on the subconscious or a compaction.

import type { RuntimeServices } from '../contracts.ts';
import type { EngineTurnResult } from '../engines/types.ts';
import type { WorkforceErrorData } from '../../shared/errors.ts';
import type { AnswerVisibility, Message } from '../../shared/model/chat.ts';
import { shownTemperature, type RunStatus } from '../../shared/model/runs.ts';
import { repairNotesOf } from '../../shared/blocks/parse.ts';
import { takeTurnRead } from '../chat/turn-reads.ts';
import { awaitsAnswer, journalAnswer } from './publishing.ts';
import { addressedSeqs } from '../chat/addressed.ts';
import { chatBlocks, todos, type ChatOutbox } from './chat-out.ts';
import { answeredAlready, MIMICKED_NOTE, onlyCallRecords } from './net-repeat.ts';
import { isOutage } from './outages.ts';
import { outageLine, pausedLine } from './outage-line.ts';
import { noteChatOutage } from './redelivery.ts';
import { SessionStore } from './sessions.ts';
import { recordTurn } from './native-turns.ts';
import { recordStart } from './session-key.ts'; // S2
import { callRunning } from '../calls/call-log.ts'; // KI-Runde 17.11.2026: a call turn's answer is spoken only while its call runs
import { forgetSent, recordSent } from './volatile-delta.ts'; // B-049 F6
import { bookTurnCost, priceTurn, runTokens, saveRunCost } from './turn-cost.ts';
import { effectful, type AttemptResult, type RoutedTurn, type StopKind, type TurnOutcome, type TurnPlan, type TurnRequest } from './turn-types.ts';
import { splitTurnEnded } from './split-turn.ts'; // B-057
import { endFold, FOLD_CUT_NOTE, wantsFold } from './context-fold.ts'; // KI-Runde 17.11.2026
import { writeLastRun } from '../context/last-run.ts'; // B-076
import { sendsTemperature, turnTemperature } from './turn-attempt.ts'; // B-083

const REPAIR_NS = 'repair_notes';
import { KvRepo } from '../store/kv.ts';

/** Repair notes (invalid ```ui blocks, blocks that were not posted) are handed to the agent's next turn on that thread (no extra turn). */
export function takeRepairNotes(services: RuntimeServices, agentId: string, thread: string | undefined): string[] {
  const key = `${agentId}:${thread ?? ''}`;
  const kv = new KvRepo(services.db);
  const notes = kv.get<string[]>(REPAIR_NS, key);
  if (notes === undefined) return [];
  kv.delete(REPAIR_NS, key);
  return Array.isArray(notes) ? notes : [];
}

/** Adds to the notes already waiting (the posted messages' file notes, media/outputs.ts saveOutputNotes, use the same row); the newest six stay. */
export function saveRepairNotes(services: RuntimeServices, agentId: string, thread: string | undefined, notes: string[]): void {
  if (!notes.length) return;
  const key = `${agentId}:${thread ?? ''}`;
  const kv = new KvRepo(services.db);
  const held = kv.get<string[]>(REPAIR_NS, key);
  const waiting = Array.isArray(held) ? held : [];
  kv.set(REPAIR_NS, key, [...new Set([...waiting.filter((note) => !notes.includes(note)), ...notes])].slice(-6), services.clock.now());
}

function runStatus(stop: string): RunStatus {
  if (stop === 'done') return 'done';
  if (stop === 'interrupted') return 'interrupted';
  return 'failed';
}

/** Sign-in/connection problems and stops: conditions of the account or engine, not of the model. */
const OUTAGE: ReadonlySet<string> = new Set(['unavailable', 'cancelled']);

type TaskOutcome = Parameters<RuntimeServices['ownership']['afterTurn']>[0]['outcome'];

/** What an error of a task turn (in the engine or before it) means for the ownership loop. */
export function errorOutcome(error: Pick<WorkforceErrorData, 'code' | 'details'> | undefined): 'limit' | 'unavailable' | 'failed' {
  if (error?.code === 'rate_limited') return 'limit';
  // A setup the person must change (capability, tier, suitability, model policy) is a real
  // failure: the ladder escalates it to the manager or the human instead of retrying quietly.
  if (error?.details?.setup === true) return 'failed';
  return error && OUTAGE.has(error.code) ? 'unavailable' : 'failed';
}

/** What a task turn means for the ownership loop (see the header). */
export function taskOutcome(result: Pick<EngineTurnResult, 'stop' | 'error'>, status: string | undefined, stopKind: StopKind | undefined): TaskOutcome {
  if (result.stop === 'done') return status === 'waiting' ? 'waiting' : 'done';
  if (result.stop === 'limit') return 'limit';
  if (result.stop !== 'interrupted') return errorOutcome(result.error);
  if (stopKind === 'human') return 'stopped';
  return stopKind ? 'interrupted' : 'failed';
}

export function finishTurn(services: RuntimeServices, plan: TurnPlan, turn: RoutedTurn, request: TurnRequest, attempt: AttemptResult, out?: ChatOutbox): TurnOutcome {
  const { result } = attempt;
  const stop = result.stop;
  const conversationId = plan.conversationId;
  const agentId = plan.agent.id;
  const thread = plan.thread; // the session's and turn state's key
  // B-059 #74: the step count (or that it only thought); B-083: what the turn ended on, with its temperature.
  const temperature = turnTemperature(plan, turn);
  const sent = temperature !== undefined && sendsTemperature(turn);
  const meta = {
    model: turn.modelName, effort: turn.route.effort, ...(temperature !== undefined ? { temperature: shownTemperature(temperature, sent) } : {}),
    ...(attempt.toolCalls > 0 ? { steps: attempt.toolCalls } : attempt.reasoning?.trim() ? { thought: true } : {}),
  };
  let finalMessage: Message | undefined;
  // B-050 round 4: how far chat.read showed this turn its own chat completely – seen, like its input, once it ends done.
  const readTo = takeTurnRead(services, request.runId, conversationId);

  // Native session: keep it even for failed turns (the next turn resumes it with the same input).
  if (result.session && turn.engine.caps.sessions) {
    // S2: a session that was there before its start record (accepted from an older version) takes this turn's prompt as its
    // start only once a turn ran through on it, as its sent lines count; until then it keeps the key it was bound with. A session
    // rebuilt in this turn is bound with this turn's key already: it has its start whatever the turn's end.
    const unproven = turn.sessionStart !== undefined && stop !== 'done' && result.session.ref === turn.session?.ref && turn.session.promptKey !== turn.sessionStart.key;
    new SessionStore(services.db).save({
      agentId, conversationId: thread, engine: turn.engine.id, accountId: turn.account.id,
      ref: result.session.ref, generation: result.session.generation,
      cursorSeq: stop === 'done' ? Math.max(turn.lastSeq, request.control.steeredSeq, readTo) : plan.memberCursor,
      contextTokens: attempt.usage.contextTokens, model: turn.route.modelId, updatedAt: services.clock.now(),
      promptKey: unproven ? turn.session?.promptKey ?? turn.promptKey : turn.promptKey, mode: plan.mode.key, // SES2: the prompt and tools this session runs with
    });
    // Package C: the engine's running total of this session, kept with its binding – a session bound only now had no row to keep it in.
    if (attempt.costTotal?.ref === result.session.ref) new SessionStore(services.db).setCostTotal(agentId, thread, turn.engine.id, attempt.costTotal);
    // S2: what this session holds from its start – written here, where its binding is saved, so a turn that ended without a
    // session leaves the record of the session that still stands (agents/session-key.ts).
    if (turn.sessionStart && !unproven) recordStart(services.db, { agentId, thread, engine: turn.engine.id }, turn.sessionStart, services.clock.now());
    // The run's native turn on that session (a later rebuild that only sheds work can cut before it, agents/rebuild-revert.ts).
    if (result.session.turn) recordTurn(services.db, { agentId, conversationId: thread, engine: turn.engine.id }, result.session.ref, request.runId, result.session.turn, services.clock.now());
    if (result.compacted) forgetSent(services.db, { agentId, conversationId: thread, engine: turn.engine.id }); // B-049 F6: compacted by the engine – nothing certain
    else if (stop === 'done' && turn.volatileSent) recordSent(services.db, { agentId, conversationId: thread, engine: turn.engine.id }, result.session.ref, turn.volatileSent, services.clock.now());
  }

  // What the turn said (summary, approach line): its text outside blocks, else its first block.
  const ended = chatBlocks(result.text || attempt.streamed, { final: true });
  const said = ended.rest || ended.blocks[0]?.body || '';
  const member = conversationId !== undefined && isMember(services, conversationId, agentId);
  let answer = '';
  if (stop === 'done') {
    answer = result.text || attempt.streamed;
    const { blocks, rest } = chatBlocks(answer, { final: true });
    const mimicked = onlyCallRecords(rest); // BEFUND §3: a turn that "called" a tool by writing its record ran nothing
    const cursor = Math.max(turn.lastSeq, request.control.steeredSeq);
    const files = result.files ?? []; // engine outputs (e.g. generated images) reach a chat as attachments
    services.db.tx(() => {
      // A call's answer is spoken: the text outside blocks and the blocks to the call's chat (its outbox left those out).
      // KI-Runde 17.11.2026 (decision 8.3): only while that call still runs – a call that ended during the turn hears nothing more.
      const call = plan.callId && member && conversationId && callRunning(services, conversationId, plan.callId) ? conversationId : undefined;
      const person = call || out?.addressed ? undefined : personChat(services, plan, request, cursor);
      // 17.11.2026 (agents/net-repeat.ts): not into a chat this run already answered (wf send), never a rest of replayed-call records
      const net = person && !mimicked && !answeredAlready(services, { runId: request.runId, agentId, chatId: person, body: rest }) ? person : undefined;
      if (person && !net) services.log.info('unaddressed answer kept in the run log', { agentId, runId: request.runId, conversationId: person, mimicked });
      const body = call ? [rest, toCallChat(blocks, call, out)].filter(Boolean).join('\n\n') : net ? rest : '';
      const where = call ?? net ?? (files.length && member ? conversationId : undefined);
      // Seen before the post, so the agent's own line moves its cursor along (ChatService advanceReadIfCaughtUp).
      const seen = Math.max(cursor, readTo);
      if (conversationId && member && seen > plan.memberCursor) services.chats.markRead(conversationId, agentId, seen);
      for (const [chatId, folded] of request.control.others ?? []) { // one context: lines folded in are seen
        if (chatId !== conversationId && folded.seq > 0) services.chats.markRead(chatId, agentId, folded.seq);
      }
      if (where && (body || files.length)) {
        finalMessage = services.chats.postAgentMessage(where, agentId, request.runId, {
          body, meta: { ...meta, ...(call ? { call: { id: plan.callId!, participant: `agent:${agentId}`, name: plan.agent.name } } : {}) },
          ...(!body ? { silent: true } : {}), ...(files.length ? { files } : {}),
        });
        todos(services, finalMessage);
        if (net) services.log.info('unaddressed answer posted', { agentId, runId: request.runId, conversationId: net });
      }
      // A call turn whose call ended meanwhile: what it addressed to the call's chat (its outbox left that out) is a normal line there.
      const late = plan.callId && !call && member && conversationId ? toCallChat(blocks, conversationId, out) : '';
      if (late) { const line = services.chats.postAgentMessage(conversationId!, agentId, request.runId, { body: late, meta }); todos(services, line); finalMessage ??= line; }
    });
    saveRepairNotes(services, agentId, thread, [...repairNotesOf(answer), ...(out?.notes ?? []), ...(mimicked ? [MIMICKED_NOTE] : [])]);
  } else {
    const partial = chatBlocks(attempt.streamed, { final: true }).rest;
    answer = attempt.streamed;
    const files = result.files ?? [];
    // B-044: a chat turn that met an outage – B-059 C9: or a usage limit – is delivered again once an account is usable
    // (redelivery.ts); B-080 wave 3: its attempt number there (0: not queued). B-083: without the engine's retry hint.
    const retry = !plan.task && conversationId && (stop === 'error' || stop === 'limit')
      ? noteChatOutage(services, { agentId, conversationId, runId: request.runId, cursor: plan.memberCursor, error: withoutRetryHint(result.error), toolCalls: attempt.toolCalls }) : 0;
    const outage = stop !== 'interrupted' && isOutage(stop === 'limit' ? 'limit' : errorOutcome(result.error)) && (Boolean(plan.task) || retry > 0);
    // The person's stop posts what the turn had written, marked as stopped (nothing when it wrote nothing – the live
    // bar simply ends). Other interrupts and outages without text leave nothing behind; a task turn's failure stays in
    // the run journal (an outage still gets its line).
    const stoppedByPerson = stop === 'interrupted' && request.control.stopKind === 'human';
    const shown = member && !plan.task && !plan.split;
    const goes = !files.length && (stop === 'interrupted' ? !stoppedByPerson || !partial : outage && !partial);
    // One quiet line per outage (T06): a task's by its ledger, a chat turn's on its first attempt there (B-080 wave 3).
    const pause = () => {
      const reason = stop === 'limit' ? 'a usage limit was reached' : result.error?.message;
      if (plan.task) outageLine(services, plan.task, reason, request.runId);
      else if (retry === 1 && member) pausedLine(services, conversationId!, reason, { runId: request.runId, authorId: agentId });
    };
    if (goes) {
      if (outage) pause();
    } else if (shown) {
      finalMessage = services.chats.postAgentMessage(conversationId!, agentId, request.runId, {
        ...(files.length ? { files } : {}),
        body: partial, state: stop === 'interrupted' ? 'stopped' : 'failed',
        meta: { ...meta, error: stop === 'interrupted' ? undefined : (result.error?.message ?? 'The turn failed.') },
      });
    } else if (outage) {
      pause(); // its partial text stays in the run journal, the outage still gets its line
    }
    // A call turn that did not end done: the finished blocks it addressed to the call's chat (its outbox left those out) are a normal line there.
    const late = plan.callId && member && conversationId ? toCallChat(chatBlocks(attempt.streamed, { final: true }).blocks, conversationId, out) : '';
    if (late) { const line = services.chats.postAgentMessage(conversationId!, agentId, request.runId, { body: late, meta }); todos(services, line); finalMessage ??= line; }
  }
  const visibility: AnswerVisibility = finalMessage || out?.posted.length ? 'notify' : 'internal';
  if (plan.fold) {
    endFold(services, plan, turn, request, answer, stop === 'done'); // the hand-over, and what it folds; a cut one is no answer of mine
    if (stop !== 'done' && result.session) saveRepairNotes(services, agentId, thread, [FOLD_CUT_NOTE]); // the session holds the fold note
  } else journalAnswer(services, request.runId, answer, visibility, finalMessage?.id);

  const status = runStatus(stop);
  const cost = priceTurn(services, turn, attempt, request.runId);
  saveRunCost(services, request.runId, cost.run);
  services.runs.finish(request.runId, {
    status, endedAt: services.clock.now(), engine: turn.engine.id, model: turn.route.modelId, effort: turn.route.effort,
    accountId: turn.account.id, route: { reason: turn.route.reason, by: turn.route.by, category: turn.route.category, ...(temperature !== undefined ? { temperature, temperatureSent: sent } : {}),
      ...(turn.route.effortBy ? { effortBy: turn.route.effortBy } : {}), ...(turn.route.standIn ? { standIn: true as const } : {}) }, // B-089; standIn: 17.11.2026
    inputTokens: attempt.usage.inputTokens || undefined, outputTokens: attempt.usage.outputTokens || undefined, ...runTokens(attempt), // B-089
    costUsd: cost.run.costUsd, costBasis: cost.run.basis, notionalUsd: cost.run.notionalUsd,
    // B-080 wave 3: an interrupted run keeps why (its abort reason: a shutdown, an important line, model.set now, the Stop).
    error: status === 'failed' ? (result.error?.message ?? 'The turn failed.') : status === 'interrupted' ? (request.signal.reason as Error | undefined)?.message : undefined,
    summary: summaryOf(finalMessage?.body ?? said),
  });

  // B-076: what the agent did on this turn, readable beside last-prompt.md (context/last-run.ts) – the main lane only, so the
  // two files describe the same turn (a split's parts run beside it; they stay in the run log).
  if (!plan.split && !plan.fold) try {
    writeLastRun(services.paths?.data, agentId, {
      runId: request.runId, trigger: request.reason, model: turn.route.modelId, effort: turn.route.effort, temperature, status, endedAt: services.clock.now(),
      input: turn.input.map((part) => (part.type === 'text' ? part.text : `[image: ${part.mime}]`)).join('\n\n'),
      items: services.runs.items(request.runId), finalText: finalMessage?.body ?? said,
    }, (text) => services.secrets.redact(text), (message, data) => services.log?.debug(message, data));
  } catch (error) { services.log?.debug('last run not written', { agentId, error: String(error) }); }

  bookTurnCost(services, agentId, request.runId, cost.run);

  if (plan.task) {
    const task = services.tasks.get(plan.task.id);
    const outcome = taskOutcome(result, task?.status, request.control.stopKind);
    // Progress: the task moved (status or result) or a call did something (turn-types.ts effectful).
    const used = attempt.tools ?? [];
    const moved = task !== undefined && (task.status !== plan.task.status || JSON.stringify(task.result ?? null) !== JSON.stringify(plan.task.result ?? null));
    const names = [...new Set(used.filter(effectful).map((use) => use.name))];
    const approach = [summaryOf(finalMessage?.body ?? said)?.trim(), names.length ? `used ${names.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined;
    try {
      services.ownership.afterTurn({
        agentId, taskId: plan.task.id, runId: request.runId, outcome,
        progressed: moved || used.some(effectful), note: result.error?.message, approach, plan: attempt.plan,
      });
    } catch (error) {
      services.log.warn('ownership.afterTurn failed', { taskId: plan.task.id, error: String(error) });
    }
  }

  splitTurnEnded(services, plan, turn, request, attempt, status); // B-057: a split's end → the split service; the agent's own turn starts / gathers its groups
  const fold = wantsFold(services, plan, turn, attempt); // the session as this turn left it calls for a fold
  return { runId: request.runId, status, messageId: finalMessage?.id, error: status === 'failed' ? result.error?.message : undefined, ...(fold ? { fold } : {}) };
}

/** B-083: the engine error for the chat retry, without its retry hint (the account's cooling holds it, accounts/failure.ts). */
function withoutRetryHint(error: WorkforceErrorData | undefined): WorkforceErrorData | undefined {
  if (!error || error.retryAfterMs === undefined) return error;
  const { retryAfterMs: _hint, ...rest } = error;
  return rest;
}

function isMember(services: RuntimeServices, conversationId: string, agentId: string): boolean {
  try { return services.chats.members(conversationId).some((item) => item.memberId === agentId && !item.leftAt); } catch { return false; }
}

/**
 * The safety net's chat: where the newest person's line this turn received stands – a new line of its wake's chat
 * (memberCursor, cursor] – every unseen one when the input moved no cursor – or one folded in from another chat – when the
 * agent is a member there; undefined: none. Only a line delivery gave this agent as its own counts (chat/addressed.ts):
 * one it merely read – to the manager before it joined, to another responder, to a colleague – never makes its text public.
 */
export function personChat(services: RuntimeServices, plan: Pick<TurnPlan, 'agent' | 'conversationId' | 'memberCursor'>, request: Pick<TurnRequest, 'control'>, cursor: number): string | undefined {
  const agentId = plan.agent.id;
  const ranges: Array<[string, number, number]> = plan.conversationId ? [[plan.conversationId, plan.memberCursor, cursor > plan.memberCursor ? cursor : Infinity]] : [];
  for (const [chatId, folded] of request.control.others ?? []) {
    if (chatId === plan.conversationId || folded.seq <= 0) continue;
    const from = services.chats.members(chatId).find((member) => member.memberId === agentId && !member.leftAt)?.readSeq ?? 0;
    ranges.push([chatId, from, folded.seq]);
  }
  let newest: { chatId: string; at: number } | undefined;
  for (const [chatId, from, to] of ranges) {
    if (to <= from || !isMember(services, chatId, agentId)) continue;
    const own = addressedSeqs(services, agentId, chatId);
    const line = services.chats.messages(chatId, { afterSeq: from, limit: 200 }).filter((message) => message.seq <= to && own.has(message.seq) && awaitsAnswer(message, agentId)).at(-1);
    if (line && (!newest || line.createdAt >= newest.at)) newest = { chatId, at: line.createdAt }; // a tie: the line folded in later
  }
  return newest?.chatId;
}

function summaryOf(text: string | undefined): string | undefined {
  const line = (text ?? '').split('\n').map((item) => item.trim()).find((item) => item && !item.startsWith('```'));
  return line ? (line.length > 140 ? `${line.slice(0, 140)}…` : line) : undefined;
}

/** The blocks a turn addressed to `chat` – those its outbox held (mid-turn ones too) and those of `blocks` –, each once, as one line ('' when none). */
function toCallChat(blocks: Array<{ to: string[]; body: string }>, chat: string, out?: ChatOutbox): string {
  const bodies = [...(out?.held ?? []), ...blocks].filter((block) => block.to.includes(chat)).map((block) => block.body).filter(Boolean);
  return [...new Set(bodies)].join('\n\n');
}
