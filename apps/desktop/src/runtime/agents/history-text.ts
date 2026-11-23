// The agent's record as text (owner 13.11.2026: "der Kontext geht nie verloren … nie auf null angefangen oder mit einem Chat"):
// where a turn starts without a session that holds its context – a native rebuild that could not run (agents/rebuild.ts: a
// refusal, a failed probe, a rebuilt session that failed), a session-less engine, a split whose session could not be forked –
// the turn input begins with what the agent's own context ledger holds, marks applied (condensed items with their stamp,
// hidden ones left out), newest kept within the budget. Never a chat's history: chat lines are in it only as the agent saw them.
// Owns: that text and its header. Never: reads a chat, or fails a turn (no ledger or an error = no text).

import type { RuntimeServices } from '../contracts.ts';
import type { RebuildItem } from '../engines/types.ts';
import { legacyNativeShell, legacyShellOmission, recordText } from '../engines/rebuild-text.ts';
import { CHARS_PER_TOKEN } from '../context/ledger/window.ts';
import { PROJECTION } from '../context/projection.ts';
import { rebuildItems } from './rebuild-items.ts';
import '../contracts/ledger.ts';

export const HISTORY_HEAD = PROJECTION.history;
/** One tool output in the text at most: the record keeps the whole; context.restore brings it back. */
const OUTPUT_CHARS = 4_000;

function itemText(item: RebuildItem): string {
  if (item.nested || item.kind === 'r') return ''; // a script's inner call is in its script; reasoning stays with its model
  if (item.call) {
    if (legacyNativeShell(item.call, item.origin?.engine)) return legacyShellOmission(1);
    const output = item.call.output.length > OUTPUT_CHARS ? `${item.call.output.slice(0, OUTPUT_CHARS)}\n… [cut here; the record keeps it whole – context.restore ${item.itemId}]` : item.call.output;
    return recordText(item.call, { output: output || '(no output)', ...(item.calls ? { calls: item.calls } : {}), ...(item.stamp ? { stamp: item.stamp } : {}) }); // BEFUND §3: a record, not "[ran …]"
  }
  return item.role === 'assistant' ? `(me) ${item.text}` : item.text;
}

/** The record of (agent, thread) as text within `budgetTokens`, newest kept; undefined when it holds nothing to show. */
export function historyText(services: Pick<RuntimeServices, 'ledger' | 'log'>, agentId: string, thread: string, budgetTokens: number): string | undefined {
  let items: RebuildItem[];
  try { items = services.ledger ? rebuildItems(services.ledger.view(agentId, thread)).items : []; } catch (error) {
    services.log.warn('the record could not be read as text', { agentId, thread, error: String(error) });
    return undefined;
  }
  const texts = items.map(itemText).filter((text) => text.trim());
  if (!texts.length) return undefined;
  const kept: string[] = [];
  let left = Math.max(2_000, budgetTokens * CHARS_PER_TOKEN);
  for (let index = texts.length - 1; index >= 0; index--) {
    left -= texts[index].length + 2;
    if (left < 0 && kept.length) {
      kept.unshift(`(${index + 1} earlier item${index === 0 ? '' : 's'} of my record left out here for space; they are kept)`);
      break;
    }
    kept.unshift(texts[index]);
  }
  return `${HISTORY_HEAD}\n\n${kept.join('\n\n')}`;
}
