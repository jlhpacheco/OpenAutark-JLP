// A call row on its own (call-log.ts keeps the open calls): finding it in its chat, whether its call still runs, writing
// it (saved and announced, so it syncs), which chat row becomes one of its lines – who said it as the transcript names
// them, its capped words – and the record without devices that left it (owner 19.11.2026: several devices of the person
// in one call, CallRecord.joined) with the quiet note of a join or leave. call-log.ts names the exported row functions too, where the rest of the runtime reads them.
// Owns: these functions. Never: keeps state or decides who is in a call.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { CALL_LINE_TEXT, callHolder, callRecord, callState, type CallDevice, type CallJoin, type CallLine, type CallRecord } from '../../shared/model/call.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import { MessageRepo } from '../chat/message-repo.ts';
import { DevicesRepo } from '../devices/repo.ts';

/** The open call a line goes into: its id, its row (and the row's seq) in its chat, and the device that holds it. */
export interface LineCall { id: string; rowId: string; conversationId: string; seq: number; holder: { device: CallDevice } }

export const quiet = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

/** The record without the devices `out` (callHolder form) among its joined ones; the same record when none of them is in. */
export function withoutDevices(record: CallRecord, out: readonly string[]): CallRecord {
  const joined = (record.joined ?? []).filter((device) => !out.includes(callHolder(device)));
  if (joined.length === (record.joined ?? []).length) return record;
  const next: CallRecord = { ...record, joined };
  if (!joined.length) delete next.joined;
  return next;
}

/** Owner 19.11.2026: a device's join or leave as a quiet note of the call in its chat – a transcript line, and what the holder PC writes into the row. */
export function deviceNote(conversationId: string, callId: string, device: CallJoin, left: boolean): Parameters<RuntimeServices['chats']['send']>[0] {
  const text = `${device.name} ${left ? 'left' : 'joined'} the call`;
  return { conversationId, body: text, kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text, details: { callId, device, ...(left ? { left: true } : {}) } } } };
}

/** The join or leave a note tells (written here or synced, so its shape is checked), else undefined. */
export function notedDevice(message: Message): { callId: string; device: CallJoin; left: boolean } | undefined {
  const details = message.kind === 'status' ? message.meta.status?.details : undefined;
  const device = details?.device as Partial<CallJoin> | undefined;
  if (typeof details?.callId !== 'string' || typeof device?.participant !== 'string' || typeof device.name !== 'string') return undefined;
  return { callId: details.callId, left: details.left === true, device: { participant: device.participant, name: device.name.slice(0, 60), ...(typeof device.pc === 'string' ? { pc: device.pc } : {}), ...(typeof device.person === 'string' && device.person ? { person: device.person.slice(0, 60) } : {}) } };
}

/** Who said a line, as the transcript names them. */
function speaker(s: RuntimeServices, call: LineCall, message: Message): Pick<CallLine, 'from' | 'name'> {
  if (message.authorKind === 'agent') return { from: `agent:${message.authorId}`, name: quiet(() => s.org.get(message.authorId)?.name, undefined) ?? 'Agent' };
  if (message.authorId === HUMAN_ID) {
    const said = message.meta.call?.participant;
    return { from: said ?? `device:${call.holder.device.key}`, name: quiet(() => s.settings.get().profile?.name?.trim(), undefined) || 'You' };
  }
  return { from: `${message.authorKind}:${message.authorId}`, name: quiet(() => s.people?.get(message.authorId)?.name, undefined) ?? message.authorId };
}

/** A row's words as its call line keeps them (a status row: its line), capped; undefined when it says nothing. */
export function lineText(message: Message): string | undefined {
  const clean = (message.kind === 'status' ? message.meta.status?.text : message.body)?.trim();
  return clean && clean.length > CALL_LINE_TEXT ? `${clean.slice(0, CALL_LINE_TEXT - 1)}…` : clean || undefined;
}

/** The line a chat row adds to an open call, or undefined. */
export function lineOf(s: RuntimeServices, call: LineCall, message: Message): CallLine | undefined {
  if (message.conversationId !== call.conversationId || message.id === call.rowId || message.state !== 'final' || message.seq <= call.seq) return undefined;
  const marked = message.meta.call?.id === call.id || message.meta.status?.details?.callId === call.id;
  const counts = message.kind === 'status' ? marked : message.kind === 'text' && (marked || !message.silent);
  const text = counts ? lineText(message) : undefined;
  return text ? { at: message.createdAt, ...speaker(s, call, message), text, messageId: message.id } : undefined;
}

/** Team-Call: the person on this PC's devices as a call names them (its profile name; none without one). */
export const personHere = (s: RuntimeServices): { person?: string } => { const name = quiet(() => s.settings.get().profile?.name?.trim().slice(0, 60), undefined); return name ? { person: name } : {}; };

/** This PC's device id (CallRecord.pc), undefined without a device record. */
export const thisPc = (s: Pick<RuntimeServices, 'db'>) => quiet(() => new DevicesRepo(s.db).self()?.id, undefined);

/** B-081: the call row of `callId` in a chat (its id), else undefined. */
export function callRowId(s: Pick<RuntimeServices, 'db'>, conversationId: string, callId: string): string | undefined {
  return quiet(() => s.db.get<{ id: string }>(`SELECT id FROM messages WHERE conversation_id = ? AND kind = 'status' AND json_extract(meta, '$.call.id') = ? LIMIT 1`, [conversationId, callId])?.id, undefined);
}

/**
 * KI-Runde 17.11.2026 (decision 8.3): whether that call is still running – a ring nobody took yet counts, an ended call
 * does not. Read from the call's own row, so it holds on every PC. Unknown call: false.
 */
export function callRunning(s: Pick<RuntimeServices, 'db' | 'chats' | 'clock'>, conversationId: string, callId: string): boolean {
  const rowId = callRowId(s, conversationId, callId);
  const row = rowId ? quiet(() => s.chats.message(rowId), undefined) : undefined;
  const record = row ? callRecord(row) : undefined;
  if (!record) return false;
  const state = callState(record, quiet(() => s.clock.now(), Date.now()));
  return state === 'running' || state === 'ringing';
}

/** Changes a call row's record; the row is saved and announced (it syncs) when it changed. False without such a row. */
export function writeCallRow(s: RuntimeServices, rowId: string, change: (record: CallRecord) => CallRecord): boolean {
  try {
    const row = s.chats.message(rowId);
    const record = row ? callRecord(row) : undefined;
    if (!row || !record) return false;
    const next = change(record);
    if (next === record) return true;
    const updated: Message = { ...row, meta: { ...row.meta, call: next } };
    new MessageRepo(s.db).update(updated);
    s.bus.emit('message.updated', updated);
    return true;
  } catch (error) {
    s.log.warn('call row not written', { rowId, error: String(error) });
    return false;
  }
}

/** The call rows of a chat whose lines name a message (its id in quotes). */
const LISTING = `SELECT id FROM messages WHERE conversation_id = ? AND kind = 'status' AND instr(meta, ?) > 0`;

/** A row was edited (`message`) or deleted: its line follows in every call row of this PC that names it – open or ended – with the new text, or out. */
export function followLines(s: RuntimeServices, conversationId: string, messageId: string, message?: Message): void {
  const rows = quiet(() => s.db.all<{ id: string }>(LISTING, [conversationId, JSON.stringify(messageId)]), []);
  if (!rows.length) return;
  const pc = thisPc(s);
  const text = message ? lineText(message) : undefined;
  for (const { id } of rows) {
    writeCallRow(s, id, (record) => {
      const at = record.pc === pc ? record.lines.findIndex((line) => line.messageId === messageId) : -1;
      if (at < 0 || record.lines[at].text === text) return record;
      return { ...record, lines: text ? record.lines.map((line, index) => (index === at ? { ...line, text } : line)) : record.lines.filter((_, index) => index !== at) };
    });
  }
}
