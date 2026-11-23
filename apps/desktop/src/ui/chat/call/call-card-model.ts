// B-085: the words of a call's two cards, as plain functions. The floating card (CallCard.tsx) while this device talks:
// status "Connecting…", "Listening · 1:23", "Speaking · 1:23", "Working… · 1:23", "On hold · 1:23" and the newest line of the call as its
// caption. The call's row in the chat (CallTranscript.tsx): "Call from Ava" (B-081 ring) or "Call with Ava and Ben"
// (the agents of the call and those heard in it, else the chat's name), "21:24 · 3 lines", and on the right "Ringing",
// "Missed", "Declined", "Running" or how long it ran. Owner 19.11.2026: a running call with devices joined beside its holder
// names them after its lines ("21:24 · 3 lines · Pixel and laptop").
// Owns: these words. Never: reads stores, the clock or the DOM (callers pass `now` and names).

import { callDeviceNames, callLength, callRecord, callState, type CallLine, type CallRecord } from '../../../shared/model/call.ts';
import type { Message } from '../../../shared/model/chat.ts';
import { listTime, plainPreview, time } from '../../lib/format.ts';

export type CallPhase = 'connecting' | 'listening' | 'speaking' | 'working' | 'held' | 'waiting';

const PHASE_TEXT: Record<CallPhase, string> = {
  connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking', working: 'Working…', held: 'On hold', waiting: 'Reply waiting',
};
const CAPTION_MAX = 160;

/**
 * Where this device's call stands. `realtime`: the realtime session's phase (undefined: the voice conversation talks);
 * `voice`: the voice conversation's phase as the status line names it (shell-state.ts voicePhase: "on hold" while
 * another conversation listens, "reply waiting"); `playing`: realtime answer audio still plays.
 */
export function phaseOf(realtime: 'connecting' | 'listening' | 'speaking' | undefined, voice: string | undefined, playing = false): CallPhase {
  if (realtime) return realtime !== 'connecting' && playing ? 'speaking' : realtime;
  if (voice === 'listening' || voice === 'speaking') return voice;
  if (voice === 'on hold') return 'held';
  if (voice === 'reply waiting') return 'waiting';
  return voice === 'transcribing' || voice === 'responding' ? 'working' : 'connecting';
}

/** "Listening · 1:23"; "Connecting…" alone, and a phase alone while the call's start is not known yet. */
export function statusLine(phase: CallPhase, since: number | undefined, now: number): string {
  if (phase === 'connecting' || since === undefined) return PHASE_TEXT[phase];
  return `${PHASE_TEXT[phase]} · ${callLength(now - since)}`;
}

/** The chat's call that runs now (its newest running call row), else undefined. */
export function runningCall(messages: readonly Pick<Message, 'kind' | 'meta'>[], now: number): CallRecord | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const call = callRecord(messages[index]);
    if (call && callState(call, now) === 'running') return call;
  }
  return undefined;
}

/** When the call's talk began: the answer of a ring, else its start. */
export function callSince(call: Pick<CallRecord, 'startedAt' | 'ring'>): number {
  return call.ring?.answeredAt ?? call.startedAt;
}

/** The call's newest line as a caption: who said it, which side, and its plain words (the end kept when long). */
export function captionOf(line: CallLine | undefined): { name: string; side: 'agent' | 'person'; text: string } | undefined {
  if (!line) return undefined;
  const text = plainPreview(line.text, Number.MAX_SAFE_INTEGER);
  if (!text) return undefined;
  return { name: line.name, side: line.from.startsWith('agent:') ? 'agent' : 'person', text: text.length > CAPTION_MAX ? `…${text.slice(-(CAPTION_MAX - 1))}` : text };
}

/** "Ava", "Ava and Ben", "Ava, Ben and 2 more". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** "Call from Ava" (an agent rang), "Call with Ava" (the agents of the call and those heard in it, else the chat), "Call". */
export function callHeading(call: Pick<CallRecord, 'ring' | 'agents' | 'lines'>, nameOf: (agentId: string) => string | undefined, chatName?: string): string {
  if (call.ring) return `Call from ${nameOf(call.ring.by) ?? 'an agent'}`;
  const names = new Set<string>();
  for (const id of call.agents ?? []) { const name = nameOf(id); if (name) names.add(name); }
  for (const line of call.lines) if (line.from.startsWith('agent:') && line.name) names.add(line.name);
  const who = names.size ? nameList([...names]) : chatName;
  return who ? `Call with ${who}` : 'Call';
}

/** "21:24 · 3 lines"; an older call "Yesterday, 21:24 · Nothing said"; a running one with joined devices "… · Pixel and laptop". */
export function callMeta(call: Pick<CallRecord, 'startedAt' | 'lines'> & Partial<Pick<CallRecord, 'name' | 'joined' | 'endedAt'>>, now: number): string {
  const clock = time(call.startedAt);
  const day = listTime(call.startedAt, now);
  const count = call.lines.length;
  const said = count === 0 ? 'Nothing said' : count === 1 ? '1 line' : `${count} lines`;
  const devices = call.joined?.length && call.endedAt === undefined ? ` · ${callDeviceNames({ name: call.name ?? '', joined: call.joined })}` : '';
  return `${day === clock ? clock : `${day}, ${clock}`} · ${said}${devices}`;
}

/** The right end of the row: "Ringing", "Missed", "Declined", "Running", or how long it ran ("4:42"). */
export function callEnd(call: Pick<CallRecord, 'startedAt' | 'endedAt' | 'ring'>, now: number): string {
  const state = callState(call, now);
  if (state === 'ended') return callLength((call.endedAt ?? now) - callSince(call));
  return state[0].toUpperCase() + state.slice(1);
}
