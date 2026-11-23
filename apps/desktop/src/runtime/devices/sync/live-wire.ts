// The short form of live work between the CEO's own PCs (devices/sync/live.ts; owner 22.11.2026: "nur das, was eben neu
// ist … mit den IDs … kurzen Befehlen", a start notice that gets through at 50 characters a second). One run travels as
// a flat object under short keys (`pack`; a field without one – a newer version's – keeps its own name), a change as
// only the fields that changed (`diffOf`, null = gone; `patched` applies it), and a PC's whole live state as one short
// hash (`stateHash`, a few characters) that both PCs compute over exactly what they hold – the receiver keeps what came
// as it came (only checked, never trimmed), so the same state always has the same hash on both sides. `shareOf` is
// the one normal form of a run (the live bar's fields within their limits) – the sender's, before anything travels.
// Owns: these forms. Never: sends, stores or announces anything.

import type { AgentActivity } from '../../../shared/model/runs.ts';
import type { LiveShare } from '../../chat/live.ts';
import { hashOf } from './stamps.ts';

/** One run under short keys. */
export type Packed = Record<string, unknown>;

/** The chats per run a message carries; a run's longest note and step. */
const MAX_CHATS = 20;
const MAX_TEXT = 300;
/** The longest run a receiver keeps (characters of its JSON). */
const MAX_PACKED = 4_000;
const SHORT: Readonly<Record<string, string>> = {
  runId: 'i', agentId: 'a', conversationId: 'c', taskId: 'k', note: 'n', startedAt: 't', model: 'o', modelName: 'm', effort: 'e',
  engine: 'g', temperature: 'tp', temperatureSent: 'ts', origin: 'r', split: 'sp', fold: 'f', step: 'p', chats: 'ch',
};
const LONG: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(SHORT).map(([long, short]) => [short, long]));

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** One run of another PC, or undefined when it is no run (the live bar's fields only; never a deviceId of its own). */
export function shareOf(value: unknown): LiveShare | undefined {
  if (!plain(value) || !plain(value.activity)) return undefined;
  const { deviceId: _device, toolCalls: _calls, ...activity } = value.activity;
  if (typeof activity.agentId !== 'string' || typeof activity.runId !== 'string' || typeof activity.startedAt !== 'number') return undefined;
  const chats = Array.isArray(value.chats) ? value.chats.filter((chat): chat is string => typeof chat === 'string').slice(0, MAX_CHATS) : [];
  const step = typeof value.step === 'string' && value.step ? value.step.slice(0, MAX_TEXT) : undefined;
  return { activity: { ...activity, note: typeof activity.note === 'string' ? activity.note.slice(0, MAX_TEXT) : '' } as unknown as AgentActivity, ...(step ? { step } : {}), chats };
}

/** A run flat under short keys (no undefined field). */
export function pack(share: LiveShare): Packed {
  const out: Packed = {};
  for (const [key, value] of Object.entries({ ...share.activity, step: share.step, chats: share.chats })) if (value !== undefined) out[SHORT[key] ?? key] = value;
  return out;
}

/** The run a packed one names, in the normal form; undefined when it is none. */
export function unpack(packed: Packed): LiveShare | undefined {
  const activity: Plain = {};
  let step: unknown;
  let chats: unknown;
  for (const [key, value] of Object.entries(packed)) {
    const long = LONG[key] ?? key;
    if (long === 'step') step = value;
    else if (long === 'chats') chats = value;
    else activity[long] = value;
  }
  return shareOf({ activity, step, chats });
}

/** Whether a packed run that came may be kept as it came. */
export function validPacked(value: unknown): value is Packed {
  return plain(value) && typeof value.i === 'string' && value.i.length <= 200 && typeof value.a === 'string' && typeof value.t === 'number'
    && JSON.stringify(value).length <= MAX_PACKED;
}

/** The fields of `after` that differ from `before`; a field that is gone as null. */
export function diffOf(before: Packed, after: Packed): Packed {
  const out: Packed = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) out[key] = null;
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  return out;
}

/** `packed` with a change applied (null removes a field). */
export function patched(packed: Packed, change: Packed): Packed {
  const out: Packed = { ...packed };
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** A PC's whole live state as a few characters (the same runs give the same hash on every PC). */
export function stateHash(runs: ReadonlyMap<string, Packed>): string {
  return hashOf(Object.fromEntries(runs)).slice(0, 6);
}
