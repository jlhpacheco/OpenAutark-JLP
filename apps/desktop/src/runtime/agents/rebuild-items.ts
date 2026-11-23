// The ledger view as the history a native rebuild replays.
// Trailing user-side chat lines stay out (a turn that saw them and wrote nothing; unseen ones come again in the delta), so the
// history ends at the agent's own work; condensed items carry their stamp in their text already.
// B-049 F9 (Codex code mode): a call made inside a script (a nested item) is never replayed on its own – the model saw
// only the script and what it printed. Nested items belong to the next script call (exec or wait) of their run in the
// view, which carries one line naming them ("files.read ×25 – context.restore t5, … returns their outputs"); nested
// items with no script call after them in their run (journals from before F9, a thread resumed without raw items)
// collapse into ONE assistant note per run at the place of the run's last such call.
// Also the estimate of such a history in tokens (B-080 wave 3: context/ledger/window.ts tokensOf, the unit that matches the
// engines' own counts; a call counts its arguments and output once).
// Owns: that mapping, the grouping and the estimate. Never: reads the ledger itself, invents a call, or replays a nested one.

import type { RebuildItem } from '../engines/types.ts';
import { KIND_PREFIX, type LedgerViewItem } from '../../shared/model/context-ledger.ts';
import { callsLine, isScriptCall } from '../engines/code-mode.ts';
import { tokensOf } from '../context/ledger/window.ts';

type Inside = Array<{ name: string; itemId: string }>;

/** Nested entries by the script entry they belong to, and the orphans of each run at the index of their last one. */
function scriptGroups(view: readonly LedgerViewItem[]): { inside: Map<number, Inside>; orphans: Map<number, Inside> } {
  const closer = new Map<number, number>();
  const nextScript = new Map<string, number>();
  for (let index = view.length - 1; index >= 0; index--) {
    const entry = view[index];
    const run = entry.runId ?? '';
    if (entry.nested) {
      const at = nextScript.get(run);
      if (at !== undefined) closer.set(index, at);
    } else if (entry.call && isScriptCall(entry.call.name, entry.origin.engine)) nextScript.set(run, index);
  }
  const inside = new Map<number, Inside>();
  const byRun = new Map<string, { calls: Inside; last: number }>();
  view.forEach((entry, index) => {
    if (!entry.nested) return;
    const call = { name: entry.call?.name ?? 'tool', itemId: entry.itemId };
    const at = closer.get(index);
    if (at !== undefined) { inside.set(at, [...(inside.get(at) ?? []), call]); return; }
    const group = byRun.get(entry.runId ?? '') ?? { calls: [], last: index };
    group.calls.push(call);
    group.last = index;
    byRun.set(entry.runId ?? '', group);
  });
  return { inside, orphans: new Map([...byRun.values()].map((group) => [group.last, group.calls])) };
}

/** The note for nested calls whose script was never recorded (one per run); those of a hidden script left the view with it. */
export function orphanNote(calls: Inside): string {
  return `[ran code-mode script(s) whose source and printed output are not in this history – calls inside: ${callsLine(calls)}]`;
}

/** The ledger view as rebuild items, ending at the agent's own work (see the header). Nested items: see the header. */
export function rebuildItems(view: readonly LedgerViewItem[]): { items: RebuildItem[] } {
  const { inside, orphans } = scriptGroups(view);
  const items: RebuildItem[] = [];
  view.forEach((entry, index) => {
    const kind = KIND_PREFIX[entry.kind] ?? entry.itemId.charAt(0);
    const origin = { ...(entry.origin.engine ? { engine: entry.origin.engine } : {}), ...(entry.origin.model ? { model: entry.origin.model } : {}) };
    if (entry.nested) {
      const calls = orphans.get(index);
      if (calls) items.push({ itemId: entry.itemId, kind: 't', role: 'assistant', text: orphanNote(calls), origin });
      return;
    }
    const calls = inside.get(index);
    items.push({
      itemId: entry.itemId, kind, role: entry.role, text: entry.text,
      ...(entry.call ? { call: { name: entry.call.name, args: entry.call.args, callId: entry.call.callId, output: entry.call.output, ...(entry.call.own ? { own: true } : {}), ...(entry.call.ok === false ? { ok: false } : {}), ...(entry.call.managed ? { managed: true as const } : {}) } } : {}),
      origin,
      ...(calls ? { calls: callsLine(calls) } : {}),
    });
  });
  let end = items.length;
  while (end > 0 && items[end - 1].kind === 'm' && items[end - 1].role === 'user') end--;
  return { items: items.slice(0, end) };
}

/** In the platform's token unit (window.ts tokensOf, B-080 wave 3): a call's arguments and output (its text is that output), else the text. */
export function historyTokens(items: readonly RebuildItem[]): number {
  return tokensOf(items.reduce((sum, item) => {
    if (!item.call) return sum + item.text.length;
    let args = 0;
    try { args = (typeof item.call.args === 'string' ? item.call.args : JSON.stringify(item.call.args ?? {}) ?? '').length; } catch { args = 0; }
    return sum + args + item.call.output.length + (item.calls?.length ?? 0);
  }, 0));
}
