// Page code for test/native/hosted-rtc.test.mjs (F25 P3): the iPhone web app's own pairing and Connection (src/ui/hosted),
// bundled by the test with esbuild and run in real Chromium, reachable from the test as window.rtcTest. Besides the
// app's code it only reports: the way the page's streams take (Connection.via), how the last try ended, the status
// lines, and a WebSocket's opens and closes. The test's init script wraps RTCPeerConnection (window.__peers, __block).
// Owns: this bridge between the test and the page. Never: is part of the app.

import { Connection } from '../../../src/ui/hosted/connection.ts';
import { httpFetch } from '../../../src/ui/hosted/http.ts';
import { pairByRemoteId, Pairing } from '../../../src/ui/hosted/pair.ts';
import type { Saved } from '../../../src/ui/hosted/store.ts';
import { StreamSocket } from '../../../src/ui/hosted/ws.ts';

let saved: Saved | undefined;
let connection: Connection | undefined;
const statuses: string[] = [];
const socketLog: string[] = [];

const api = {
  code: '',
  async pair(relay: string, remoteId: string): Promise<string> {
    const paired = await pairByRemoteId({ relay, remoteId, name: 'iPhone', pairing: new Pairing(), code: (code) => { api.code = code; } });
    saved = { key: paired.key, deviceId: paired.deviceId, relay: paired.relay, token: paired.token, pcs: paired.pcs };
    return paired.deviceId;
  },
  /** A new Connection (a fresh page session: a new plan). */
  start(): void {
    connection?.stop();
    statuses.length = 0;
    connection = new Connection({ saved: saved!, status: (text) => statuses.push(text) });
    connection.start();
  },
  stop(): void { connection?.stop(); connection = undefined; },
  nudge(hiddenMs = 0): void { connection?.nudge(hiddenMs); },
  state() { return { via: connection?.via, last: connection?.lastRtc, statuses: [...statuses], sockets: [...socketLog] }; },
  /** GET `path` through the page's current way: its length, the way it took, the time. */
  async get(path: string) {
    const mux = await connection!.awaitMux(15_000);
    if (!mux) throw new Error('no channel');
    const via = connection!.via;
    const started = performance.now();
    const { head, body } = await httpFetch(mux, { method: 'GET', path });
    return { status: head.status, length: body.length, first: body[0], via, ms: Math.round(performance.now() - started) };
  },
  /** The PC UI's kind of socket (/ws through the streams), reopened after each close like rpc.ts does. */
  socket(): void {
    const open = () => {
      const ws = new StreamSocket((ms) => connection!.awaitMux(ms));
      ws.onopen = () => { socketLog.push(`open ${connection?.via}`); };
      ws.onclose = () => { socketLog.push('close'); setTimeout(open, 100); };
    };
    open();
  },
};

(window as unknown as { rtcTest: typeof api }).rtcTest = api;
