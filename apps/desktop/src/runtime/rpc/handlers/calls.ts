// RPC handlers: calls (runtime/calls). Every chat-capable client – this PC's window and main ('owner'), paired phones
// and browsers with 'chat' – starts and ends its call in a chat (calls.start/end: the call's row, call-log.ts), opens a
// realtime voice session there, streams audio into it, pulls its answers and closes it. The device is the connection's
// (key 'pc' for the owner, else the paired device id, named from the devices list), never a client parameter; its
// connection closing ends its call and session. Also registers the people's speech variants (F-52, people/rpc-voice.ts:
// their dictation and voice conversation).
// B-081: calls.start / calls.realtimeOpen with a callId take that call – answer an agent's ring (the opening line comes
// back as `say`) or take it over from another device; calls.decline says no to a ring; calls.live lists ringing and
// running calls (calls/ring.ts). calls.turn writes one log line per call turn the device measured: numbers, the two ways
// it names (heard by, answered by) and the answer's model id – nothing a page could put words of the call into.
// Owner 19.11.2026: calls.start with a callId and join: true joins that running call beside the devices in it (the Join
// beside Take over); every answer says how the call names this device (holder) and whether it is in beside the holder
// (joined). calls.end makes only this device leave; the call ends with the last one (call-log.ts).
// Team-Call 21.11.2026: calls.peers names the other people's PC windows this window talks to in its call; calls.signal
// sends one WebRTC signal to one of them (calls/call-peer.ts).
// Owns: param checks and the device identity. Never: provider protocol or audio.

import { WorkforceError } from '../../../shared/errors.ts';
import { callHolder, callSignal, type CallDevice } from '../../../shared/model/call.ts';
import { callPeers, sendSignal } from '../../calls/call-peer.ts';
import { callLogOf, realtimeOf, ringsOf } from '../../calls/wiring.ts';
import { registerPersonVoice } from '../../people/rpc-voice.ts';
import { callerDeviceName } from '../device-name.ts';
import { bad, id, input, num, onlyKeys, oneOf, optBool, optNum, optText, text, type Obj } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;
/** Who heard a call turn: the `HeardBy` ways voice.transcribe answers with, plus 'unknown' for a take that carried none (ui/chat/call/turn-meter.ts). */
const HEARD_BY = ['plan', 'local', 'service', 'listener', 'unknown'] as const;
/** The model of a call turn is the id the runtime wrote into the answer's meta, so the log line holds no words of the call. */
const MODEL_ID = /^[A-Za-z0-9._:/-]+$/;

function modelId(o: Obj): string | undefined {
  const value = optText(o, 'model', { max: 80 });
  if (value !== undefined && !MODEL_ID.test(value)) bad('model', 'a model id');
  return value;
}

/** The calling device: this PC ('pc') or the paired phone/browser. */
export function callDevice(ctx: Pick<HandlerContext, 'scope' | 'services'>): CallDevice {
  if (ctx.scope.kind === 'device') return { key: ctx.scope.deviceId, name: callerDeviceName(ctx) ?? 'a phone' };
  if (ctx.scope.kind !== 'owner') throw new WorkforceError('forbidden', 'Realtime voice is not open to this connection.');
  let name = '';
  try { name = ctx.services.devices.self().name?.trim() ?? ''; } catch { name = ''; }
  return { key: 'pc', name: name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 60) || 'This PC' };
}

function callLog(ctx: Pick<HandlerContext, 'services'>) {
  const log = callLogOf(ctx.services);
  if (!log) throw new WorkforceError('unavailable', 'Calls are not available in this runtime.');
  return log;
}

function rings(ctx: Pick<HandlerContext, 'services'>) {
  const found = ringsOf(ctx.services);
  if (!found) throw new WorkforceError('unavailable', 'Calls are not available in this runtime.');
  return found;
}

export function register(table: HandlerTable): void {
  table.add('calls.start', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'callId', 'join']);
    const conversationId = id(o, 'conversationId');
    const take = optText(o, 'callId', { max: 64 });
    const join = optBool(o, 'join');
    if (join && !take) bad('join', 'join: true only together with a callId');
    const log = callLog(ctx);
    const device = callDevice(ctx);
    const answer = (callId: string, say?: string) => {
      const holder = log.who(device.key);
      const record = log.record(conversationId, callId);
      return { callId, holder, ...(say ? { say } : {}), ...(record && callHolder(record) !== holder ? { joined: true as const } : {}) };
    };
    if (!take) return answer(log.start(conversationId, device, ctx.signal));
    if (join) { log.joinDevice(conversationId, take, device, ctx.signal); return answer(take); }
    const taken = log.take(conversationId, take, device, ctx.signal);
    const opening = taken.answered ? ringsOf(ctx.services)?.answered(conversationId, taken.callId) : undefined;
    return answer(taken.callId, opening?.say);
  }, CHAT);
  table.add('calls.end', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['callId']);
    callLog(ctx).end(text(o, 'callId', { max: 64 }), callDevice(ctx).key);
    return { ok: true };
  }, CHAT);
  table.add('calls.decline', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['callId']);
    rings(ctx).decline(text(o, 'callId', { max: 64 }), callDevice(ctx));
    return { ok: true };
  }, CHAT);
  table.add('calls.live', (params, ctx) => {
    onlyKeys(input(params), []);
    callDevice(ctx); // the owner's PCs and paired devices; a person's calls come after B-080
    return { calls: ringsOf(ctx.services)?.live() ?? [] };
  }, CHAT);
  table.add('calls.turn', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['callId', 'heardMs', 'answerMs', 'speakMs', 'heardBy', 'answeredBy', 'model']);
    const ms = (key: string) => num(o, key, { min: 0, max: 3_600_000 });
    ctx.services.log.info('call turn', {
      callId: text(o, 'callId', { max: 64 }), device: callDevice(ctx).key,
      heardMs: ms('heardMs'), answerMs: ms('answerMs'), speakMs: ms('speakMs'),
      heardBy: oneOf(o, 'heardBy', HEARD_BY), answeredBy: oneOf(o, 'answeredBy', ['talker', 'turn', 'program']), model: modelId(o),
    });
    return { ok: true };
  }, CHAT);
  table.add('calls.realtimeOpen', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'callId']);
    return realtimeOf(ctx.services).open(id(o, 'conversationId'), callDevice(ctx), ctx.signal, optText(o, 'callId', { max: 64 }));
  }, CHAT);
  table.add('calls.realtimeSend', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['sessionId', 'audio']);
    realtimeOf(ctx.services).send(text(o, 'sessionId', { max: 64 }), callDevice(ctx).key, text(o, 'audio', { max: 40_000, allowEmpty: true }));
    return { ok: true };
  }, CHAT);
  table.add('calls.realtimePull', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['sessionId', 'after']);
    return realtimeOf(ctx.services).pull(text(o, 'sessionId', { max: 64 }), callDevice(ctx).key, optNum(o, 'after', { min: 0 }) ?? 0, ctx.signal);
  }, CHAT);
  table.add('calls.realtimeInterrupt', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['sessionId', 'playedMs']);
    realtimeOf(ctx.services).interrupt(text(o, 'sessionId', { max: 64 }), callDevice(ctx).key, optNum(o, 'playedMs', { min: 0, max: 3_600_000 }));
    return { ok: true };
  }, CHAT);
  table.add('calls.realtimeClose', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['sessionId']);
    realtimeOf(ctx.services).close(text(o, 'sessionId', { max: 64 }), callDevice(ctx).key);
    return { ok: true };
  }, CHAT);
  // Team-Call 21.11.2026: this PC window's peers in its call and its WebRTC signals to them (calls/call-peer.ts)
  table.add('calls.peers', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'callId']);
    return callPeers(ctx.services, id(o, 'conversationId'), text(o, 'callId', { max: 64 }), callDevice(ctx).key);
  }, CHAT);
  table.add('calls.signal', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'callId', 'to', 'data']);
    const data = callSignal(o.data);
    if (!data) bad('data', 'a call signal (hello, bye, or an offer/answer with its SDP)');
    return { sent: await sendSignal(ctx.services, id(o, 'conversationId'), text(o, 'callId', { max: 64 }), callDevice(ctx).key, text(o, 'to', { max: 200 }), data) };
  }, CHAT);
  registerPersonVoice(table); // F-52: people's utterance upload and transcription
}
