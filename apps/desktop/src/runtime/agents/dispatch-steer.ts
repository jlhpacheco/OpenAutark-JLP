// Steering for important messages: the chat lines a running turn has not seen yet (after
// max(control.lastSeq, control.steeredSeq)), rendered briefly and handed to engine.steer().
// Each line has the delta's form (13.11.2026: its label names chat and author – context/render.ts lineLabel) –
// "[ch_… \"Title\" · Name · HH:MM #57] (important) text", a quiet one "… · Name (quiet) · …"
// (B-050 K5, shared/model/chat.ts messageLevel), a text message about a task ending with " [task <id>]", a person's
// line naming their model suggestion in its label ("· picked … for this message" or "· earlier suggested …", F22: render.ts
// suggestionTag; it is a new line) – stamped in the person's
// zone and named by context/render.ts authorName (the person by the profile name, "(agent)" on an
// org member called like the person, "(external agent)" / "(external contact)" for 'ext:'
// members, C8) – and its body is neutralized like the delta's: no body line can start with a
// "[…] " stamp, so none can pose as another author's line.
// C6: a reply says whom it answers and the person's edit/delete notices read as in the delta
// (context/render.ts replyLine, changeNotice – none when it adds nothing).
// Lines steering cannot carry in full stop it before them (`held`; the next turn's delta brings them,
// the caller interrupts or waits): a recording that still has to be heard and lines said live (speech.live or a call
// line, meta.call: a live voice conversation waits for an answer written after its message, shared/voice/conversation.ts).
// B-080 (owner 08.11.2026: "einfach ganz normal … so wie das bei Codex oder Claude Code auch funktioniert … mittendrin …
// dann wird die Nachricht eingefügt"): a line with files is folded as the plain CLIs fold one – its file lines name each
// file with where it is stored (context/render.ts attachmentLines; the extracted text and the image input stay for a
// delta); a row still streaming – a colleague's visible answer too – is passed: it takes a new seq when it ends
// (chat/publish-message.ts), so it reaches the agent later in full (before, a visible one stopped the fold of every line after it).
// A dictated line is folded like a typed one (23.10.). steerTurn/steerOther say why a fold did not go
// through ('held', 'refused'): a refusal is tried again while the turn runs (dispatcher.ts).
// D15 relays (calls/talker.ts, through dispatcher.relay): a live voice's framed text – complete plain text, not
// a raw call line, so heldBack does not apply – goes into the running turn as it is (steerRelay); 'next' only
// on an engine whose steered text waits for the turn's next model request (LANDS_AT_NEXT_REQUEST; B-080: Claude Code
// too – a stdin line without priority is queued "next" and folded in between tool calls, live 07.11.2026 23:41). It moves no
// cursor: the call lines it speaks of reach the next turn's delta as usual. Its text is journaled, so it stands in my record.
// 07.11.2026 (owner: a normal line reaches the agent at its next step, from any chat): steerOther folds the unseen lines of
// ANOTHER chat into the agent's running main turn – 13.11.2026: one context, so they come as plain new lines (each names its
// chat). Its cursor is per chat in control.others, from the agent's read cursor there – which the fold never moves; the
// turn's done finish does (agents/turn-finish.ts: one context saw them). B-080 wave 3: hasPerson – whether a person is a
// member – lets the dispatcher run such a chat before the chats of agents only.
// Live 09.11.2026 20:33 (the owner's "Speicher dir das nicht als komische Regel" reached Konrad's turn in an unrelated
// chat as one line: another thread's done turn had moved his read cursor past the lines "das" meant, and he answered
// without them): a fold of another chat – the group frame too, the same path – also carries up to EARLIER_LINES lines of
// that chat just before the new ones, the agent's own included, under a label saying they are earlier and answered
// already; only lines this turn has not had from that chat (after its last fold there), bounded by EARLIER_BODY and
// EARLIER_CHARS. They reach up to the first new line: a done turn posts its answer before it moves the cursor
// (agents/turn-finish.ts), so the agent's own last answer sits after the cursor – the line "das" meant. Left out: this
// turn's own lines there (it wrote them) and rows with nothing to read (a stop without text); a failed or
// stopped row keeps the delta's note. They move no cursor and count in no `lines`.
// Each steered line elides a mini-app to `[mini-app "title"]` and notes a failed or stopped row, as the delta does.
// B-083 (owner 08.11.2026: Ultra is one being): steerNote hands a note between the agent's own turns – a part to its
// origin, the origin to a part, a part to another – into the running turn as it is (the frame names who speaks); like a
// relay it moves no cursor, and on a split lane too (dispatcher.ts tell).
// Owns: that rendering, the steer call, control.steeredSeq after a successful steer and control.others.
// Never: includes the agent's own lines among the new ones or other status lines, skips past a line that is held back (it must reach
// the agent later in full; a row still streaming holds no final text and is passed – its answer takes a new seq at
// the end), advances the member cursor, or shows the
// owner's Telegram line (C9) without the note the delta gives it (context/render.ts) – a steered
// line is not delivered again.

import type { RuntimeServices } from '../contracts.ts';
import { secretLines } from '../secrets/metadata.ts';
import { messageLevel, type Member, type Message } from '../../shared/model/chat.ts';

/** The frame of every fold: the lines name their chats themselves. */
export const NEW_LINES = 'New lines while I work:';
import { isHumanActor } from '../../shared/model/people.ts';
import { fromBridgeOwner } from '../../shared/model/bridges.ts';
import { renderContext } from '../context/delta.ts';
import { BRIDGE_OWNER_NOTE, suggestionTag, agentBody, attachmentLines, changeNotice, elideApps, lineIndex, lineLabel, neutralize, replyLine, stateNote, type RenderContext } from '../context/render.ts';
import { hasMarks, MARKS_LEGEND } from '../../shared/voice/marks.ts';
import { isRecording } from '../context/attachments.ts';
import { ultraNote } from '../context/split-section.ts'; // B-057 S17: a steered line that suggested Ultra keeps its note
import type { EngineId } from '../../shared/model/providers.ts';
import type { TurnControl } from './turn-types.ts';

const MAX_LINES = 50;
const MAX_BODY = 2000;
/** The earlier lines a fold of another chat carries (see the header): how many, each body's cap, the whole block's cap. */
const EARLIER_LINES = 3;
const EARLIER_BODY = 500;
const EARLIER_CHARS = 1500;
const EARLIER_SCAN = 20; // lines read back to find them among status lines
const EARLIER_HEAD = 'Earlier in that chat, already answered – the context of what is new:';
const NEW_HEAD = 'New:';

export interface SteerInput {
  /** Text for engine.steer ('' when only own/status lines were new). */
  text: string;
  /** Highest seq covered; becomes control.steeredSeq after a successful steer. */
  lastSeq: number;
  lines: number;
  /** A line after lastSeq waits for the next turn (a recording, live speech): the turn does not have every line. */
  held?: boolean;
}

/** A line steering cannot carry in full: a recording still to be heard or a live/call line (see the header); other files are named with their place. */
export function heldBack(message: Message): boolean {
  if (message.meta?.call !== undefined || message.attachments.some((file) => isRecording(file.mime))) return true;
  return message.meta?.speech?.live === true;
}

function render(ctx: RenderContext, message: Message, byId: ReadonlyMap<string, Message>, max = MAX_BODY): string {
  const raw = elideApps(agentBody(message)); // B-082: a person's hidden marks written in, a mini-app elided, as in the delta
  const body = neutralize(raw.length > max ? `${raw.slice(0, max)}…` : raw).trim();
  const state = stateNote(message);
  const level = messageLevel(message);
  const flag = level === 'important' ? '(important) ' : '';
  const task = message.kind === 'text' && message.taskId ? ` [task ${message.taskId}]` : '';
  const via = fromBridgeOwner(message) ? ` ${BRIDGE_OWNER_NOTE}` : '';
  const reply = replyLine(ctx, message, byId);
  const secrets = secretLines(ctx.services, ctx.agentId, message.meta?.secrets).join('\n');
  const files = message.attachments.length ? attachmentLines(ctx, message.attachments, undefined, false).lines.join('\n') : ''; // B-080: each file with its place
  return `${lineLabel(ctx, message, true, suggestionTag(ctx, message))} ${reply ? `${reply} ` : ''}${flag}${body}${task}${ultraNote(message)}${via}${secrets ? `\n${secrets}` : ''}${files ? `\n${files}` : ''}${state ? `\n${state}` : ''}`;
}

/** Where a fold's earlier lines start (after `after`) and the running turn whose own lines among them are left out. */
export interface EarlierFrom { after: number; runId?: string }

/**
 * Unseen lines of `conversationId` for `agentId` after `afterSeq`; undefined when nothing is new. `earlier`: with new
 * lines, the text also carries the lines of that chat after `earlier.after` up to the first new one as earlier ones (see the header).
 */
export function steerInput(
  services: RuntimeServices, agentId: string, conversationId: string, afterSeq: number, heading = NEW_LINES,
  earlier?: EarlierFrom,
): SteerInput | undefined {
  const messages = services.chats.messages(conversationId, { afterSeq, limit: MAX_LINES });
  const ctx = renderContext(services, agentId);
  const { byId, latest } = lineIndex(messages);
  let lastSeq = afterSeq;
  let held = false;
  let marked = false; // B-082: MARKS_LEGEND once when a person's line has unsure places
  let firstShown: number | undefined; // the earlier lines end just before it
  const lines: string[] = [];
  for (const message of messages) {
    const own = message.authorId === agentId;
    if (!own && message.state === 'streaming') { // no final text yet: with a line after it, its answer takes a new seq at the end (B-080: a visible row too)
      lastSeq = message.seq;
      continue;
    }
    if (!own && message.kind !== 'status' && heldBack(message)) { held = true; break; } // the next turn brings it in full
    lastSeq = message.seq;
    const notice = message.kind === 'status' ? changeNotice(ctx, message, byId, latest) : undefined;
    if (notice) { firstShown ??= message.seq; lines.push(`· ${notice}`); continue; } // C6: an edit/delete notice, as in the delta
    if (own || message.kind === 'status') continue;
    firstShown ??= message.seq;
    lines.push(render(ctx, message, byId));
    marked ||= message.authorKind === 'human' && hasMarks(agentBody(message));
  }
  if (lastSeq === afterSeq && !held) return undefined;
  // Before the first new line stand only own lines, status lines and rows still streaming: the window gains the own ones.
  const before = firstShown !== undefined && earlier ? earlierLines(services, ctx, conversationId, earlier, firstShown - 1) : undefined;
  marked ||= before?.marked === true;
  const shown = before?.lines.length ? [EARLIER_HEAD, ...before.lines, NEW_HEAD, ...lines] : lines;
  const text = lines.length ? `${heading}\n${shown.join('\n')}${marked ? `\n${MARKS_LEGEND}` : ''}` : '';
  return { text, lastSeq, lines: lines.length, ...(held ? { held } : {}) };
}

/**
 * Up to EARLIER_LINES lines written in `conversationId` in (from.after, upToSeq] – texts and answers with something to
 * read, the agent's own too except those of the turn `from.runId` – each body capped at EARLIER_BODY; the newest kept
 * first within EARLIER_CHARS (one alone longer is cut). None when they cannot be read: the new lines go without them.
 */
function earlierLines(services: RuntimeServices, ctx: RenderContext, conversationId: string, from: EarlierFrom, upToSeq: number): { lines: string[]; marked: boolean } {
  const lines: string[] = [];
  let marked = false;
  if (upToSeq <= from.after) return { lines, marked };
  const readable = (message: Message) => elideApps(agentBody(message)).trim() !== '' || message.attachments.length > 0 || Boolean(message.meta?.secrets?.length);
  try {
    const page = services.chats.messages(conversationId, { beforeSeq: upToSeq + 1, limit: EARLIER_SCAN });
    const { byId } = lineIndex(page);
    const picked = page.filter((message) => message.seq > from.after && (message.kind === 'text' || message.kind === 'answer') && message.state !== 'streaming'
      && !(from.runId && message.runId === from.runId) && readable(message));
    let used = 0;
    for (const message of picked.slice(-EARLIER_LINES).reverse()) { // the line next to the new ones stays when room runs out
      let line = render(ctx, message, byId, EARLIER_BODY);
      if (used + line.length > EARLIER_CHARS) {
        if (lines.length) break;
        line = `${line.slice(0, EARLIER_CHARS - 1)}…`;
      }
      used += line.length + 1;
      lines.unshift(line);
      marked ||= message.authorKind === 'human' && hasMarks(agentBody(message));
    }
  } catch (error) {
    services.log.info('earlier lines not read', { conversationId, error: String(error) });
    return { lines: [], marked: false };
  }
  return { lines, marked };
}

/**
 * B-080: how a fold went – 'all': the turn has every line (steered, or nothing was new); 'held': a line waits for the next
 * turn (see the header) or there is nothing to fold for this agent; 'refused': the engine did not take it now (its turn had
 * not started yet – a rebuild or a compaction before it –, or had just ended): the dispatcher tries again while the turn runs.
 */
export type SteerResult = 'all' | 'held' | 'refused';

type SteeredRun = { agentId: string; runId: string; control: TurnControl };

/** Why a running turn cannot take steered text now: 'refused' before it is bound to its engine (tried again), 'held' on an engine that never steers (ACP: the next turn). */
function cannotSteer(run: SteeredRun): SteerResult | undefined {
  if (!run.control.engine) return 'refused';
  return run.control.engine.steer ? undefined : 'held';
}

/** Hands `text` to the running turn's engine and journals `note` as a run note (best effort); 'refused' when the engine did not take it or the turn ended meanwhile. */
async function push(services: RuntimeServices, run: SteeredRun, text: string, note: Record<string, unknown>, stillRunning: () => boolean): Promise<'all' | 'refused'> {
  let ok = false;
  try { ok = await run.control.engine!.steer!(run.runId, text); } catch (error) {
    services.log.info('steer failed', { agentId: run.agentId, error: String(error) });
  }
  if (!ok || !stillRunning()) return 'refused';
  try { services.runs.item(run.runId, { kind: 'note', data: note, effectStatus: 'none' }); } catch { /* audit is best effort */ }
  return 'all';
}

/**
 * Steers the unseen lines of `conversationId` into a running turn: 'all' when the turn now has every line (steered, or
 * nothing was new). Advances `control.steeredSeq` only after a successful steer, and never past a held-back line.
 */
export async function steerTurn(services: RuntimeServices, run: SteeredRun, conversationId: string, stillRunning: () => boolean): Promise<SteerResult> {
  const not = cannotSteer(run);
  if (not) return not;
  const from = Math.max(run.control.lastSeq, run.control.steeredSeq);
  let input: SteerInput | undefined;
  try { input = steerInput(services, run.agentId, conversationId, from); } catch (error) {
    services.log.warn('steer input failed', { agentId: run.agentId, error: String(error) });
    return 'refused';
  }
  if (!input) return 'all'; // the running turn already has every line
  if (input.text && await push(services, run, input.text, { steered: { lines: input.lines, upToSeq: input.lastSeq, fromSeq: from } }, stillRunning) === 'refused') return 'refused';
  run.control.steeredSeq = Math.max(run.control.steeredSeq, input.lastSeq);
  return input.held ? 'held' : 'all';
}

/** The running main turn as steerOther sees it (dispatch-runs.ts RunEntry). */
export interface RunningWork {
  agentId: string;
  runId: string;
  control: TurnControl;
  conversationId?: string;
  taskId?: string;
  origin?: { label: string };
}

/**
 * Folds the unseen lines of `conversationId` – not the running turn's chat – into the agent's running main turn (see the
 * header): 'all' when the turn now has every line there; 'held' also when the agent is no member there (the chat's wake
 * runs it right after this turn). Never moves the agent's read cursor there – B-080: the turn's done finish does, for a
 * chat it answered (agents/turn-finish.ts).
 */
export async function steerOther(services: RuntimeServices, run: RunningWork, conversationId: string, stillRunning: () => boolean): Promise<SteerResult> {
  const not = cannotSteer(run);
  if (not) return not;
  const others = (run.control.others ??= new Map());
  let input: SteerInput | undefined;
  let from = 0;
  try {
    const member = services.chats.members(conversationId).find((item) => item.memberId === run.agentId && !item.leftAt);
    if (!member) return 'held';
    const folded = others.get(conversationId)?.seq ?? 0; // where this turn's folds of that chat reached (0: none yet); earlier lines start after it
    from = Math.max(member.readSeq, folded);
    input = steerInput(services, run.agentId, conversationId, from, NEW_LINES, { after: folded, runId: run.runId });
  } catch (error) {
    services.log.warn('steer input of another chat failed', { agentId: run.agentId, conversationId, error: String(error) });
    return 'refused';
  }
  if (!input) return 'all'; // nothing new there: the turn has every line
  if (input.text && await push(services, run, input.text, { steered: { lines: input.lines, upToSeq: input.lastSeq, fromSeq: from, conversationId } }, stillRunning) === 'refused') return 'refused';
  const seen = others.get(conversationId);
  others.set(conversationId, { ...seen, seq: Math.max(seen?.seq ?? 0, input.lastSeq) });
  return input.held ? 'held' : 'all';
}

/** Whether a person is an active member: the owner, a person of the organisation, a bridged contact (a member of kind 'human' or a human actor). */
const personIn = (members: readonly Member[]): boolean => members.some((member) => !member.leftAt && (member.kind === 'human' || isHumanActor(member.memberId)));

/** B-080 wave 3: whether a person waits in that chat – whose chat runs first after the turn (dispatcher addPick). */
export function hasPerson(services: Pick<RuntimeServices, 'chats'>, conversationId: string): boolean {
  try { return personIn(services.chats.members(conversationId)); } catch { return false; }
}

/**
 * B-083: a note of the agent to itself (agents.split_tell) into the running turn `run` – a main lane's or a split lane's –
 * read at its next step; journaled as a run note. 'refused': its engine did not take it now (its turn had not started, or
 * just ended – the dispatcher tries again while it runs); 'held': an engine that never steers.
 */
export async function steerNote(services: RuntimeServices, run: SteeredRun, text: string, stillRunning: () => boolean): Promise<SteerResult> {
  return cannotSteer(run) ?? push(services, run, text, { told: { chars: text.length } }, stillRunning);
}

/** Engines whose steered text waits for the running turn's next model request (Codex turn/steer, Claude Code's queued stdin line, the HTTP loop) – a soft 'next' relay. */
export const LANDS_AT_NEXT_REQUEST: ReadonlySet<EngineId> = new Set<EngineId>(['codex', 'claude', 'openai', 'anthropic', 'compatible']);

/**
 * D15: a live voice's relay text into the running turn (calls/talker.ts). 'now': any engine that steers;
 * 'next': only one of LANDS_AT_NEXT_REQUEST. True when the turn took it and still runs (journaled as a run
 * note); false = not steered (the caller interrupts, digests or wakes). Never moves a cursor.
 */
export async function steerRelay(services: RuntimeServices, run: SteeredRun, text: string, mode: 'now' | 'next', stillRunning: () => boolean): Promise<boolean> {
  const engine = run.control.engine;
  if (!engine?.steer || !text.trim()) return false;
  if (mode === 'next' && !LANDS_AT_NEXT_REQUEST.has(engine.id)) return false;
  // journaled with its text: the ledger keeps it in my record, so a failover, rebuild or fold still has it (context/ledger/capture.ts)
  return await push(services, run, text, { relayed: { mode, chars: text.length }, text }, stillRunning) === 'all';
}
