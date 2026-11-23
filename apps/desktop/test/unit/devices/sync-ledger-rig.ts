// The rig of the record sync tests (sync-ledger*.test.ts): the row sync's fake PCs (sync-net.ts) with a LedgerSync each
// on 'sync.ledger', the agent Mara and helpers that write her record the way capture does (LedgerStore) with run journal
// rows behind it. Owns: this rig only. Never: asserts anything.

import { LedgerStore } from '../../../src/runtime/context/ledger/store.ts';
import { LedgerSync } from '../../../src/runtime/devices/sync/ledger.ts';
import type { LedgerKind, LedgerState } from '../../../src/shared/model/context-ledger.ts';
import { agent } from '../chat/harness.ts';
import { makePc, type Net, type Pc } from './sync-net.ts';

export const MARA = 'ag_mara';
export const THREAD = 'main';

export type LedgerPc = Pc & { ledger: LedgerSync; notes: Array<{ agentId: string; text: string }> };

/** A PC with the record sync on its mesh; Mara runs on `home`. */
export function ledgerPc(net: Net, id: string, home: string): LedgerPc {
  const pc = makePc(net, id);
  const notes: Array<{ agentId: string; text: string }> = [];
  const ledger = new LedgerSync(pc.h.services, (_s, agentId, text) => notes.push({ agentId, text }));
  pc.handlers.set('sync.ledger', (params, from) => ledger.receive(params, from));
  pc.h.org.add(agent(MARA, 'Mara', { deviceId: home }));
  return Object.assign(pc, { ledger, notes });
}

/** Mara now runs on `home` as `pc` sees it. */
export function homeOf(pc: Pc, home: string): void {
  pc.h.org.add({ ...pc.h.org.get(MARA)!, deviceId: home });
}

let at = Date.UTC(2026, 10, 21, 9, 0, 0);

/** A run with one tool call and its result (data of `size` characters). */
export function journal(pc: Pc, runId: string, resultId: string, size = 40, status = 'done'): void {
  if (!pc.h.db.get('SELECT 1 AS hit FROM runs WHERE id = ?', [runId])) {
    pc.h.db.run(`INSERT INTO runs (id, agent_id, trigger, status, started_at, device_id) VALUES (?, ?, 'message', ?, ?, NULL)`, [runId, MARA, status, at]);
  }
  const callId = `call_${resultId}`;
  pc.h.db.run(`INSERT INTO run_items (id, run_id, seq, kind, name, data, created_at) VALUES (?, ?, 1, 'tool_call', 'shell.exec', ?, ?)`, [`${resultId}_call`, runId, JSON.stringify({ callId, args: { cmd: 'ls' } }), at]);
  pc.h.db.run(`INSERT INTO run_items (id, run_id, seq, kind, name, data, created_at) VALUES (?, ?, 2, 'tool_result', 'shell.exec', ?, ?)`, [resultId, runId, JSON.stringify({ callId, output: 'x'.repeat(size) }), at]);
}

/** One row of Mara's record as capture writes it; `state` marks it after. */
export function row(pc: Pc, kind: LedgerKind, options: { ref?: string; runId?: string; state?: LedgerState; title?: string; thread?: string; at?: number; agentId?: string } = {}) {
  const store = new LedgerStore(pc.h.db);
  at += 1000;
  return pc.h.db.tx(() => {
    const added = store.insert({
      agent_id: options.agentId ?? MARA, conversation_id: options.thread ?? THREAD, kind, run_id: options.runId ?? null, created_at: options.at ?? at, tokens: 50,
      title: options.title ?? `${kind} at ${at}`, origin_engine: 'codex', origin_model: 'gpt', ref: options.ref ?? null, bytes: 0,
    });
    if (options.state && options.state !== 'keep') store.setMark(added, { state: options.state, condensed: options.state === 'condensed' ? 'short' : null, by: 'subconscious', reason: 'test', at });
    return store.row(added.agent_id, added.conversation_id, added.item_id)!;
  });
}

/** Mara's record on `pc`: [item id, order, kind, ref, state, pc] in order. */
export function record(pc: Pc, thread = THREAD, agentId = MARA) {
  return pc.h.db.all<{ item_id: string; order: number; kind: string; ref: string | null; state: string; pc: string | null; title: string }>(
    'SELECT item_id, "order", kind, ref, state, pc, title FROM context_items WHERE agent_id = ? AND conversation_id = ? ORDER BY "order"', [agentId, thread]);
}

export const items = (pc: Pc) => pc.h.db.all<{ id: string }>('SELECT id FROM run_items ORDER BY id').map((item) => item.id);

export const ledgerCalls = (net: Net, op?: string) => net.calls.filter((call) => call.method === 'sync.ledger' && (!op || (call.params as { op?: string }).op === op));
