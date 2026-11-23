// Composition of calls (compose/services.ts calls createCalls once the accounts, catalog and chats exist): the call rows
// (call-log.ts – one value per call in its chat), the realtime sessions over `ws` (realtime/session.ts), the call voice as
// one kept conversation per call on the helper lane (talker.ts with decision/engine-runner.ts createChatOpener; the end of
// a call reaches it through CallLog.onEnd), an agent's rings (ring.ts, B-081) and the lookups the RPC handlers, the
// chat.call tool and the context fold use (callLogOf, realtimeOf, talkerOf, ringsOf, inLiveCall); Team-Call 21.11.2026: the
// mesh method between people's PCs (call-peer.ts). A call otherwise runs on the device (shared/voice/conversation.ts).
// Shutdown: stopCalls (compose/lifecycle.ts); start-up: endCallsLeftOpen (main.ts reconciliation, after the sync listens).
// Owns: that wiring. Never: provider protocol.

import WebSocket from 'ws';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import { createChatOpener, type ChatOpener } from '../decision/engine-runner.ts';
import type { PushFetch } from '../pwa/push.ts';
import { CallLog } from './call-log.ts';
import { registerCallPeer } from './call-peer.ts';
import type { EngineSocket, SocketFactory } from './realtime/engine.ts';
import { RealtimeCalls, type CallTimers } from './realtime/session.ts';
import { Rings } from './ring.ts';
import { CallTalker } from './talker.ts';

const timers: CallTimers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A ws client socket to the provider (no redirects, bounded frames). */
export const wsConnect: SocketFactory = (url, headers) => new WebSocket(url, { headers, followRedirects: false, maxPayload: 4 * 1024 * 1024 }) as unknown as EngineSocket;

const logs = new WeakMap<object, CallLog>();
const realtimes = new WeakMap<object, RealtimeCalls>();
const talkers = new WeakMap<object, CallTalker>();
const rings = new WeakMap<object, Rings>();

export function createCalls(services: RuntimeServices, options: { connect?: SocketFactory; timers?: CallTimers; voice?: ChatOpener; fetch?: PushFetch } = {}): { log: CallLog; realtime: RealtimeCalls; talker: CallTalker; rings: Rings } {
  const log = new CallLog(() => services);
  const realtime = new RealtimeCalls({ services: () => services, log, connect: options.connect ?? wsConnect, timers: options.timers ?? timers });
  const talker = new CallTalker({ services: () => services, voice: options.voice ?? createChatOpener(services), calls: log });
  log.onStart((conversationId, callId) => talker.started(conversationId, callId)); // the voice's session opens with the call (decision 7.1)
  log.onEnd((conversationId, callId, handOver) => talker.ended(conversationId, callId, handOver)); // the voice's last act (decision 8.4)
  registerCallPeer(services); // Team-Call: join notes and WebRTC signals between people's PCs
  const ring = new Rings({ services: () => services, log, timers: options.timers ?? timers, fetch: options.fetch });
  logs.set(services, log);
  realtimes.set(services, realtime);
  talkers.set(services, talker);
  rings.set(services, ring);
  return { log, realtime, talker, rings: ring };
}

/** The runtime's call rows, or undefined (tests, headless setups). */
export const callLogOf = (services: object): CallLog | undefined => logs.get(services);

/** The runtime's call talker, or undefined (tests, headless setups). */
export const talkerOf = (services: object): CallTalker | undefined => talkers.get(services);

/** B-081: the runtime's rings (chat.call, calls.decline/live), or undefined (tests, headless setups). */
export const ringsOf = (services: object): Rings | undefined => rings.get(services);

/**
 * KI-Runde 17.11.2026: whether this agent is in a call running on this PC right now (CallLog.inCall). The context fold
 * starts no fold turn while it is (agents/context-fold.ts); without a call log there is no call either.
 */
export const inLiveCall = (services: object, agentId: string): boolean => logs.get(services)?.inCall(agentId) ?? false;

/** Start-up reconciliation: the calls this PC left open end now, so their end travels to the other PCs. Returns how many. */
export function endCallsLeftOpen(services: object): number {
  return logs.get(services)?.endLeftOpen() ?? 0;
}

export function realtimeOf(services: object): RealtimeCalls {
  const realtime = realtimes.get(services);
  if (!realtime) throw new WorkforceError('unavailable', 'Realtime voice is not available in this runtime.');
  return realtime;
}

/** Shutdown: realtime sessions close, the talker's unanswered lines go to the agent, open calls end at the next start. */
export function stopCalls(services: object): void {
  realtimes.get(services)?.stop();
  rings.get(services)?.stop();
  rings.delete(services);
  logs.get(services)?.stop();
  logs.delete(services);
  realtimes.delete(services);
  talkers.get(services)?.stop();
  talkers.delete(services);
}
