// B-080 (owner 08.11.2026: "keine Verdichtung bei 150k oder 128k … das muss komplett dynamisch sein"): how an agent's record
// (its context ledger) fits the model's window.
// 13.11.2026 evening (owner: "der Kontext geht nie verloren … der ist immer sein eigener Agent"): there is no start after a
// renewal any more – every rebuild replays the agent's whole record, kept small by the marks, the lean history and the chat
// lines' reach (oldChatLines: the context carries the chat lines of the last CHAT_DAYS before the newest one, at most
// CHAT_TOKENS of them; older ones are hidden like any mark – restorable, and chat.read finds them by date).
// The fit: when the part does not fit the model's window, the oldest tool work in it (tool, skill, file, reasoning and answer
// items) is hidden – oldest first, as much as needed and no more, restorable like any mark – while the chat lines, the newest
// turn and what the main AI brought back stay. Only when that is not enough the session is renewed – and starts again from this
// record (agents/history-text.ts), never from a chat.
// B-089 (11.11.2026, live 10.11.: every model call re-sends the whole session – Codex p50 145k, p90 356k tokens, Claude p90 505k –
// and sessions sat at the window's ceiling because the fit trims only the excess above 80 %): the lean history. At a native
// rebuild (sent uncached anyway) the tool work of finished runs keeps its call and arguments in place with the restore stamp and
// leaves its output (leanMarks: condensed by 'window'); their reasoning is hidden. Chat lines and the agent's own words stay.
// Runde "Halb" 21.11.2026: the lean view reaches into open work too – every tool and file item but the thread's newest steps
// (LeanKeep.recent) is condensed, and only the newest runs keep their reasoning (LeanKeep.runs).
// KI-Runde 17.11.2026: the lean history rides on a rebuild that happens anyway (agents/rebuild.ts) – nothing here weighs a
// rebuild for savings any more. The fold (foldHides): once the agent wrote its hand-over, everything of its own work before
// it leaves the view – restorable like any mark – while the chat lines (the agent's own posted words among them), the
// tasks.update calls that finished a task since the hand-over before it and what it brought back stay.
// Owns: which items the fit hides, which items the lean history and the chat lines' reach set aside (a set-aside call's long
// arguments cut, leanArgs), which items a fold hides,
// and the platform's token unit (tokensOf). Never: deletes anything; the fit and the lean history never mark the agent's own
// words, the newest steps, the newest turn's reasoning or a pinned item.

import { CHARS_PER_TOKEN, compactStamp, type LedgerItem, type LedgerKind, type LedgerState, type LedgerViewItem } from '../../../shared/model/context-ledger.ts';

/** The reason a fit's hide carries (the ledger's mark reason). */
export const FIT_REASON = 'the oldest work, to fit the model window';
/** B-089: what a finished run's tool output leaves in its place (the call, its arguments and the restore stamp stay). */
export const LEAN_TEXT = 'Output set aside when that piece of work was finished.';
/** B-089: the ledger's mark reason of the lean history. */
export const LEAN_REASON = 'finished work, kept as a trace';

/**
 * The values a set-aside output keeps: links (also file:///C:/… as Node prints a stack), mail addresses, Windows paths (a separator of one
 * backslash or more, as JSON escapes it once or twice), slash paths (relative, from home and absolute: ~/…, /home/…, /c/Users/…, C:/Users/…
 * and C:/x.ts with the drive as Node and Git Bash print them, a link target '(/docs/x)'), file names, ids like task_1m7…. Letters
 * are Unicode with their marks (Übersicht.md stays whole, also decomposed as macOS writes it, and so do Indic names). A Windows folder – after
 * a backslash or after a drive's slash (C:/Users/John Smith/…) – may hold spaces and its file name may not, and a comma ends either: 'C:\a\x.ts, C:\a\y.ts' are two values, 'C:\…\My Documents\Report 2026.docx'
 * keeps 'C:\…\My Documents\Report', and prose up to a later separator within 120 characters stays one value ('C:\a.json and then src\b.json',
 * 'C:/a.json and then src/b.json' – the path still leads it; review 14.11.: on real outputs 0 drive paths cut at a space, 174 before).
 * Every alternative but the link starts only where its run of name characters starts (the lookbehinds), so a 64,000-character run of one
 * kind costs linear time, not quadratic (review 14.11.: 8–11 s per output before).
 */
const NAME = String.raw`\-\p{L}\p{M}\p{N}_.`; // the hyphen first and escaped: anything appended to the class stays a character, not a range
const KEPT_VALUE = new RegExp([
  String.raw`(?:https?|file):\/\/[^\s)\]>"'\x60\\,]+`,
  String.raw`(?<![${NAME}+])[${NAME}+]+@[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+`,
  String.raw`(?<![\p{L}\p{M}\p{N}])[A-Za-z]:\\+(?:[^\\\n\r"'<>|:*?,]{1,120}\\+)*[^\\\s"'<>|,:*?]+`,
  String.raw`(?<![${NAME}\/])(?:[A-Za-z]:\/(?:[^\/\n\r"'<>|:*?,]{1,120}\/)*(?=[${NAME}])|(?:~?\/)?(?:[${NAME}]+\/)+)[${NAME}]+`,
  String.raw`(?<![${NAME}])[${NAME}]+\.(?:json|md|py|ts|js|cjs|mjs|txt|csv|html|ps1|sh|eml|pdf|png|jpg|yaml|yml|toml|xml|log|docx|xlsx)(?![\p{L}\p{M}\p{N}])`,
  String.raw`\b[a-z]{2,}_[0-9a-z]{8,}\b`,
].join('|'), 'gu');
/** How a lean text opens its values (leanStart takes them away). */
const VALUES_LINE = '\nValues in it: ';
/** The start of the output it keeps, so the line still says what it was. */
const KEPT_START = 200;
/** At most this much text or this share of the output (shorter keeps fewer values: 95 % of the used values at 2,000, 77 % at 1,000). */
const KEPT_CHARS = 2000;
const KEPT_SHARE = 0.4;
/** The room a leanText of an output of `chars` characters has, and the most of its start it takes (leanText and the rows' rowLean alike). */
const roomOf = (chars: number) => Math.min(KEPT_CHARS, Math.floor(chars * KEPT_SHARE));
const startOf = (chars: number) => Math.min(KEPT_START, Math.floor(roomOf(chars) / 3));

/** A value without the punctuation of the sentence around it ('x.ts).' → 'x.ts'); a loop, as a trailing regex backtracks quadratically over a long inner run. */
function untrailed(value: string): string {
  let end = value.length;
  while (end > 0 && '.,;:)]'.includes(value[end - 1])) end--;
  return value.slice(0, end);
}

/**
 * Unterbewusstsein v1 (14.11.2026, owner 13.11.: "das Wichtige so speichern, dass es wiedergefunden wird"): the text a finished run's
 * output leaves – LEAN_TEXT, how it began and every value in it in order (ids, paths, file names, links, addresses), within KEPT_CHARS or
 * KEPT_SHARE of the output. Measured on 12 hard real transcripts (.local/unterbewusstsein-20261113/e2-compaction): 54 of the 57 values later
 * work used stay, with no model call; LEAN_TEXT alone kept none, the cheap model's own condensations 47.
 */
export function leanText(output: string): string {
  const room = roomOf(output.length);
  const start = output.replace(/\s+/g, ' ').trim().slice(0, startOf(output.length));
  if (!start) return LEAN_TEXT;
  let kept = '';
  for (const value of new Set((output.match(KEPT_VALUE) ?? []).map(untrailed))) {
    if (start.length + kept.length + value.length + 2 > room) continue; // a shorter later value may still fit
    kept += kept ? `, ${value}` : value;
  }
  return `${LEAN_TEXT} It began: ${start} …${kept ? `${VALUES_LINE}${kept}` : ''}`;
}

/**
 * A lean text without its values, as it stays once the retention pruned the original (retention.ts): a value may have stood past the
 * part of the output the run item still holds, where the person's Forget no longer finds it (forget.ts). Any other text as it is.
 */
export function leanStart(text: string): string {
  const at = text.startsWith(LEAN_TEXT) ? text.indexOf(VALUES_LINE) : -1;
  return at < 0 ? text : text.slice(0, at);
}

/** A character count in the platform's one token unit (shared/model/context-ledger.ts CHARS_PER_TOKEN, measured there). */
export { CHARS_PER_TOKEN };
export const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** What one view entry costs in a rebuilt history, like agents/rebuild-items.ts historyTokens (a call counts its arguments and output). */
export function entryTokens(entry: Pick<LedgerViewItem, 'text' | 'call' | 'nested'>): number {
  if (entry.nested) return 0;
  if (!entry.call) return tokensOf(entry.text.length);
  let args = 0;
  try { args = (typeof entry.call.args === 'string' ? entry.call.args : JSON.stringify(entry.call.args ?? {}) ?? '').length; } catch { args = 0; }
  return tokensOf(args + entry.call.output.length);
}

/**
 * The ids the fit hides so that `excess` tokens leave the history: tool work oldest first, never a chat line, an item of
 * `newestRun`, a pinned one (`pinned`) or a nested one (it costs nothing). None when even all that may go would not bring
 * the history in: nothing is hidden for nothing.
 */
export function fitHides(entries: readonly LedgerViewItem[], excess: number, keep: { newestRun?: string; pinned: ReadonlySet<string> }): string[] {
  const out: string[] = [];
  let freed = 0;
  for (const entry of entries) {
    if (freed >= excess) break;
    if (entry.kind === 'message' || entry.nested || keep.pinned.has(entry.itemId)) continue;
    if (keep.newestRun && entry.runId === keep.newestRun) continue;
    const tokens = entryTokens(entry);
    if (tokens <= 0) continue;
    out.push(entry.itemId);
    freed += tokens;
  }
  return freed >= excess ? out : [];
}

/** B-089: one lean mark and the tokens it takes off the rebuilt history; `reason`: the mark's own (else LEAN_REASON); `text`: a condensed one's (leanText, else LEAN_TEXT). */
export interface LeanMark { itemId: string; state: 'condensed' | 'hidden'; saves: number; reason?: string; text?: string }

/**
 * The chat lines my context carries: those of the last CHAT_DAYS before the newest line, at most CHAT_TOKENS of them
 * (17.11.2026: 24,000 at two characters per token – the same 48,000 characters the 16,000 held at three).
 */
export const CHAT_DAYS = 2;
export const CHAT_TOKENS = 24_000;
export const CHAT_REASON = 'an older chat line – chat.read finds it by date';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The chat lines past that reach, as hidden marks: newest first, a line is hidden once it is older than CHAT_DAYS before the
 * newest line or the newer lines already fill CHAT_TOKENS. Never the newest line, a pinned or nested one. `rows` are the
 * thread's lines – the others' and the agent's own posted words alike (ledger.lines). Pure.
 */
export function oldChatLines(rows: readonly LedgerItem[], pinned: ReadonlySet<string>): LeanMark[] {
  const lines = rows.filter((row) => row.state !== 'hidden' && !row.nested).sort((a, b) => a.order - b.order);
  const newest = lines.at(-1)?.createdAt ?? 0;
  const out: LeanMark[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const row = lines[index];
    const cost = row.state === 'condensed' ? tokensOf(row.condensed?.length ?? 0) : Math.max(0, row.tokens);
    const old = newest - row.createdAt > CHAT_DAYS * DAY_MS || used >= CHAT_TOKENS;
    used += cost;
    if (old && index < lines.length - 1 && !pinned.has(row.itemId)) out.push({ itemId: row.itemId, state: 'hidden', saves: cost, reason: CHAT_REASON });
  }
  return out;
}

/** A loaded skill stays in full: its body is instructions the later work still follows, not the output of finished work. */
const LEAN_KINDS: ReadonlySet<LedgerViewItem['kind']> = new Set(['tool', 'file']);

/**
 * Runde "Halb" 21.11.2026: once a call's output is set aside, its arguments are the bulk (live: a Write's average 8,800
 * characters, a shell command with an inline script 760). A string in them longer than ARG_KEPT keeps its start – a file path
 * and a command's first line stay, which is what later work looks up – and says how much it left out; the call keeps the
 * shape of its tool (an object stays an object with the same keys), and context.restore returns the original.
 */
export const ARG_KEPT = 300;
const argCut = (value: string) => (value.length <= ARG_KEPT ? value : `${value.slice(0, ARG_KEPT)}… [${value.length - ARG_KEPT} characters left out – context.restore returns the call]`);

/** A call's arguments with every long string cut to ARG_KEPT (argCut), at any depth; everything else as it is. */
export function leanArgs(args: unknown, depth = 0): unknown {
  if (typeof args === 'string') return argCut(args);
  if (!args || typeof args !== 'object' || depth > 8) return args;
  if (Array.isArray(args)) return args.map((value) => leanArgs(value, depth + 1));
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, leanArgs(value, depth + 1)]));
}

/** A view entry as a rebuild replays it: a condensed tool or file call with its arguments cut (leanArgs); any other entry as it is. */
export function leanCall<T extends Pick<LedgerViewItem, 'kind' | 'state' | 'call'>>(entry: T): T {
  return entry.state === 'condensed' && entry.call && LEAN_KINDS.has(entry.kind) ? { ...entry, call: { ...entry.call, args: leanArgs(entry.call.args) } } : entry;
}

/** B-089: what a condensed call costs as the view renders it – its cut arguments, its leanText (`text`, else computed) and the restore stamp (view.ts). */
export function leanCost(entry: Pick<LedgerViewItem, 'itemId' | 'text' | 'call' | 'nested'>, text = leanText(entry.call?.output ?? entry.text)): number {
  const stamp = compactStamp(entry.itemId, entryTokens(entry));
  return entryTokens({ text: '', call: { name: '', args: leanArgs(entry.call?.args ?? {}), callId: '', output: `${text}\n${stamp}` } });
}

/** B-089: what the lean history chooses from – an item, what it costs now and what its condensed form would cost. */
interface LeanCandidate { itemId: string; kind: LedgerKind; runId?: string; state: LedgerState; nested?: boolean; tokens: number; cost: number; text?: string }
/**
 * `runs`: whose reasoning stays (and, without `recent`, whose tool work stays whole); `recent` (Runde "Halb" 21.11.2026): the tool
 * and file items that stay whole – the newest steps of the thread, whatever run they belong to; `pinned`: never touched.
 */
export type LeanKeep = { runs: ReadonlySet<string>; pinned: ReadonlySet<string>; recent?: ReadonlySet<string> };

/** Whether the lean history keeps this tool or file item whole. */
const keptWhole = (item: { itemId: string; runId?: string }, keep: LeanKeep) => (keep.recent ? keep.recent.has(item.itemId) : keep.runs.has(item.runId!));

/**
 * B-089: the one choice of the lean history – reasoning of a run outside `keep.runs` is hidden; a kept tool or file item that is
 * not kept whole (keptWhole) and costs more than its condensed form is condensed. Never a chat line, the agent's own words, a
 * loaded skill, a nested, pinned or already marked item, or an item of no run. Pure: nothing is written.
 */
function leanPick(candidates: Iterable<LeanCandidate>, keep: LeanKeep): LeanMark[] {
  const out: LeanMark[] = [];
  for (const item of candidates) {
    if (!item.runId || item.state !== 'keep' || item.nested || keep.pinned.has(item.itemId)) continue;
    if (item.kind === 'reasoning') { if (item.tokens > 0 && !keep.runs.has(item.runId)) out.push({ itemId: item.itemId, state: 'hidden', saves: item.tokens }); continue; }
    if (!LEAN_KINDS.has(item.kind) || keptWhole(item, keep)) continue;
    const saves = item.tokens - item.cost;
    if (saves > 0) out.push({ itemId: item.itemId, state: 'condensed', saves, ...(item.text ? { text: item.text } : {}) });
  }
  return out;
}

/** B-089: the lean marks over the view (what a rebuild writes; sizes as the rebuilt history counts them). A leanText is worded once, and only for an item leanPick may condense. */
export function leanMarks(entries: readonly LedgerViewItem[], keep: LeanKeep): LeanMark[] {
  return leanPick(entries.map((entry) => {
    const tokens = entryTokens(entry);
    const open = LEAN_KINDS.has(entry.kind) && entry.runId && !keptWhole(entry, keep) && entry.state === 'keep' && !entry.nested && !keep.pinned.has(entry.itemId);
    if (!open) return { ...entry, tokens, cost: tokens };
    const text = leanText(entry.call?.output ?? entry.text);
    return { ...entry, tokens, cost: leanCost(entry, text), text };
  }), keep);
}

/** The reason a fold's hide carries (the ledger's mark reason). */
export const FOLD_REASON = 'my work before my hand-over';

/**
 * The fold's choice: every item before order `before` (where the hand-over starts) that is still in view and is the agent's own
 * work – tool calls and outputs (a script's inner calls with it), skills, files, reasoning, its own words, an earlier hand-over.
 * Never a chat line (its reach rule decides), an item in `stays` (the calls that finished a task: their arguments are the task's
 * summary) or one the agent brought back and that is still pinned. Pure: nothing is written.
 */
export function foldHides(rows: readonly LedgerItem[], before: number, stays: ReadonlySet<string>): string[] {
  return rows.filter((row) => row.order < before && row.state !== 'hidden' && row.kind !== 'message' && !stays.has(row.itemId)
    && (row.kind === 'checkpoint' || row.pinnedUntil === undefined)).map((row) => row.itemId);
}
