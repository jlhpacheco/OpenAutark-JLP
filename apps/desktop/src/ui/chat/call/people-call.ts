// Team-Call 21.11.2026: the browser side of people-audio.ts, run from the shell (watchPeopleAudio, once per app start) – for
// every running call this window talks in (calls.live + the window's voice/realtime sessions), whatever view is open, it asks the runtime whom it hears (calls.peers, again whenever the call's devices change), hands the
// event calls.signal in and sends with calls.signal. The peer connection is Chromium's own, with the settings' STUN
// servers (settings.devices.stun; none while the direct way is off – then only the same network or VPN works); the
// microphone is lib/microphone.ts (echo cancellation, noise suppression, auto gain, the desktop's media gate armed), and
// each peer plays in its own audio element. Mute follows mute.ts.
// The first read of the peers is right at the start; refresh() follows every change of the call's devices.
// Owns: that glue and its lifetime. Never: negotiation (people-audio.ts) or who is in the call (the runtime).

import { effect, type ReadonlySignal } from '@preact/signals';
import type { LiveCall } from '../../../shared/model/call.ts';
import { DEFAULT_STUN } from '../../../shared/model/relay.ts';
import { openMicrophone, type Microphone } from '../../lib/microphone.ts';
import { rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { settings } from '../../lib/store.ts';
import { callMuted } from './mute.ts';
import { PeopleAudio, type PeerLike } from './people-audio.ts';

function iceServers(): RTCIceServer[] {
  const devices = settings.peek()?.devices;
  const stun = devices?.rtc === false ? [] : devices?.stun ?? DEFAULT_STUN;
  return stun.length ? [{ urls: [...stun] }] : [];
}

/** This window's people audio in a call; refresh() reads its peers again, stop() leaves. */
function startPeopleAudio(conversationId: string, callId: string): { refresh(): void; stop(): void } {
  const players = new Map<string, HTMLAudioElement>();
  let mic: Microphone | undefined;
  const audio = new PeopleAudio({
    peer: () => new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' }) as unknown as PeerLike,
    mic: async () => { mic = await openMicrophone(); return mic.stream; },
    play: (peerId, stream) => {
      const player = players.get(peerId) ?? new Audio();
      players.set(peerId, player);
      player.autoplay = true;
      player.srcObject = stream;
      if (stream) void player.play().catch(() => undefined); else players.delete(peerId);
    },
    send: (to, data) => rpc.call('calls.signal', { conversationId, callId, to, data }).then((answer) => answer.sent, () => false),
  });
  const off = rpc.on('calls.signal', (event) => { if (event.callId === callId && event.conversationId === conversationId) audio.receive(event.from, event.data); });
  const unmute = effect(() => audio.setMuted(callMuted.value));
  const refresh = () => {
    if (!can('calls.peers')) return;
    rpc.call('calls.peers', { conversationId, callId }).then(({ me, peers }) => audio.update(me, peers), () => undefined);
  };
  const reopened = rpc.onOpen(refresh);
  refresh();
  return {
    refresh,
    stop: () => {
      off();
      unmute();
      reopened();
      audio.close();
      mic?.close();
      for (const player of players.values()) player.srcObject = null;
      players.clear();
    },
  };
}

/** Team-Call: the running calls this window talks in (voice conversation or realtime, in any chat – wherever the window shows), each with a key that changes when its devices change. */
export function peopleCalls(calls: readonly LiveCall[], talking: (conversationId: string) => boolean): Array<{ callId: string; conversationId: string; key: string }> {
  return calls.filter((call) => call.state === 'running' && talking(call.conversationId)).map((call) => ({ callId: call.callId, conversationId: call.conversationId, key: [call.holder ?? '', call.device ?? ''].join(' ') }));
}

const running = new Map<string, { key: string; people: { refresh(): void; stop(): void } }>();

/** Shell-level, once per app start (call-notices.ts registerCallNotices): people audio runs for every call this window talks in, whatever view is open; it stops when the window leaves that call. */
export function watchPeopleAudio(calls: ReadonlySignal<readonly LiveCall[]>, talking: (conversationId: string) => boolean): () => void {
  if (typeof RTCPeerConnection === 'undefined') return () => undefined;
  const off = effect(() => {
    const now = peopleCalls(calls.value, talking);
    for (const [callId, entry] of [...running]) if (!now.some((call) => call.callId === callId)) { running.delete(callId); entry.people.stop(); }
    for (const call of now) {
      const entry = running.get(call.callId);
      if (!entry) running.set(call.callId, { key: call.key, people: startPeopleAudio(call.conversationId, call.callId) });
      else if (entry.key !== call.key) { entry.key = call.key; entry.people.refresh(); }
    }
  });
  return () => { off(); for (const entry of running.values()) entry.people.stop(); running.clear(); };
}
