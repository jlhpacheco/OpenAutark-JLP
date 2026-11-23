// How good this PC's connection to each device is now (Fest round 22.11.2026, G – owner: tell the person when a connection
// is slow, and later let a call take its audio from the phone when the PC link is bad), measured from pings that run
// anyway and kept in memory only:
//  - a page's socket (a phone, a browser, the iPhone tunnel): the keepalive's own ws ping → pong every 15 s
//    (http/keepalive.ts; http/ws.ts names the socket's device from its Hello);
//  - a linked PC: the mesh's `ping` (devices/mesh.ts) – it crosses every route a PC link takes (a direct socket, WebRTC,
//    the meeting server's tunnel; the keepalive sees only direct sockets, and a dialed one's device not at all) and its
//    answer's `at` gives the clock offset, NTP-style: at − (sent + received) / 2, from the sample with the smallest round
//    trip. pingLink times it: at link-up and each catch-up round (devices/sync/service.ts) and in devices.list.
// The round trip is the median of the last WINDOW samples (one stall of either side does not move it); a device whose
// newest sample is older than LINK_STALE_MS has no figure. linkQuality(deviceId) is the one function later users read.
// Owns: the samples, linkQuality() and pingLink's timing. Never: stores anything, or sends more than the one ping asked.

import type { DeviceService } from '../contracts.ts';
import { LINK_STALE_MS, SLOW_LINK_MS, type LinkQuality } from '../../shared/model/devices.ts';

/** Samples kept per device. */
export const WINDOW = 5;

interface Sample { ms: number; at: number }
interface ClockSample extends Sample { offsetMs: number }

const rounds = new Map<string, Sample[]>();
const clocks = new Map<string, ClockSample[]>();

function keep<T>(map: Map<string, T[]>, deviceId: string, sample: T): void {
  const list = map.get(deviceId) ?? [];
  list.push(sample);
  if (list.length > WINDOW) list.shift();
  map.set(deviceId, list);
}

/** One round trip to `deviceId` that ended at `at`. */
export function noteRoundTrip(deviceId: string, ms: number, at: number): void {
  if (!deviceId || !Number.isFinite(ms) || ms < 0) return;
  keep(rounds, deviceId, { ms, at });
}

/** One mesh ping to a linked PC: sent and received on this PC's clock, `answerAt` on the other's. */
export function noteClock(deviceId: string, sentAt: number, answerAt: unknown, receivedAt: number): void {
  const ms = receivedAt - sentAt;
  noteRoundTrip(deviceId, ms, receivedAt);
  if (typeof answerAt === 'number' && Number.isFinite(answerAt) && ms >= 0) keep(clocks, deviceId, { ms, at: receivedAt, offsetMs: answerAt - (sentAt + receivedAt) / 2 });
}

/** This PC's connection to `deviceId` now; undefined while unmeasured or stale. */
export function linkQuality(deviceId: string, now = Date.now()): LinkQuality | undefined {
  const fresh = (rounds.get(deviceId) ?? []).filter((sample) => now - sample.at <= LINK_STALE_MS);
  if (!fresh.length) return undefined;
  const sorted = fresh.map((sample) => sample.ms).sort((a, b) => a - b);
  const rttMs = Math.round(sorted[Math.floor((sorted.length - 1) / 2)]);
  const clock = (clocks.get(deviceId) ?? []).filter((sample) => now - sample.at <= LINK_STALE_MS).sort((a, b) => a.ms - b.ms)[0];
  return { rttMs, ...(rttMs >= SLOW_LINK_MS ? { slow: true as const } : {}), ...(clock ? { offsetMs: Math.round(clock.offsetMs) } : {}), at: fresh[fresh.length - 1].at };
}

/** `device` with its connection now (`link`), as Settings › Devices and devices.list show it. */
export function withLink<T extends { id: string }>(device: T, now = Date.now()): T & { link?: LinkQuality } {
  const link = linkQuality(device.id, now);
  return link ? { ...device, link } : device;
}

/**
 * Pings a linked PC once and resolves with its answer; when its link was up already, the round trip and the clock offset
 * are noted (a ping that had to dial first would count the dial).
 */
export async function pingLink(devices: Pick<DeviceService, 'call' | 'online'>, deviceId: string, options: { signal?: AbortSignal; timeoutMs?: number; now?: () => number } = {}): Promise<unknown> {
  const now = options.now ?? Date.now;
  const live = devices.online(deviceId);
  const sentAt = now();
  const answer = await devices.call(deviceId, 'ping', null, options.signal, options.timeoutMs);
  if (live) noteClock(deviceId, sentAt, (answer as { at?: unknown } | null)?.at, now());
  return answer;
}
