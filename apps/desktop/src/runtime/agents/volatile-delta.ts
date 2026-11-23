// Volatile deltas (B-049 F6). The live context (<live> in front of a turn's input: now, environment, my chats,
// tasks …) stays in a native session's history with every turn, so a resumed session gets only the sections that changed
// since the last turn it finished (each keeps its own "## " header), plus one line naming the sections no longer current.
// A new, renewed or rebuilt session – and a stateless engine – gets every section.
// S2 (17.11.2026): the stable prompt the same way. A resumed session keeps the system text it started with
// (agents/session-key.ts), so a stable section that changed since – my SYSTEM.md, my environment, the person's lines, the
// mode – reaches it once, as its changed lines (was / now) under the section's own name, in front of the live sections
// (stableDelta). What the session holds of each stable section is its start's text until it gets a change. A part whose
// changed lines are longer than CHANGED_MAX comes whole instead, or names the file it is (my SYSTEM.md). The bound is per
// part: what one turn gets of the stable prompt is never more than a fresh start would send – the whole of it, at most.
// State: kv 'volatile-sent', key `<agentId>|<conversationId or ''>|<engine>`, value { ref, sections: { name: { hash,
// title } }, stable: { name: text } } – what session `ref` held after its last finished ('done') turn; another ref counts
// as nothing sent.
// Forgotten (forgetSent) when the session's history stops holding it: a rebuild (a Codex revert keeps the ref but cuts
// the turns that carried it) or a compaction inside the engine (EngineTurnResult.compacted) – then the stable changes
// count from the session's start again.
// Whether a turn's live block carries a section (carries) lets a reminder's note bring its quest only when the live block
// leaves the "## Current quest" out (agents/turn-prepare.ts – one copy).
// Owns: the deltas, their "No longer current" and "was / now" lines and that state. Never: leaves out a changed section,
// or records a turn that did not finish (its sections count as unsent, so the next turn sends them again – more, never less).

import { createHash } from 'node:crypto';
import type { Db } from '../db/database.ts';
import type { EngineId } from '../../shared/model/providers.ts';
import { KvRepo } from '../store/kv.ts';
import type { VolatileSection } from '../context/prompt-volatile.ts';
import type { StableSection } from '../context/prompt-stable.ts';

export type { VolatileSection, StableSection };
export const VOLATILE_SENT_NS = 'volatile-sent';

export interface SentSection { hash: string; title: string }
export type SentSections = Record<string, SentSection>;
export interface SentKey { agentId: string; conversationId: string; engine: EngineId }
/** What a session holds: the volatile sections it was sent and the text of each stable section it has (S2; absent: its start's). */
export interface Held { sections: SentSections; stable?: Record<string, string> }

interface Stored extends Held { ref: string }

const keyOf = (key: SentKey) => `${key.agentId}|${key.conversationId}|${key.engine}`;
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);

/** "## Pinned" → "Pinned"; the section name when it has no header. */
export function sectionTitle(section: VolatileSection): string {
  const first = section.text.split('\n', 1)[0] ?? '';
  return first.replace(/^#+\s*/, '').replace(/\s*\(.*$/, '').trim().slice(0, 60) || section.name;
}

/** What session `ref` held after its last finished turn; undefined for another ref, nothing recorded or an unreadable row. */
export function sentTo(db: Db, key: SentKey, ref: string): Held | undefined {
  try {
    const stored = new KvRepo(db).get<Stored>(VOLATILE_SENT_NS, keyOf(key));
    if (!stored || stored.ref !== ref || !stored.sections || typeof stored.sections !== 'object') return undefined;
    return { sections: stored.sections, ...(stored.stable && typeof stored.stable === 'object' ? { stable: stored.stable } : {}) };
  } catch { return undefined; }
}

/** After a finished turn of session `ref`: what it holds now. Never throws (without it the next turn sends all). */
export function recordSent(db: Db, key: SentKey, ref: string, held: Held, at: number): void {
  try { new KvRepo(db).set(VOLATILE_SENT_NS, keyOf(key), { ref, ...held }, at); } catch { /* bookkeeping only */ }
}

/**
 * Forgets what the session of `key` was sent: its history no longer holds it all – rebuilt (a Codex revert keeps the
 * ref but cuts turns) or compacted by the engine itself. The next turn on it sends every section. Never throws.
 */
export function forgetSent(db: Db, key: SentKey): void {
  try { new KvRepo(db).delete(VOLATILE_SENT_NS, keyOf(key)); } catch { /* bookkeeping only */ }
}

/**
 * The volatile text for this turn and what the session holds once it finishes. `sent` undefined (new, renewed or
 * rebuilt session, another ref, a stateless engine): every section. Else the changed sections in order, then
 * "No longer current: …" for sections the session holds that are gone now.
 */
export function volatileDelta(all: readonly VolatileSection[], sent: SentSections | undefined): { text: string; sections: SentSections } {
  const held: SentSections = {};
  // A section whose builder threw this turn keeps what the session last got of it – never "no longer current".
  for (const section of all) {
    const last = section.failed ? sent?.[section.name] : undefined;
    if (last) held[section.name] = last;
  }
  const sections = all.filter((section) => !section.failed);
  for (const section of sections) held[section.name] = { hash: hashOf(section.text), title: sectionTitle(section) };
  if (!sent) return { text: sections.map((section) => section.text).join('\n\n'), sections: held };
  const changed = sections.filter((section) => sent[section.name]?.hash !== held[section.name]?.hash);
  const gone = Object.entries(sent).filter(([name]) => !Object.hasOwn(held, name)).map(([, entry]) => entry.title);
  const line = gone.length ? `No longer current: ${gone.join(', ')}.` : '';
  return { text: [...changed.map((section) => section.text), line].filter(Boolean).join('\n\n'), sections: held };
}

/** Whether this turn's live block (`shown`, volatileDelta's) carries section `name` – so nothing else repeats it (FIXREAL). */
export function carries(all: readonly VolatileSection[] | undefined, shown: { text: string } | undefined, name: string): boolean {
  const section = all?.find((item) => item.name === name && !item.failed && item.text);
  return Boolean(section && shown?.text.includes(section.text));
}

/** Said in front of the changed stable lines, in my voice. */
export const STABLE_CHANGED = 'Parts of my standing text changed since this session began. Under each part\'s name stand its lines as they were (was) and as they read now (now), or, where more changed than reads as lines, the part itself; the new text holds.';

/** The bound of one part's was/now lines (KI-Runde 17.11.2026): past it the part comes whole or names the file it is. */
export const CHANGED_MAX = 6_000;

/** The non-blank lines of `before` and `after` that differ, in order: each run of removed lines (was) before the lines that
 *  replace it (now). Lines are compared without their trailing whitespace, which reads the same. */
export function changedLines(before: string, after: string): string[] {
  const a = before.split('\n').filter((line) => line.trim());
  const b = after.split('\n').filter((line) => line.trim());
  const ka = a.map((line) => line.trimEnd());
  const kb = b.map((line) => line.trimEnd());
  // Longest common subsequence of lines, filled from the end.
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = ka[i] === kb[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const out: string[] = [];
  let was: string[] = [];
  let now: string[] = [];
  const flush = () => { out.push(...was.map((line) => `was: ${line}`), ...now.map((line) => `now: ${line}`)); was = []; now = []; };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && ka[i] === kb[j]) { flush(); i++; j++; }
    else if (j >= b.length || (i < a.length && common[(i + 1) * width + j] >= common[i * width + j + 1])) was.push(a[i++]);
    else now.push(b[j++]);
  }
  flush();
  return out;
}

/** "# My SYSTEM.md" → "My SYSTEM.md"; the section name when its first line is empty. */
const stableTitle = (name: string, text: string): string => (text.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim().slice(0, 80) || name;

/** A stable section that is one file of mine: past the bound its name stands here instead of the text (context/prompt-stable.ts). */
const SECTION_FILE: Readonly<Record<string, string>> = { 'system-md': 'my SYSTEM.md' };

/** What a part whose change is longer than the bound says instead of its lines. */
function wholeInstead(name: string, after: string): string {
  if (!after) return 'This part is not in my standing text any more.';
  const file = SECTION_FILE[name];
  return file ? `More of this part changed than reads as lines; it is ${file}, and the whole of it as it reads now stands there.`
    : `More of this part changed than reads as lines, so it stands here as it reads now:\n${after}`;
}

/**
 * S2: what a resumed session gets of its changed stable sections, and the stable text it holds once the turn finishes.
 * `held` is what it has of each section (its start's text, then the changes it got); a section that is new or gone counts
 * against ''. Nothing changed: ''.
 */
export function stableDelta(current: readonly StableSection[], held: Readonly<Record<string, string>>): { text: string; stable: Record<string, string> } {
  const stable = Object.fromEntries(current.map((section) => [section.name, section.text]));
  const names = [...current.map((section) => section.name), ...Object.keys(held).filter((name) => !Object.hasOwn(stable, name))];
  const parts: string[] = [];
  for (const name of names) {
    const before = held[name] ?? '';
    const after = stable[name] ?? '';
    if (before === after) continue;
    const lines = changedLines(before, after);
    if (!lines.length) continue;
    const text = lines.join('\n');
    parts.push([`## ${stableTitle(name, after || before)}`, text.length > CHANGED_MAX ? wholeInstead(name, after) : text].join('\n'));
  }
  return { text: parts.length ? [STABLE_CHANGED, ...parts].join('\n\n') : '', stable };
}
