// The chat header's live line texts (ChatHeader.tsx, LiveLine.tsx): who works in this chat and what,
// from the chat's live bar – its work as the summary lists it (liveRuns: ConversationSummary.live, runtime/chat/live.ts;
// a split part carries `split`, so a group folds into one entry), the same in every window and on the phone (a bare tool name reads as what the agent does, format.ts workNote), in
// three lengths for the sub line's widths (chat.css) – the full line, a narrow window's line and a
// phone's line. A width picks the length, never a state, so a call starting never changes the text.
// 20.11.2026: the line opens the chat's live bar lines (LiveBar.tsx, the one place with steps, Stop and task); a live run's
// model line ("Opus 5.5 · High", modelLine – the short model name) is the bar line's title and the live block's byline.
// B-083: the turn's temperature follows it when it has one ("Opus 5.5 · High · T 0.3", withTemperature) – "T ≈0.3" with a
// title where the model samples at its own setting and the value is carried as the agent's stance.
// 22.11.2026: a context fold's run says "Folding its context" instead of its step (doingOf; its steps stay in the ▾ list).
// F20/F21: which run a live bar line's Stop ends (barStopRun). 20.11.2026: the bar keeps its height for a click inside
// its open lines (keptHeight) – the bar grows upward from the composer, so whatever opened there moved the rows above it.
// Owns: the texts, those Stop rules and when the bar keeps its height. Never: markup, widths or a name or model the rows do not give.

import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { Effort } from '../../shared/model/providers.ts';
import { STANCE_MARK, shownTemperature, type AgentActivity } from '../../shared/model/runs.ts';
import { workNote } from '../lib/format.ts';

/** One activity entry: an agent running somewhere, with its live note (B-057: `split` on a split's run). */
export type LiveEntry = { agentId: string; conversationId?: string; note: string; split?: { groupId: string; of: number } };
type Chat = Pick<ConversationSummary, 'id' | 'working'>;
type NameOf = (id: string) => string | undefined;

/** What a context fold's line says instead of its step (22.11.2026: the fold belongs in the bar, with a status that says so). */
export const FOLD_TEXT = 'Folding its context';

/** What a live run does now: a fold says so, else its step, else its note. */
export function doingOf(run: { step?: string; note?: string; fold?: true }): string | undefined {
  return run.fold ? FOLD_TEXT : run.step ?? run.note;
}

/** The chat's live bar as activity entries (the summary's `live`: what it does now (doingOf), model · effort, task, part, start). */
export function liveRuns(chat: Pick<ConversationSummary, 'id' | 'live'>): AgentActivity[] {
  return (chat.live ?? []).map((run) => ({
    agentId: run.agentId, runId: run.runId, conversationId: chat.id, note: doingOf(run) ?? '', startedAt: run.startedAt,
    ...(run.model ? { modelName: run.model } : {}), ...(isEffort(run.effort) ? { effort: run.effort } : {}), ...(run.taskId ? { taskId: run.taskId } : {}),
    ...(run.temperature !== undefined ? { temperature: run.temperature, temperatureSent: run.temperatureSent === true } : {}), ...(run.split ? { split: run.split } : {}),
  }));
}

/** A sentence's first letter in upper case ("running a command" → "Running a command"). */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** After a name and a colon a step reads on in lower case ("Running npm test" → "running npm test"; "PDF…" stays). */
const onward = (text: string) => text.replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase());

/** B-057: a split group's running parts as one note, "3 of 5 parts working" (splits/split-text.ts says the same). */
export function partsWorking(running: number, total: number): string {
  return `${running} of ${total} ${total === 1 ? 'part' : 'parts'} working`;
}

/** This chat's entries; a split group's runs are one entry (B-057: one line per group, never one per split). */
const here = (chat: Chat, entries: ReadonlyArray<LiveEntry>): LiveEntry[] => {
  const out: LiveEntry[] = [];
  const groups = new Map<string, { entry: LiveEntry; running: number }>();
  for (const entry of entries) {
    if (entry.conversationId !== chat.id) continue;
    if (!entry.split) { out.push(entry); continue; }
    const known = groups.get(entry.split.groupId);
    if (known) { known.running++; known.entry.note = partsWorking(known.running, entry.split.of); continue; }
    const folded: LiveEntry = { agentId: entry.agentId, conversationId: entry.conversationId, note: partsWorking(1, entry.split.of) };
    groups.set(entry.split.groupId, { entry: folded, running: 1 });
    out.push(folded);
  }
  return out;
};
/** Who works in this chat in the live line's order: its activity entries, then agents the chat's summary marks
 *  working without one – Home's "Chats that matter" names them the same way (C3 fix: one source for who works). */
export function workingIds(chat: Chat, entries: ReadonlyArray<LiveEntry>): string[] {
  return [...new Set([...here(chat, entries).map((entry) => entry.agentId), ...chat.working])];
}
/** "Ava, Mira +1" */
const names = (ids: readonly string[], nameOf: NameOf) => {
  const list = ids.map((id) => nameOf(id) ?? 'Agent');
  return list.slice(0, 2).join(', ') + (list.length > 2 ? ` +${list.length - 2}` : '');
};

/**
 * The full line: "Mira: cutting intro, Ava: running a command +1". In a 1:1 the avatar and the name
 * already say who: its agent's line is only what it does ("Running a command").
 */
export function liveStatus(chat: Chat, solo: string | undefined, entries: ReadonlyArray<LiveEntry>, nameOf: NameOf): string {
  const lines = here(chat, entries).map((entry) => {
    const doing = entry.note ? workNote(entry.note) : '';
    return entry.agentId === solo ? capital(doing || 'Working') : `${nameOf(entry.agentId) ?? 'Agent'}${doing ? `: ${onward(doing)}` : ''}`;
  });
  if (lines.length) return lines.slice(0, 2).join(', ') + (lines.length > 2 ? ` +${lines.length - 2}` : '');
  // Fallback: agents marked working on the summary without an activity note.
  if (solo && chat.working.includes(solo)) return 'Working';
  return chat.working.map((id) => nameOf(id)).filter(Boolean).join(', ');
}

/** A narrow sub line (a small window): one agent at work keeps its line ("Manager: running a command"); more agents, their names ("Ava, Mira +1"). */
export function liveShort(chat: Chat, solo: string | undefined, entries: ReadonlyArray<LiveEntry>, nameOf: NameOf): string {
  const ids = here(chat, entries).map((entry) => entry.agentId);
  return solo || ids.length < 2 ? liveStatus(chat, solo, entries, nameOf) : names(ids, nameOf);
}

/** A phone's sub line: a group's "Manager is working" or "Ava, Mira +1"; a 1:1 keeps its line ("Running a command"). */
export function liveNames(chat: Chat, solo: string | undefined, entries: ReadonlyArray<LiveEntry>, nameOf: NameOf): string {
  const ids = here(chat, entries).map((entry) => entry.agentId);
  if (solo || !ids.length) return liveStatus(chat, solo, entries, nameOf);
  return ids.length === 1 ? `${nameOf(ids[0]) ?? 'Agent'} is working` : names(ids, nameOf);
}

// ---------------------------------------------------------------- the model line

/** Effort as the person reads it (the composer's model menu uses the same words). */
export const EFFORT_LABEL: Record<Effort, string> = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Max' };

const isEffort = (value: unknown): value is Effort => typeof value === 'string' && Object.prototype.hasOwnProperty.call(EFFORT_LABEL, value);
const VENDOR = /^(?:Claude|Anthropic|OpenAI|Google)\s+(?=\S)/i;

/** A model's short name: its display name without the vendor word ("Claude Opus 5.5" → "Opus 5.5"). */
export function shortModelName(name: string): string {
  return name.trim().replace(VENDOR, '');
}

/** "claude:claude-opus-5-5" → "claude-opus-5-5" (only when the run reports no display name). */
const bareId = (id: string) => id.slice(id.indexOf(':') + 1);

/**
 * What a live run runs on: "Opus 5.5 · High" from its live values (the runtime sets them at route time and after a
 * failover or rebuild); without them, its message's meta (model display name, effort); '' while it routes.
 */
export function modelLine(route: { model?: string; modelName?: string; effort?: string } | undefined, meta?: { model?: unknown; effort?: unknown }): string {
  const own = route?.modelName?.trim() || (route?.model ? bareId(route.model) : '');
  const name = own || (typeof meta?.model === 'string' ? meta.model.trim() : '');
  const effort = own ? route?.effort : meta?.effort;
  if (!name) return '';
  const short = shortModelName(name);
  return isEffort(effort) ? `${short} · ${EFFORT_LABEL[effort]}` : short;
}

/** The shown form of a temperature (shared/model/runs.ts shownTemperature): "0.3", "≈0.3". */
const SHOWN = new RegExp(`^${STANCE_MARK}?\\d{1,2}(?:\\.\\d{1,2})?$`);

/** B-083: a turn's temperature as the chat writes it – "T 0.3", "T ≈0.3" (the model samples at its own setting); '' without one. */
export function temperatureTag(shown: unknown): string {
  return typeof shown === 'string' && SHOWN.test(shown) ? `T ${shown}` : '';
}

/** Its title: "Temperature 0.3", or – marked ≈ – that the value is carried as stance. '' without one. */
export function temperatureTitle(shown: unknown): string {
  if (typeof shown !== 'string' || !temperatureTag(shown)) return '';
  return shown.startsWith(STANCE_MARK) ? `Temperature ${shown.slice(STANCE_MARK.length)}, carried as stance – this model samples at its own setting` : `Temperature ${shown}`;
}

/** An activity entry's or a run's temperature in its shown form (undefined without one). */
export function shownOf(value: { temperature?: number; temperatureSent?: boolean } | undefined): string | undefined {
  return value?.temperature !== undefined ? shownTemperature(value.temperature, value.temperatureSent) : undefined;
}

/** A model line with the turn's temperature after it ("Opus 5.5 · High · T 0.3"); the line alone without one or without a model. */
export function withTemperature(line: string, shown: unknown): string {
  const tag = temperatureTag(shown);
  return line && tag ? `${line} · ${tag}` : line;
}

/** A row's live note: what the agent does ("bash" → "Running a command", "waiting for approval" → "Waiting for approval"), else "Working". */
export function noteText(note: string | undefined): string {
  const doing = note?.trim() ? workNote(note) : '';
  return capital(doing || 'Working');
}

/** F20/F21: the run a live bar line's Stop ends (LiveBar.tsx) – that agent's own run; a split part has none. */
export function barStopRun(run: { runId: string; split?: { groupId: string } }, mayCancel: boolean): string | undefined {
  return mayCancel && !run.split && run.runId ? run.runId : undefined;
}

/** The live bar's height a click inside its open lines took, and which lines were open then (LiveBar.tsx). */
export type KeptBar = { lines: string; height: number };

/** Which of the bar's lines are open, as one key: the runs' ids in bar order. */
export function openLines(runs: ReadonlyArray<{ runId: string }>, open: ReadonlySet<string>): string {
  return runs.filter((run) => open.has(run.runId)).map((run) => run.runId).join(' ');
}

/** The bar's fixed height while the same lines stay open: what opens inside them (a part's steps, older steps) grows
 *  within it and scrolls there, so the rows above the click stay put. A line opening, closing or ending lets go. */
export function keptHeight(kept: KeptBar | undefined, lines: string): number | undefined {
  return kept && lines && kept.lines === lines ? kept.height : undefined;
}
