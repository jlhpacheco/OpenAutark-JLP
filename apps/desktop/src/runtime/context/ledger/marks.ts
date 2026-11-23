// The ledger's marks where no native rebuild applies them: a turn that gets its record as text (agents/history-text.ts – the
// marks already applied there) also gets the call that says what was condensed or hidden and how to get it back, under the name
// of the main AI's own tool `subconscious`
// (agents/rebuild.ts puts the same call into a rebuilt history; q-r1b2, 03.11.2026: named context.hide, a tool the main AI lacks, it went
// looking for that tool and told the person it could remove nothing). A stateless engine holds nothing between
// turns, so it also gets the subconscious's earlier calls again (carriedCalls), as a CLI session holds them, marks applied.
// Owns: that call and those calls. Never: changes a stored message, or fails a turn (no
// ledger or an error = the lines as they are).

import type { RuntimeServices } from '../../contracts.ts';
import { NOTE_CALL, type TraceCall } from '../../../shared/model/subconscious.ts';
import type { LedgerItem } from '../../../shared/model/context-ledger.ts';
import { legacyNativeShell } from '../../engines/rebuild-text.ts';
import '../../contracts/ledger.ts';

const NOTICE_IDS = 40;
/** What a stateless engine's history carries of the subconscious's earlier calls at most, in tokens; the newest stay. */
export const CARRIED_TOKENS = 3000;
/** Calls looked at for that (each may be cut away by the budget, so more than fit). */
const CARRIED_CALLS = 30;
/** B-080 wave 3: sizes only the carried text; never compared with an engine's count (that unit is shared/model/context-ledger.ts CHARS_PER_TOKEN). */
const CARRIED_CHARS_PER_TOKEN = 4;
/** context.restore is no direct tool of a turn: a main AI that looked for the name among its tools did not find it and went digging in the database (live 02.11.2026, q1). */
const RESTORE_CALL = 'tools.call {"name":"context.restore","args":{"ids":[…]}}';

type Mark = Pick<LedgerItem, 'itemId' | 'state'>;

/** The one call naming what is condensed and hidden, by id only (a hidden item's words stay out): "My context, kept small: condensed t17; hidden t9 – get any back with tools.call …" */
export function marksCall(marks: readonly Mark[]): TraceCall | undefined {
  const condensed = marks.filter((mark) => mark.state === 'condensed').map((mark) => mark.itemId);
  const hidden = marks.filter((mark) => mark.state === 'hidden').map((mark) => mark.itemId);
  if (!condensed.length && !hidden.length) return undefined;
  const more = (list: string[], max: number) => (list.length > max ? [...list.slice(0, max), `+${list.length - max} more`] : list);
  const parts = [condensed.length ? `condensed ${more(condensed, NOTICE_IDS).join(', ')}` : '', hidden.length ? `hidden ${more(hidden, NOTICE_IDS).join(', ')}` : ''].filter(Boolean);
  return { tool: NOTE_CALL, args: {}, output: `My context, kept small: ${parts.join('; ')} – get any back with ${RESTORE_CALL}.` };
}

/** The agent's marks in this thread, newest first (a long list keeps the recent ones). */
export function marksOf(services: RuntimeServices, agentId: string, thread: string): LedgerItem[] {
  try {
    return (services.ledger?.items(agentId, thread) ?? [])
      .filter((item) => item.state !== 'keep' && !item.nested && item.markReason !== 'deleted by its author' && !(item.state === 'hidden' && item.pruned))
      .sort((a, b) => b.order - a.order);
  } catch (error) {
    services.log.debug('ledger marks unreadable', { thread, error: String(error) });
    return [];
  }
}

/** The subconscious's earlier calls in this thread, as a stateless engine's next history shows them: oldest first, marks applied, without those of `runId`, the newest within CARRIED_TOKENS. */
export function carriedCalls(services: RuntimeServices, agentId: string, thread: string, runId: string): TraceCall[] {
  try {
    const entries = services.ledger?.traceView?.(agentId, thread, CARRIED_CALLS) ?? [];
    const out: TraceCall[] = [];
    let left = CARRIED_TOKENS * CARRIED_CHARS_PER_TOKEN;
    for (const entry of [...entries].reverse()) {
      if (!entry.call || entry.runId === runId || legacyNativeShell(entry.call, entry.origin?.engine)) continue;
      const args = typeof entry.call.args === 'object' && entry.call.args !== null ? entry.call.args as Record<string, unknown> : {};
      left -= entry.call.name.length + JSON.stringify(args).length + entry.call.output.length;
      if (left < 0) break;
      out.unshift({ tool: entry.call.name, args, output: entry.call.output });
    }
    return out;
  } catch (error) {
    services.log.debug('earlier subconscious calls unreadable', { thread, error: String(error) });
    return [];
  }
}
