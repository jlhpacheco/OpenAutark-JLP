// An in-memory connected socket pair (Quests round 20.11.2026: moved here from src/runtime/devices/channel.ts – no app
// code uses it): what one side sends the other receives in the next microtask; a close closes both.
// Owns: this pair. Never: imported by src/.

import type { SocketLike } from '../../../src/runtime/devices/channel.ts';

/** Two connected sockets. */
export function socketPair(): [SocketLike, SocketLike] {
  type Side = { message: Array<(d: Buffer, t: boolean) => void>; close: Array<(code?: number) => void>; closed: boolean };
  const a: Side = { message: [], close: [], closed: false };
  const b: Side = { message: [], close: [], closed: false };
  const make = (self: Side, other: Side): SocketLike => ({
    send(data) {
      if (self.closed) return;
      const isText = typeof data === 'string';
      const copy = Buffer.from(data);
      queueMicrotask(() => { if (!other.closed) other.message.forEach((l) => l(copy, isText)); });
    },
    close(code) {
      if (self.closed) return;
      self.closed = true;
      other.closed = true;
      queueMicrotask(() => { self.close.forEach((l) => l(code)); other.close.forEach((l) => l(code)); });
    },
    onMessage: (l) => { self.message.push(l); },
    onClose: (l) => { self.close.push(l); },
  });
  return [make(a, b), make(b, a)];
}
